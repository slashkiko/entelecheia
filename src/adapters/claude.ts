import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ActorPort, ActorResult } from "../act/index.js";
import type { LlmPort } from "../decide/index.js";
import type { ApprovalGate } from "../domain/goal.js";
import type { LlmCall } from "../domain/llm-call.js";
import { PortError } from "../domain/port-error.js";

/**
 * Claude Code 向けの ActorPort と LlmPort。Claude Agent SDK の query() を使う。
 *
 * design.md §3.5 のとおり ASSESS も DECIDE も Actor 層経由に寄せ、依存を1系統にする。
 * Agent SDK は Claude Code の OAuth をそのまま使うので、Claude Max の枠内で動く。
 */

/**
 * query() の口。テストから注入できるように、こちらで型を切り直してある。
 *
 * 戻り値を `AsyncIterable<unknown>` にしてあるのは、SDK のメッセージ型が広く、
 * テストが本物の型を組み立てるコストに見合わないため。読む項目は Zod で絞る。
 * 実装側は SDK の `query` をそのまま渡せる。
 */
export type AgentQuery = (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;

export interface ClaudeOptions {
  query: AgentQuery;
  /** 生ログの置き場所（design.md §4.6） */
  runsDir: string;
  /** ログをファイルに書く口。テストから差し替える */
  writeLog?: (path: string, contents: string) => Promise<void>;
  /**
   * 使うモデル。省略すると Claude Code の既定に従う。
   *
   * 起動のたびに使用量を消費するので、controller 側から選べる口が要る（design.md §7）。
   * 安い試走と本番の実行で同じコードを使い分けられるようにしてある。
   */
  model?: string | undefined;
  /** 思考の深さ。省略すると Claude Code の既定に従う */
  effort?: EffortLevel | undefined;
  /** テスト時に固定するための時刻ソース。省略すると実時計を使う */
  now?: (() => Date) | undefined;
  /**
   * LlmPort を1回呼ぶたびに通知する。トークンと生ログのパスを controller に渡す。
   *
   * DECIDE は Actor を起動しないので Run が作られず、design.md §7 が求める
   * トークンの記録先が無い。呼んだ直後に通知して、その場で永続化させる。
   */
  onCall?: ((call: LlmCall) => void) | undefined;
}

export function claudeActor(options: ClaudeOptions): ActorPort {
  return {
    kind: "claude-code",

    async run(invocation): Promise<ActorResult> {
      // SDK には AbortController を渡す。外から来た signal をそれに繋ぐ。
      const aborter = new AbortController();
      if (invocation.signal.aborted) {
        aborter.abort();
      }
      invocation.signal.addEventListener("abort", () => aborter.abort(), { once: true });

      // design.md §4.6 の .goals/.state/runs/<run-id>/ に合わせる。
      const logRef = join(options.runsDir, invocation.runId, "log.jsonl");
      // consume が途中で throw しても、そこまでのログは残す。使用量上限に
      // 当たった実行の手がかりが「例外のメッセージだけ」になるのを避ける。
      const log: string[] = [];

      const partial = (): ActorResult => ({
        exitCode: 1,
        logRef,
        tokens: 0,
        artifacts: [],
      });

      let outcome: Outcome;
      try {
        outcome = await consumeAndLog(options, logRef, log, ACTOR_PROMPT(invocation.intent), {
          // controller 本体のコードと Agent が編集するコードを物理的に分ける（§7）。
          cwd: invocation.worktree.path,
          abortController: aborter,
          // 使ってよいツールを列挙し、それ以外は拒否する。
          // acceptEdits はファイル操作しか自動承認しないので、mise run test の
          // ような Bash 呼び出しが canUseTool に落ちる。コールバックを渡していない
          // controller では、そこで止まって何も実行できない。
          allowedTools: [...ACTOR_TOOLS],
          permissionMode: "dontAsk",
          // merge や force push を Agent に実行させない（§7）。
          // 拒否ルールは許可ルールより先に評価され、bypassPermissions を含む
          // どのモードでも効く。allowedTools に Bash があっても抜けない。
          disallowedTools: disallowedToolsFor(invocation.deniedOperations),
          // ホストの ~/.claude や repo の .claude を読み込ませない。
          // 省略すると user / project / local がすべて読まれ、controller が
          // 与えた拒否リスト以外の設定が Agent の挙動に混ざる。
          settingSources: [],
        });
      } catch (error) {
        // 中断されたなら throw で返さない。act が catch すると logRef を落とすので、
        // 実際に SIGTERM を送ったとき「31KB のログがファイルにあるのに Run からは
        // 辿れない」状態になった。中断は失敗ではなく、そこまでの結果が残る。
        if (invocation.signal.aborted) {
          return partial();
        }
        throw error;
      }

      return {
        // result が来ないまま終わったのは、途中で切れたということ。
        // 成功にすると捏造した成功になる。
        exitCode: outcome.result?.ok === true ? 0 : 1,
        logRef,
        tokens: outcome.result?.tokens ?? 0,
        artifacts: outcome.artifacts,
      };
    },
  };
}

export function claudeLlm(options: ClaudeOptions): LlmPort {
  const now = options.now ?? ((): Date => new Date());
  // 同じティックの中で何度も呼ばれる。時刻だけだと同じ秒に重なるので連番を足す。
  let sequence = 0;

  return {
    async chooseAction(prompt) {
      sequence += 1;
      const calledAt = now().toISOString();
      // Actor の生ログと同じ場所に、同じ粒度で置く（design.md §4.6）。
      const logRef = join(options.runsDir, callIdOf(calledAt, sequence), "log.jsonl");
      const log: string[] = [];

      let outcome: Outcome;
      try {
        outcome = await consumeAndLog(options, logRef, log, `${prompt}\n\n${JSON_ONLY}`, {
          // DECIDE は判断だけで、副作用は ACT が持つ。ファイルを触らせない。
          allowedTools: [],
          permissionMode: "default",
          settingSources: [],
        });
      } catch (error) {
        // 失敗した呼び出しもトークンは消費している。記録しないと §7 の
        // 「従量課金だったらいくらだったか」が実際より小さく出る。
        options.onCall?.({ purpose: "decide", tokens: 0, logRef, ok: false, calledAt });
        throw error;
      }

      const tokens = outcome.result?.tokens ?? 0;
      const text = outcome.result?.text ?? "";
      try {
        // 壊れた出力を握って空オブジェクトを返すと、decide が
        // 「検証に落ちた」と「呼べなかった」を区別できなくなる。
        const parsed = parseJson(text);
        options.onCall?.({ purpose: "decide", tokens, logRef, ok: true, calledAt });
        return parsed;
      } catch (error) {
        options.onCall?.({ purpose: "decide", tokens, logRef, ok: false, calledAt });
        throw error;
      }
    },
  };
}

/** 生ログの置き場所を決める id。`decide-2026-08-09T04-40-56-280Z-1` の形になる */
function callIdOf(calledAt: string, sequence: number): string {
  return `decide-${calledAt.replace(/[:.]/g, "-")}-${sequence}`;
}

/**
 * query() を読み切り、その過程のログを必ずファイルに残す。
 *
 * 途中で throw されてもログを書く。使用量上限や未ログインで落ちた実行こそ
 * 手がかりが要るのに、そこだけログが消えるのでは §4.6 を満たさない。
 */
async function consumeAndLog(
  options: ClaudeOptions,
  logRef: string,
  log: string[],
  prompt: string,
  queryOptions: Options,
): Promise<Outcome> {
  const write = async (): Promise<void> => {
    await (options.writeLog ?? writeLogToFile)(logRef, `${log.join("\n")}\n`);
  };

  try {
    const outcome = await consume(options, prompt, queryOptions, log);
    await write();
    return outcome;
  } catch (error) {
    // ログを書けなくても、元の失敗の方を伝える。
    await write().catch(() => undefined);
    throw error;
  }
}

interface Outcome {
  result: { ok: boolean; text: string; tokens: number } | null;
  artifacts: string[];
  log: string[];
}

/**
 * query() を最後まで読む。
 *
 * 使用量上限に当たったら即座に throw する。読み切ってから判定すると、
 * 上限に達したあとのメッセージを待つことになる。
 */
async function consume(
  options: ClaudeOptions,
  prompt: string,
  queryOptions: Options,
  log: string[],
): Promise<Outcome> {
  const artifacts: string[] = [];
  let result: Outcome["result"] = null;

  // 直前に見た rate limit の状態。assistant の error だけでは
  // 使用量上限と一時的な 429 を区別できないので、こちらを根拠にする。
  let lastStatus: string | null = null;

  // model と effort は呼び出し側の指定が無ければ渡さない。undefined を明示的に
  // 載せると、SDK 側の「省略時は既定に従う」判定に引っかかる形になりうる。
  const merged: Options = { ...queryOptions };
  if (options.model !== undefined) {
    merged.model = options.model;
  }
  if (options.effort !== undefined) {
    merged.effort = options.effort;
  }

  for await (const message of options.query({ prompt, options: merged })) {
    log.push(JSON.stringify(message));
    lastStatus = throwIfUsageLimit(message, lastStatus);

    for (const path of editedPathsOf(message)) {
      // 同じファイルを何度も編集するので重複する。実測では1ファイルが
      // 6回並び、Run の artifacts が読めなくなった。
      if (!artifacts.includes(path)) {
        artifacts.push(path);
      }
    }

    const parsed = resultSchema.safeParse(message);
    if (parsed.success) {
      result = {
        ok: parsed.data.subtype === "success" && parsed.data.is_error !== true,
        text: parsed.data.result ?? "",
        tokens: tokensOf(parsed.data.usage),
      };
    }
  }

  return { result, artifacts, log };
}

/**
 * 使用量上限を判定し、直前に見た rate limit の状態を返す。
 * design.md §10-3 の未決を埋めた実測結果。
 *
 * 根拠は rate_limit_event の status。Claude Code の実装では、応答ヘッダの
 * anthropic-ratelimit-unified-status から status を作り、上限に達していれば
 * rejected になる。resetsAt は秒（コード側が Date.now()/1000 と引き算している）。
 *
 * assistant メッセージの error は単体では根拠にならない。同じ実装が、
 * サブスクリプションの上限にも、一時的な容量制限（"Server is temporarily
 * limiting requests (not your usage limit)"）にも同じ "rate_limit" を入れる。
 * 一時的な 429 を usage_limit として扱うと、待たなくてよい場面で待ってしまう。
 * そこで、直前に rejected を見ているときだけ上限と判断する。
 */
function throwIfUsageLimit(message: unknown, lastStatus: string | null): string | null {
  const rateLimit = rateLimitSchema.safeParse(message);
  if (rateLimit.success) {
    const info = rateLimit.data.rate_limit_info;
    if (info.status === "rejected") {
      throw new PortError(
        "usage_limit",
        `使用量上限に達した（${info.rateLimitType ?? "unknown"}）`,
        resumeAfterFrom(info.resetsAt),
      );
    }
    return info.status;
  }

  const assistant = assistantSchema.safeParse(message);
  if (assistant.success && assistant.data.error === "rate_limit") {
    if (lastStatus === "rejected") {
      // リセット時刻はこの経路では分からない。指数バックオフに任せる。
      throw new PortError("usage_limit", "使用量上限に達した（assistant error）");
    }
    throw new PortError("unavailable", "429 を受けた（一時的な容量制限の可能性）");
  }

  return lastStatus;
}

/**
 * resetsAt を ISO 文字列に直す。
 *
 * SDK の型は `resetsAt?: number` で単位を書いていない。同じ SDK の init
 * メッセージ側は `resets_at: string`（ISO）で、こちらだけ数値になっている。
 *
 * anthropics/claude-code#50518 に実際の値が載っていて、そこでは
 * `{"status":"allowed","resetsAt":1729281600,"rateLimitType":"five_hour"}` と
 * 10桁、つまり秒だった。ただし型に単位が無い以上、将来ミリ秒に変わっても
 * 壊れないよう桁で判定する。2001-09-09 より小さければ秒とみなす。
 */
function resumeAfterFrom(resetsAt: number | undefined): string | null {
  if (resetsAt === undefined) {
    return null;
  }
  const millis = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  const date = new Date(millis);
  // 解釈できない値を捏造した時刻にしない。分からないなら分からないまま返す。
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 実際に処理したトークン数。
 *
 * `input_tokens` と `output_tokens` だけを足すと、実測では 16 になった。
 * 同じ応答の `cache_creation_input_tokens` は 6620、`cache_read_input_tokens` は
 * 25023 で、キャッシュに載った分がそこに移っている。§7 の「あとから単価をかければ
 * 従量課金だったらいくらだったかを出せる」は、この2つを落とすと成立しない。
 *
 * ただし4つは単価が違う（キャッシュ書き込みは高く、読み出しは安い）ので、
 * 合計1つから正確な金額は出ない。内訳は生ログに残っているので、
 * 厳密に出したくなったらそちらを読む。DB が持つのは規模の指標にとどめる。
 */
function tokensOf(usage: z.infer<typeof usageSchema> | undefined): number {
  if (usage === undefined) {
    return 0;
  }
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

/** Agent が書き換えたファイル。Run の artifacts に残す */
function editedPathsOf(message: unknown): string[] {
  const assistant = assistantSchema.safeParse(message);
  if (!assistant.success) {
    return [];
  }
  const paths: string[] = [];
  for (const block of assistant.data.message?.content ?? []) {
    const tool = toolUseSchema.safeParse(block);
    if (
      tool.success &&
      EDIT_TOOLS.has(tool.data.name) &&
      tool.data.input?.file_path !== undefined
    ) {
      paths.push(tool.data.input.file_path);
    }
  }
  return paths;
}

/**
 * 承認が要る操作を禁止ツールに落とす。
 *
 * これは Agent 側の設定にすぎない。Agent が従わなければ素通りするので、
 * controller 側の関門は別に要る（design.md §10-6）。
 */
function disallowedToolsFor(gates: readonly ApprovalGate[]): string[] {
  const tools = new Set<string>();
  for (const gate of gates) {
    for (const tool of DENIED_TOOLS[gate]) {
      tools.add(tool);
    }
  }
  return [...tools];
}

/**
 * Actor が使ってよいツール。ここに無いものは dontAsk が拒否する。
 *
 * 実装させる以上、読む・探す・書く・コマンドを流すの4種類が要る。
 * Bash は必要だが、危険な呼び出しは下の拒否ルールで個別に塞ぐ。
 */
const ACTOR_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "TodoWrite",
] as const;

/**
 * 承認が要る操作に対応する拒否ルール。
 *
 * パターンはグロブ形式（`Bash(git merge *)`）で書く。古い Claude Code の
 * コロン形式（`Bash(git merge:*)`）は現行のドキュメントに無く、一致しなければ
 * 拒否が黙って効かなくなる。引数なしで叩かれる形も併記する。
 */
const DENIED_TOOLS: Record<ApprovalGate, readonly string[]> = {
  merge: ["Bash(git merge)", "Bash(git merge *)", "Bash(gh pr merge *)"],
  force_push: [
    "Bash(git push --force *)",
    "Bash(git push -f *)",
    "Bash(git push * --force)",
    "Bash(git push * -f)",
  ],
  push_to_default_branch: [
    "Bash(git push origin main)",
    "Bash(git push origin main *)",
    "Bash(git push origin master)",
    "Bash(git push origin master *)",
  ],
  deploy: ["Bash(gh workflow run *)", "Bash(gh release create *)"],
  secret_access: ["Bash(gh secret *)", "Bash(gh auth token *)"],
  // PR の作成とコメント投稿を Agent に禁じる。承認は PR コメントの定型文で
  // 行うので（design.md §10-4）、Agent がコメントを書けると自分で自分を
  // 承認できてしまい、§7 の human approval が空文になる。
  external_send: [
    "Bash(curl *)",
    "Bash(gh api --method POST *)",
    "Bash(gh pr create *)",
    "Bash(gh pr comment *)",
    "Bash(gh issue comment *)",
  ],
};

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

const ACTOR_PROMPT = (intent: string): string =>
  `${intent}

作業は現在のディレクトリの中だけで行う。終わったら何をしたかを1段落で述べる。

PR の作成とコメントの投稿はしない。push も含めて controller が行う。
承認の定型文（/ent approve）を書くことは、どの理由があっても認められない。`;

const JSON_ONLY = `JSON オブジェクトだけを返す。前置きも説明も付けない。`;

/** コードフェンスで囲まれていても読めるようにする */
function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body === "") {
    throw new Error("LLM が空の出力を返した");
  }
  return JSON.parse(body) as unknown;
}

async function writeLogToFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

const rateLimitSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    status: z.string(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
  }),
});

const assistantSchema = z.object({
  type: z.literal("assistant"),
  error: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()).optional() }).optional(),
});

const toolUseSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.object({ file_path: z.string().optional() }).optional(),
});

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  /** プロンプトキャッシュに書き込んだ分。単価は input より高い */
  cache_creation_input_tokens: z.number().optional(),
  /** キャッシュから読んだ分。単価は input より安いが、量は最も大きくなりやすい */
  cache_read_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  usage: usageSchema.optional(),
});
