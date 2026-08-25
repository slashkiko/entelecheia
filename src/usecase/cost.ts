import { z } from "zod";
import type { LlmCall } from "../domain/llm-call.js";
import type { Run } from "../domain/run.js";
import type { Store } from "../store/port.js";

/**
 * 生ログに残る、単価が異なる4種類のトークン。
 *
 * provider のフィールド名をそのまま外へ出すと、Codex の
 * `cached_input_tokens` と Claude の `cache_read_input_tokens` が別の価格欄に
 * 分かれてしまう。価格表と出力は design.md §7 の4分類へ揃える。
 */
const tokenCategoriesSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export type TokenCategories = z.infer<typeof tokenCategoriesSchema>;

const categoryPricesSchema = z.strictObject({
  input_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative(),
  cache_read_input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
});

/**
 * caller が渡す価格表。provider や model の価格は ent のコードに持たない。
 * 単位もファイル自身に書かせ、1 token と 100万 tokens の取り違えを止める。
 */
export const costPriceFileSchema = z.strictObject({
  unit: z.literal("usd_per_million_tokens"),
  prices: categoryPricesSchema,
});

export type CostPriceFile = z.infer<typeof costPriceFileSchema>;

export interface CostPayload {
  goal_id: string;
  token_usage: TokenCategories;
  charged_token_usage: TokenCategories;
  metered_usd: number;
  charged_usd: number;
  oauth_metered_usd: number;
  sources: {
    runs: number;
    llm_calls: number;
  };
}

export interface CostPorts {
  /** 生ログを読む Adapter。ユースケースから filesystem を直接選ばない */
  readLog: (path: string) => string;
}

const ZERO_TOKENS: TokenCategories = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};

/** JSON の構文と価格表の形を1つの境界で検証する。 */
export function parseCostPriceFile(contents: string): CostPriceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse the price file as JSON: ${detail}`);
  }
  return costPriceFileSchema.parse(parsed);
}

/** 未登録・未実行の Goal も、価格表を受け取ったうえで数値の 0 を返す。 */
export function emptyCostPayload(goalId: string): CostPayload {
  return {
    goal_id: goalId,
    token_usage: { ...ZERO_TOKENS },
    charged_token_usage: { ...ZERO_TOKENS },
    metered_usd: 0,
    charged_usd: 0,
    oauth_metered_usd: 0,
    sources: { runs: 0, llm_calls: 0 },
  };
}

/**
 * 1 Goal に属する Actor Run と DECIDE LlmCall を、生ログから同じ価格表で集計する。
 *
 * `Run.tokens` / `LlmCall.tokens` は規模の指標として残し続ける。ここではその値を
 * 金額計算に流用せず、生ログから得た4分類の合計との照合に使う。食い違えば、
 * 分からない分類を推測して金額を出さずに止める。
 */
export function costPayload(
  goalId: string,
  store: Store,
  priceFile: CostPriceFile,
  ports: CostPorts,
): CostPayload {
  const usage = { ...ZERO_TOKENS };
  const chargedUsage = { ...ZERO_TOKENS };
  const oauthUsage = { ...ZERO_TOKENS };
  const runs = store.listRuns(goalId);
  const calls = store.listLlmCalls(goalId);

  for (const run of runs) {
    const extracted = usageForRun(run, ports);
    addTokens(usage, extracted.tokens);
    if (extracted.oauth) {
      addTokens(oauthUsage, extracted.tokens);
    } else {
      addTokens(chargedUsage, extracted.tokens);
    }
  }

  for (const call of calls) {
    const extracted = usageForLlmCall(call, ports);
    addTokens(usage, extracted.tokens);
    if (extracted.oauth) {
      addTokens(oauthUsage, extracted.tokens);
    } else {
      addTokens(chargedUsage, extracted.tokens);
    }
  }

  const meteredUsd = priceOf(usage, priceFile.prices);
  const chargedUsd = priceOf(chargedUsage, priceFile.prices);
  return {
    goal_id: goalId,
    token_usage: usage,
    charged_token_usage: chargedUsage,
    metered_usd: meteredUsd,
    charged_usd: chargedUsd,
    oauth_metered_usd: priceOf(oauthUsage, priceFile.prices),
    sources: { runs: runs.length, llm_calls: calls.length },
  };
}

interface ExtractedUsage {
  tokens: TokenCategories;
  /** Claude Max OAuth。仮想 metered cost には入るが charged USD には入れない */
  oauth: boolean;
}

function usageForRun(run: Run, ports: CostPorts): ExtractedUsage {
  if (run.logRef === null) {
    if ((run.tokens ?? 0) === 0) {
      return { tokens: { ...ZERO_TOKENS }, oauth: false };
    }
    throw new Error(`Run ${run.id} recorded ${String(run.tokens)} tokens but has no raw-log path`);
  }
  return usageInLog(`Run ${run.id}`, run.logRef, run.tokens, ports);
}

function usageForLlmCall(call: LlmCall, ports: CostPorts): ExtractedUsage {
  return usageInLog(`LlmCall ${call.purpose} at ${call.calledAt}`, call.logRef, call.tokens, ports);
}

function usageInLog(
  source: string,
  logRef: string,
  recordedTokens: number | null,
  ports: CostPorts,
): ExtractedUsage {
  let contents: string;
  try {
    contents = ports.readLog(logRef);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the raw log for ${source} (${logRef}): ${detail}`);
  }

  const events = jsonLines(contents);
  const claude = claudeUsage(events);
  const codex = codexUsage(events);
  if (claude !== null && codex !== null) {
    throw new Error(`The raw log for ${source} mixes Claude and Codex usage events`);
  }
  const extracted = claude ?? codex ?? { tokens: { ...ZERO_TOKENS }, oauth: false };
  const extractedTotal = totalTokens(extracted.tokens);
  if (recordedTokens !== null && extractedTotal !== recordedTokens) {
    throw new Error(
      `The raw-log token total for ${source} is ${String(extractedTotal)}, ` +
        `but the recorded total is ${String(recordedTokens)}`,
    );
  }
  return extracted;
}

const claudeInitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  apiKeySource: z.string().optional(),
});

const claudeResultSchema = z.object({
  type: z.literal("result"),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Claude は最後の result が Run.tokens / LlmCall.tokens の出どころになる。 */
function claudeUsage(events: readonly unknown[]): ExtractedUsage | null {
  let apiKeySource: string | null = null;
  let tokens: TokenCategories | null = null;
  for (const event of events) {
    const init = claudeInitSchema.safeParse(event);
    if (init.success) {
      apiKeySource = init.data.apiKeySource ?? null;
    }
    const result = claudeResultSchema.safeParse(event);
    if (result.success && result.data.usage !== undefined) {
      tokens = {
        input_tokens: result.data.usage.input_tokens ?? 0,
        cache_creation_input_tokens: result.data.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: result.data.usage.cache_read_input_tokens ?? 0,
        output_tokens: result.data.usage.output_tokens ?? 0,
      };
    }
  }
  if (tokens === null) {
    return null;
  }
  return { tokens, oauth: apiKeySource === "oauth" };
}

const codexTurnSchema = z.object({
  type: z.literal("turn.completed"),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      cached_input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/**
 * Codex の cached_input_tokens は input_tokens の内数。通常入力から差し引いて
 * Claude の cache_read 分類へ移す。output の reasoning 分も内数なので足さない。
 */
function codexUsage(events: readonly unknown[]): ExtractedUsage | null {
  let found = false;
  const tokens = { ...ZERO_TOKENS };
  for (const event of events) {
    const turn = codexTurnSchema.safeParse(event);
    if (!turn.success) {
      continue;
    }
    found = true;
    const input = turn.data.usage?.input_tokens ?? 0;
    const cached = turn.data.usage?.cached_input_tokens ?? 0;
    if (cached > input) {
      throw new Error(
        `Codex cached_input_tokens (${String(cached)}) exceeds input_tokens (${String(input)})`,
      );
    }
    tokens.input_tokens += input - cached;
    tokens.cache_read_input_tokens += cached;
    tokens.output_tokens += turn.data.usage?.output_tokens ?? 0;
  }
  return found ? { tokens, oauth: false } : null;
}

/** 追記途中で切れた行や diagnostics の非 JSON 行は、確定済みの行を巻き添えにしない。 */
function jsonLines(contents: string): unknown[] {
  const events: unknown[] = [];
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // 生ログは追記される。末尾の未完行があっても、それ以前の確定行は読める。
    }
  }
  return events;
}

function addTokens(target: TokenCategories, addition: TokenCategories): void {
  target.input_tokens += addition.input_tokens;
  target.cache_creation_input_tokens += addition.cache_creation_input_tokens;
  target.cache_read_input_tokens += addition.cache_read_input_tokens;
  target.output_tokens += addition.output_tokens;
}

function totalTokens(tokens: TokenCategories): number {
  return (
    tokens.input_tokens +
    tokens.cache_creation_input_tokens +
    tokens.cache_read_input_tokens +
    tokens.output_tokens
  );
}

/**
 * 金額として意味のある最小の桁より十分下。ここから先は二進小数の表現誤差しかない。
 *
 * 価格表の単位は USD / 100万 tokens なので、意味を持つ最小の量はマイクロドル
 * （1e-6）になる。その4桁下を残して丸める。
 */
const USD_PRECISION = 10;

/**
 * 4分類を単価で掛けて USD にする。
 *
 * 最後に丸めるのは、**宣言した単価から出るはずの額をそのまま出すため。**
 * 実データで `cache_read` の単価 0.1 を 6,304,256 tokens に掛けたところ、
 * 期待する 1.0519446 ではなく 1.0519446000000001 が出た。0.1 も 1e-6 も二進では
 * 割り切れないので、掛けて足して割る間に表現誤差が残る。
 *
 * 残った桁は金額ではなく浮動小数の出方なので、意味のある桁より十分下で丸めて
 * 落とす。ここを丸めずに出すと、期待額と突き合わせる側が桁の揺れに追従する
 * 羽目になり、「宣言した単価どおりか」を見られなくなる。
 */
function priceOf(tokens: TokenCategories, prices: CostPriceFile["prices"]): number {
  const perMillion =
    tokens.input_tokens * prices.input_tokens +
    tokens.cache_creation_input_tokens * prices.cache_creation_input_tokens +
    tokens.cache_read_input_tokens * prices.cache_read_input_tokens +
    tokens.output_tokens * prices.output_tokens;
  const scale = 10 ** USD_PRECISION;
  // `toFixed` ではなく丸めてから戻すのは、数値のまま返すため。JSON に文字列で
  // 出すと、読む側が数値へ戻す前提を1つ増やすことになる。
  return Math.round((perMillion / 1_000_000) * scale) / scale;
}
