import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type ActorInvocation,
  type ActorPort,
  type ActorResult,
  renderPullRequestText,
} from "../act/index.js";
import type { LlmPort } from "../decide/index.js";
import type { ApprovalGate } from "../domain/goal.js";
import type { LlmCall } from "../domain/llm-call.js";
import { PortError } from "../domain/port-error.js";
import type { ActorRole } from "../domain/run.js";
import { CLAUDE_ACTOR_WITHHELD_ENV, withheldEnv } from "../domain/withheld-env.js";

/**
 * 除去リストの置き場所は domain に移した。VERIFY 側（src/adapters/local.ts）も
 * 同じものを見る必要があるため。ここから再輸出しているのは、既存の呼び出し元と
 * テストが `adapters/claude` を参照しているのを壊さないため。
 */
export { CLAUDE_ACTOR_WITHHELD_ENV };

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
   * Actor と LLM に渡す元の環境変数。省略すると `process.env`。
   *
   * ここから資格情報を落として SDK に渡す。テストから差し替えられるようにしてある。
   */
  env?: Record<string, string | undefined> | undefined;
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

      const partial = (): ActorResult => ({
        exitCode: 1,
        logRef,
        tokens: 0,
        artifacts: [],
      });

      // 役割で分けるのは指示ではなく権限（design.md §4.2）。intent は LLM が
      // 生成するもので、「書いた」ことは確かめられても「従った」ことは確かめられない。
      const role = invocation.role;

      let outcome: Outcome;
      try {
        outcome = await consumeAndLog(options, logRef, PROMPT_FOR[role](invocation), {
          // controller 本体のコードと Agent が編集するコードを物理的に分ける（§7）。
          cwd: invocation.worktree.path,
          abortController: aborter,
          // 使ってよいツールを列挙し、それ以外は拒否する。
          // acceptEdits はファイル操作しか自動承認しないので、mise run test の
          // ような Bash 呼び出しが canUseTool に落ちる。コールバックを渡していない
          // controller では、そこで止まって何も実行できない。
          allowedTools: [...ACTOR_TOOLS[role]],
          permissionMode: "dontAsk",
          // merge や force push を Agent に実行させない（§7）。
          // 拒否ルールは許可ルールより先に評価され、bypassPermissions を含む
          // どのモードでも効く。allowedTools に Bash があっても抜けない。
          disallowedTools: disallowedToolsIn(role, invocation.deniedOperations),
          // ホストの ~/.claude や repo の .claude を読み込ませない。
          // 省略すると user / project / local がすべて読まれ、controller が
          // 与えた拒否リスト以外の設定が Agent の挙動に混ざる。
          settingSources: [],
          // 読ませたい skill だけを、controller の側から名指しで渡す（SKILLS_FOR）。
          ...skillOptionsFor(role),
          // controller の資格情報を Agent のシェルに残さない。
          env: withheldEnv(options.env ?? process.env, CLAUDE_ACTOR_WITHHELD_ENV),
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

      let outcome: Outcome;
      try {
        outcome = await consumeAndLog(options, logRef, `${prompt}\n\n${JSON_ONLY}`, {
          // DECIDE は判断だけで、副作用は ACT が持つ。ファイルを触らせない。
          allowedTools: [],
          permissionMode: "default",
          settingSources: [],
          env: withheldEnv(options.env ?? process.env, CLAUDE_ACTOR_WITHHELD_ENV),
        });
      } catch (error) {
        // 失敗した呼び出しもトークンは消費している。記録しないと §7 の
        // 「従量課金だったらいくらだったか」が実際より小さく出る。
        options.onCall?.({ purpose: "decide", tokens: 0, logRef, ok: false, calledAt });
        throw error;
      }

      // 呼び直しても直らない失敗を、そうと分かる形で返す。decide の askLlm() は
      // PortError(unavailable) を見て即 ESCALATE する（design.md §3.5）。
      // ここで素の Error を投げると isUnavailable の経路に乗らず、未ログインの
      // ようなその場で直らない失敗にも MAX_LLM_RETRIES 回を使い切ってしまう。
      // 1回の呼び出しは Claude Code のフルセッションなので、ティック内の再試行は高くつく。
      const result = outcome.result;
      if (result === null || !result.ok) {
        // consume は成功しているのでトークン数は分かっている。0 で記録すると
        // design.md §7 の会計が実際より小さく出る。
        options.onCall?.({
          purpose: "decide",
          tokens: result?.tokens ?? 0,
          logRef,
          ok: false,
          calledAt,
        });
        throw new PortError("unavailable", unavailableMessage(result));
      }

      const tokens = result.tokens;
      const text = result.text;
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

/**
 * 採用できない result を人間が読める1行にする。
 *
 * subtype からは一時的か恒久的かを判別できないので推測しない。代わりに subtype と
 * 本文をそのまま載せ、`decisions.rationale` だけを見て何が起きたか分かるようにする。
 * 「Not logged in · Please run /login」がここに出るのが本来の目的になる。
 */
function unavailableMessage(result: Outcome["result"]): string {
  if (result === null) {
    // 途中で切れたのに空の出力として扱うと、壊れた出力と区別できなくなる。
    return "The stream ended before LlmPort returned a result";
  }
  const body = result.text.trim();
  return `LlmPort returned an error result (${result.subtype}): ${body === "" ? "no body" : body}`;
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
  prompt: string,
  queryOptions: Options,
): Promise<Outcome> {
  // ログの器はここが持つ。以前は2つの呼び出し元がそれぞれ空の配列を作って
  // 渡していたが、どちらも渡したあと一度も読まなかった。Outcome.log として
  // 返してもいたが、その口を読む呼び出し元も無かった。書く側と読む側が
  // 同じ関数の中に閉じるので、外に出す理由が無い。
  const log: string[] = [];

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
  /** subtype は失敗の説明にだけ使う。一時的か恒久的かの判別材料にはしない */
  result: { ok: boolean; subtype: string; text: string; tokens: number } | null;
  artifacts: string[];
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
        subtype: parsed.data.subtype,
        text: parsed.data.result ?? "",
        tokens: tokensOf(parsed.data.usage),
      };
    }
  }

  return { result, artifacts };
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
        `Usage limit reached (${info.rateLimitType ?? "unknown"})`,
        resumeAfterFrom(info.resetsAt),
      );
    }
    return info.status;
  }

  const assistant = assistantSchema.safeParse(message);
  if (assistant.success && assistant.data.error === "rate_limit") {
    if (lastStatus === "rejected") {
      // リセット時刻はこの経路では分からない。指数バックオフに任せる。
      throw new PortError("usage_limit", "Usage limit reached (assistant error)");
    }
    throw new PortError("unavailable", "Received 429 (possibly a temporary capacity limit)");
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
      EDIT_TOOL_NAMES.has(tool.data.name) &&
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
  const tools = new Set<string>(ALWAYS_DENIED);
  for (const gate of gates) {
    for (const tool of DENIED_TOOLS[gate]) {
      tools.add(tool);
    }
  }
  return [...tools];
}

/**
 * 実際に SDK へ渡す拒否リスト。承認ゲート由来の分に、role 由来の分を足す。
 *
 * **足すだけで、引かない。** `disallowedToolsFor` は role を見ない
 * （`policies.require_human_approval` は役割によらずそのまま落ちる）。
 * レビュー役だからといって merge や force push を許す経路を作らないため、
 * ゲートの解決と役割の制限は別の関数のままにしてある。
 *
 * 編集のツールは `ACTOR_TOOLS` から外したうえで、ここにも入れる。許可リストから
 * 外すだけでは、設定の読み込み順や既定値が変わったときに素通りしうる。
 * 拒否ルールは許可ルールより先に評価されるので、二重にしておく。
 */
function disallowedToolsIn(role: ActorRole, gates: readonly ApprovalGate[]): string[] {
  const tools = disallowedToolsFor(gates);
  for (const tool of EDIT_TOOLS) {
    if (!ACTOR_TOOLS[role].includes(tool) && !tools.includes(tool)) {
      tools.push(tool);
    }
  }
  for (const tool of DESTRUCTIVE_GIT) {
    if (!ACTOR_TOOLS[role].includes("Edit") && !tools.includes(tool)) {
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * 作業ツリーの中身を消す git。**編集のツールを持たない役割には渡さない。**
 *
 * レビュー役は実装役と同じ作業ツリーを見る（`worktreeNameFor`）。分けない理由は
 * あちらに書いたが、分けないぶん「レビュー役が checkout や clean を打てば実装側の
 * 差分が消える」という当初の懸念だけが残る。編集のツールを外しても Bash は残るので、
 * `git checkout .` の1行で同じことができてしまう。
 *
 * 判定は role の名前ではなく**編集のツールを持っているか**で行う。役割が増えたとき、
 * 読むだけの役割はここに書き足さなくても既定で塞がる。
 *
 * **`git stash` はここから `ALWAYS_DENIED` へ移した。** ここに並ぶ他のものは
 * 「作業ツリーの中身を消す」——つまり実装役自身の成果を壊すもので、消した結果は
 * 関門の観測（指紋の差）に出る。stash だけは性質が違い、**汚れの集合から
 * ファイルを消して観測そのものを空にする**（design.md §10-6 の (e)）。
 * 実装役に許してよい理由が無いので、役割の条件を外した。
 */
const DESTRUCTIVE_GIT = [
  "Bash(git checkout *)",
  "Bash(git restore *)",
  "Bash(git clean *)",
  "Bash(git reset *)",
] as const;

/** どの役割にも要る、読むためのツール。これが無ければコードを読めない */
const READ_TOOLS = ["Read", "Glob", "Grep"] as const;

/**
 * ファイルを書き換えるツール。**実装役だけが持つ。**
 *
 * `editedPathsOf` が Run の artifacts を拾うのにも使う。1箇所にまとめてあるのは、
 * 役割ごとの許可・拒否と「何を編集と見なすか」がずれないようにするため。
 */
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;
const EDIT_TOOL_NAMES = new Set<string>(EDIT_TOOLS);

/**
 * コマンドを流す側。レビュー役にも残す。
 *
 * 読むだけでも `mise run test` は流せる必要がある。テストを回さないレビューは
 * 「読んだ感想」にしかならない。危険な呼び出しは拒否ルールで個別に塞ぐ。
 */
const RUN_TOOLS = ["Bash", "TodoWrite"] as const;

/**
 * 役割ごとに、Actor が使ってよいツール。ここに無いものは dontAsk が拒否する。
 *
 * design.md §4.2 の `ActorRole` を、指示ではなく権限に落とす場所になる。
 * 「レビューして」という intent を実装役に渡すのは、読み方だけ変えるよう
 * 頼んでいるのと同じで、Agent が従わなければ実装を書き換えられる。
 *
 * `investigate` は読む側なので review と同じにしてある。調べるのに編集は要らない。
 */
const ACTOR_TOOLS: Record<ActorRole, readonly string[]> = {
  implement: [...READ_TOOLS, ...EDIT_TOOLS, ...RUN_TOOLS],
  review: [...READ_TOOLS, ...RUN_TOOLS],
  investigate: [...READ_TOOLS, ...RUN_TOOLS],
};

/**
 * レビュー役に読ませる skill を入れた plugin の置き場所。
 *
 * **`settingSources: []` は解かない。** ホストの `~/.claude` とリポジトリの
 * `.claude` を読ませない判断（上の `run` を参照）はそのままで、controller が
 * 名指しした plugin だけが Agent から見える。実際に叩いて確かめたところ、
 * skill の一覧に出るのは `ent-review:semantic-review` の1件だけになる。
 *
 * パスは `import.meta.url` から引く。cwd 基準にすると、ent は対象リポジトリの
 * ルートで叩かれる CLI なので（`repoRoot = process.cwd()`、src/cli.ts）、
 * 対象リポジトリ側の `plugins/` を見に行って外れる。`src/adapters/` からも
 * `dist/adapters/` からも、2つ上がリポジトリのルートになる。
 */
const REVIEW_PLUGIN_DIR = fileURLToPath(new URL("../../plugins/ent-review", import.meta.url));

/**
 * 役割ごとに読ませる skill。名前は SKILL.md の `name`（非修飾でよい）。
 *
 * 実装役には渡さない。レビューの観点は読む側にだけ要るもので、実装役に渡すと
 * 「観点を満たすように書く」余地を与える。criteria を通すのに何を書けばよいかを
 * Actor 側が知る形は、`src/act/index.ts` が避けている構図と同じになる。
 *
 * SDK は `skills` を `Skill(<name>)` に展開して `--allowedTools` へ足すので、
 * `ACTOR_TOOLS` に `Skill` を書く必要は無い。渡した名前以外の skill は
 * 一覧に出ず、Skill ツールからも拒否される。
 *
 * `ACTOR_TOOLS` と同じく役割を網羅した Record にしてある。役割を足したときに
 * 「skill を渡すかどうか」を書かせる。省略できる形にすると、既定の側へ黙って
 * 倒れる——安全な向きではあるが、決めた形跡が残らない。
 */
const SKILLS_FOR: Record<ActorRole, readonly string[]> = {
  implement: [],
  review: ["semantic-review"],
  investigate: [],
};

/**
 * その役割に渡す plugin と skill。要らない役割には**キーごと渡さない**。
 *
 * `skills: []` は「1つも有効にしない」であって「SDK の既定に任せる」ではない。
 * 省略と空配列で意味が違うので、空のときはキーを作らない。
 */
function skillOptionsFor(role: ActorRole): Pick<Options, "plugins" | "skills"> {
  const skills = SKILLS_FOR[role];
  if (skills.length === 0) {
    return {};
  }
  return {
    plugins: [{ type: "local", path: REVIEW_PLUGIN_DIR }],
    skills: [...skills],
  };
}

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

/**
 * Goal の設定によらず常に拒否する呼び出し。
 *
 * ここに並ぶのは「危ないこと」ではなく、**関門が観測に使っている前提を壊すもの**。
 * `changedPaths` は commit 済みの違反を `<base>...HEAD` の diff で見るので、
 * base の ref を消されると、違反を commit してから ref を消すだけで
 * 差分が読めなくなる。ref を消す側を塞いでおかないと、検査の入力そのものを
 * Actor が選べることになる。
 *
 * これは二重化の片側でしかない（design.md §10-6）。SDK の設定は SDK の外から
 * 同じ操作をされれば素通りするので、`changedPaths` 側も解決できなければ
 * throw して guard_unavailable に倒す。
 *
 * `git worktree` は読み取りの `list` ごと拒否する。サブコマンドだけを列挙すると、
 * 書ける形（`add` / `remove` / `move` / `prune`）を1つ書き落とした時点で穴になる。
 * Actor が作業ツリーの構成を知る必要は無いので、動詞ごと閉じる方を採る。
 *
 * ## `git <サブコマンド> *` だけでは `-C` の前置で外れる
 *
 * SDK が使う規則は**先頭からのグロブ**になる。Claude Code 2.1.197 のバイナリから
 * 規則の解釈（`RUn`）と照合（`wV`）を取り出して流したところ、`Bash(git push *)` は
 * `^git push( .*)?$` にあたる正規表現になり、`git -C .. push origin HEAD:main` には
 * **一致しない**。`--git-dir=` の前置も同じで外れる。
 *
 * そこで、同じ動詞について `git * <サブコマンド>*` の形も併記する。`*` は空白も
 * 跨ぐので（`wV` は `.*` に `s` フラグを付けて組む）、`-C` や `--git-dir=` を
 * 挟んだ形はこちらで拾える。両方書くのは、前者が `git push ...` を、後者が
 * `git <何か> push ...` を見るためで、片方では片方の形が落ちる。
 *
 * **それでも数え上げは閉じない。** `GIT_DIR=... git push` のように環境変数を
 * 前置すると `git` で始まらなくなり、どちらの綴りにも一致しない
 * （Claude Code が剥がす環境変数の一覧に `GIT_DIR` は入っていない）。
 * `sh -c` 経由も同じ。**拒否リストは二重化の片側でしかなく**、観測を潰す形は
 * controller 側でも見る（`gitWorktree.changedPaths` / `repoDirtyState` が
 * index の隠しビットを直接読む）。
 */
const ALWAYS_DENIED = [
  "Bash(git update-ref *)",
  "Bash(git symbolic-ref *)",
  "Bash(git branch -D *)",
  "Bash(git branch -d *)",
  "Bash(git branch --delete *)",
  // ref を**前に進める**側も塞ぐ。消す側だけを塞いでも、`git branch -f main HEAD`
  // でローカルの base を HEAD に揃えれば `<base>...HEAD` の差分が空になる。
  // `changedPaths` は `origin/<base>` を先に見るようにしたが、remote を持たない
  // repo ではローカルの base に落ちるので、そちらの経路も閉じておく。
  // `git fetch .` と `git push .` は remote を自分自身にしてローカル ref を
  // 書き換える形で、`branch -f` と同じところへ届く。
  "Bash(git branch -f *)",
  "Bash(git branch --force *)",
  "Bash(git fetch . *)",
  "Bash(git push . *)",
  "Bash(git worktree *)",
  // hooks の差し替えを拒否する。`core.hooksPath` を1回設定するだけで、
  // hooks のファイルを1つも触らずに、push のたびに走るスクリプト群を
  // まるごと別のディレクトリへ移せる。controller 側は `repoDirtyState` の
  // 相方（`outOfSightState`）で設定値の変化を検知するが、そちらは ACT の
  // あとに鳴る。Agent 側でも塞いでおく。
  "Bash(git config core.hooksPath *)",
  "Bash(git config --local core.hooksPath *)",
  "Bash(git config --global core.hooksPath *)",
  // index の隠しビット。`git status --porcelain -uall` はこれを尊重するので、
  // `git -C ../../../.. update-index --assume-unchanged src/controller/index.ts` を
  // 1回叩いてから本体側のファイルを書き換えると、**関門の一次入力が空になる**。
  // 既知の穴 (c) と (e) は「1度は人間に届く」を保証として残していたが、
  // この経路は一度も鳴らない。`--skip-worktree` も同じ動詞にある。
  "Bash(git update-index *)",
  "Bash(git * update-index*)",
  // 追跡から外す側。`git rm --cached` は status に削除として出るので観測は
  // 潰れないが、隠しビットと同じ動機で叩かれる。
  "Bash(git rm --cached *)",
  "Bash(git * rm --cached*)",
  // 汚れの集合を空にする側（design.md §10-6 の (e)）。編集のツールを持つ役割にも
  // 掛ける（`DESTRUCTIVE_GIT` から移した）。
  "Bash(git stash *)",
  "Bash(git stash)",
  "Bash(git * stash*)",
  // push は controller だけが行う（`COMMON_TAIL` も Agent にそう書いている）。
  // 承認ゲートの `push_to_default_branch` は `Bash(git push origin main)` の
  // 綴りで並んでいるだけなので、`git push origin HEAD:main` は素通りしていた。
  // 資格情報を無効化しても、綴りの数え上げに頼る形は残さない。
  "Bash(git push *)",
  "Bash(git push)",
  "Bash(git * push*)",
  // keychain のトークンを stdout に出す口。`git credential fill` に
  // `protocol=https` / `host=github.com` を流すだけで取れていた。
  "Bash(git credential *)",
  "Bash(git credential-osxkeychain *)",
  "Bash(git * credential*)",
] as const;

/**
 * どの役割でも同じ末尾。承認と公開は controller の側に残す。
 *
 * Agent が PR コメントを書けると自分で自分を承認できてしまい、§7 の
 * human approval が空文になる（拒否ルールと二重にする）。
 */
const COMMON_TAIL = `PR の作成とコメントの投稿はしない。push も含めて controller が行う。
承認の定型文（/ent approve）を書くことは、どの理由があっても認められない。`;

const IMPLEMENT_PROMPT = ({ intent }: ActorInvocation): string =>
  `${intent}

作業は現在のディレクトリの中だけで行う。終わったら何をしたかを1段落で述べる。

${COMMON_TAIL}`;

/**
 * レビュー役のプロンプト。
 *
 * 権限だけ分けてプロンプトが同じだと、レビュー役は編集を試みて拒否され続け、
 * ターンをそこに使い切る。読む側に何を求めるかを先に書いておく。
 *
 * 結論を1語に寄せるのは、`review.verdict`（src/domain/fact-keys.ts）に落とす
 * ときに、読み手が本文を解釈しないで済むようにするため。どの commit を読んだか
 * まで言わせるのは、実装が進んだあとの結論をそのまま完了判定に使わせないため。
 * ただし**ここで言わせた文字列はまだ Fact ではない。** Fact にするのは
 * 観測側の仕事で、確かめられなければ作らない（design.md §3.1）。
 *
 * ## 観点は skill が持ち、契約はこちらが持つ
 *
 * 何を見るかは `semantic-review`（`plugins/ent-review/`）に置いてある。あれは
 * ent の外でも使う汎用の skill で、**GitHub の PR を読む前提で書かれている。**
 * ent のレビュー役はそうではない——作業ツリーの中で HEAD を読み、`gh` には
 * 資格情報を渡しておらず（`WITHHELD_ENV`）、WebFetch も MCP も持たない。
 * その差は下の読み替えの表で吸収し、**skill 側には ent の語彙を入れない。**
 * 別リポジトリへ切り出すときにコピーだけで済む形を保つ。
 *
 * ## PR のタイトルと本文は controller が渡す
 *
 * **レビュー役が自分で PR を読むことはできない**（資格情報を渡さない設計は
 * 変えない）が、controller は OBSERVE で PR を読んでいる。その結果だけを
 * `ActorInvocation.pullRequest` で受け取り、`renderPullRequestText` が組み立てた
 * 節をここに載せる。渡す口が無かったころは「宣言部の制約が PR 本文に反映されて
 * いるか」という観点が毎回「未取得」で終わっていた。
 *
 * **読み替えの表もそれに合わせて直す。** 渡す口だけ足して表を残すと、同じ
 * プロンプトが「PR は読めない」と「これが PR のタイトルと本文だ」を同時に述べる。
 * ただし**「宣言された意図」の一次情報は `.goals/<id>.yaml` のまま**にする。
 * PR 本文を意図の基準にすると、宣言部と食い違う本文を根拠に approved が出せる。
 * 本文はレビューの**対象**であって、判定の基準ではない。
 *
 * 出力の契約もこちらが持つ。skill の出力形式（末尾が `<sub>` のフッタ）に
 * 手を入れる必要は無い。観測側が求めているのは「`verdict:` の行が本文中に
 * ちょうど1つ」と「`reviewed_sha:` のラベル行」で、どちらも最終行である必要は
 * 無いため、skill の本文の**後ろに2行足す**だけで噛み合う
 * （`soleVerdictIn` / `soleShaIn`、src/observe/index.ts）。
 *
 * `INSUFFICIENT_CONTEXT` を `changes_requested` に寄せるのは、確かめられな
 * かったものを `approved` に倒せないため。ここで生む Gap は次のティックの
 * 実装役に渡るが、`.goals/**` は保護パスなので宣言部そのものは直せない。
 * その場合は保護パス違反か budget の枯渇で人間が呼ばれる——**黙って
 * 回り続けはしない。** 宣言部を `ent start` より前に commit しておけば起きない。
 */
const REVIEW_PROMPT = ({ intent, goalId, pullRequest }: ActorInvocation): string =>
  `${intent}

あなたはレビュー役として起動している。**ファイルは書き換えない。**
編集のツールは渡していないので、試みても拒否される。読むことと、
コマンドを流して確かめることだけを行う。

作業は現在のディレクトリの中だけで行う。

## 何を使うか

\`semantic-review\` の skill を Skill ツールで起動し、その観点と出力形式に従う。
skill は GitHub の Pull Request を読む前提で書かれているが、**ここでは PR を
自分で取りに行かない。** 次の読み替えを、skill の記述より優先する。

| skill の前提 | ここでの読み替え |
| --- | --- |
| 対象は GitHub Pull Request | 現在の作業ツリーの HEAD と、その base からの差分 |
| PR のタイトル・本文が「宣言された意図」 | 「宣言された意図」は \`.goals/${goalId}.yaml\` の desired_state・acceptance_criteria・context のまま。PR のタイトルと本文は下の節に controller が観測して渡してあり、**意図の基準ではなくレビューの対象**として読む |
| gh やコネクタでチケットや議論を読む | 使えない。リポジトリの中と下の節だけで確かめ、取れなかったものは「未取得」と書く |
| PR コメントとして投稿する | 投稿しない。本文を返すだけ |

\`gh\` には資格情報を渡していない。WebFetch も MCP も無い。使おうとしない。
PR について確かめられるのは、下の節に載っている分だけになる。

## 手順

1. git rev-parse HEAD で、読む commit を確かめる
2. \`.goals/${goalId}.yaml\` を読む。これが意図の一次情報になる。
   context.references に挙がっているリポジトリ内のファイルも読む。
   **読めなければ観点 A を評価せず、判定を INSUFFICIENT_CONTEXT にし、
   「宣言部を読めなかった」ことを要対応の第1項目に書く**
3. 下の「PR のタイトルと本文」を読む。渡っていれば、宣言部の制約が本文に
   反映されているかもここで見る。渡っていなければ、その観点は評価せず「未取得」と書く
4. 差分と、その差分が壊しうる箇所を読む。必要ならテストを流して確かめる
5. semantic-review の観点と出力形式で、レビュー本文を作る
6. 本文の最後に、次の2行だけを足す

reviewed_sha: <1 で確かめた40桁の sha>
verdict: <approved か changes_requested のどちらか>

判定の対応は次のとおり。

| semantic-review の判定 | verdict |
| --- | --- |
| ALIGNED | approved |
| MISALIGNED | changes_requested |
| INSUFFICIENT_CONTEXT | changes_requested |

\`verdict:\` で始まる行を、本文の他の場所に書かない。**本文全体でちょうど1つ**
でなければ、結論として読まれない。\`reviewed_sha:\` も同じ理由で1つにする。

確かめられなかったことを「問題なし」と書かない。

${renderPullRequestText(pullRequest ?? null)}

${COMMON_TAIL}`;

/**
 * 調べる役のプロンプト。ツールはレビュー役と同じだが、結論の形が違う。
 *
 * レビュー役の文面を流用すると、調べただけの実行が `verdict:` の行を出す。
 * それを観測側が拾えば、レビューを回していないティックの approved になる。
 * 起動する側はまだ居ない（design.md §4.2）が、口を残す以上は分けておく。
 */
const INVESTIGATE_PROMPT = ({ intent }: ActorInvocation): string =>
  `${intent}

あなたは調べる役として起動している。**ファイルは書き換えない。**
編集のツールは渡していないので、試みても拒否される。

作業は現在のディレクトリの中だけで行う。分かったことと、その根拠
（読んだファイル、流したコマンドとその出力）を述べる。確かめられなかったことは、
確かめられなかったと書く。推測で埋めない。

${COMMON_TAIL}`;

/**
 * 役割ごとのプロンプト。
 *
 * 受け取るのは intent だけではなく invocation そのものにしてある。レビュー役が
 * 宣言部（`.goals/<goalId>.yaml`）を名指しするのに goalId が要り、役割ごとに
 * 何が要るかは今後も変わる。ここで分岐を持たせず、使う側が自分で取り出す。
 */
const PROMPT_FOR: Record<ActorRole, (invocation: ActorInvocation) => string> = {
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  investigate: INVESTIGATE_PROMPT,
};

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
