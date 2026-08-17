import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ActorInvocation, ActorPort, ActorResult } from "../act/index.js";
import type { LlmPort } from "../decide/index.js";
import { errorMessage } from "../domain/error-message.js";
import type { LlmCall } from "../domain/llm-call.js";
import { PortError } from "../domain/port-error.js";
import type { ActorRole } from "../domain/run.js";
import { CODEX_ACTOR_WITHHELD_ENV, withheldEnv } from "../domain/withheld-env.js";
import { JSON_ONLY, PROMPT_FOR, parseJson } from "./agent-prompt.js";

/**
 * Codex CLI の model_reasoning_effort に渡す値。
 *
 * codex-cli 0.147.0 が持つモデルカタログに合わせてある。`gpt-5.6-sol` /
 * `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4` の
 * `supported_reasoning_levels` はどれも `low` から始まり、上は `max` まで伸びる。
 *
 * **`none` と `minimal` は落としてある。** 現行のどのモデルも advertise して
 * いない。config の parse は今でも通る（`-c model_reasoning_effort="minimal"` は
 * 落ちない）ので、弾いているのは ent の側になる。古い Codex に合わせる必要が
 * 出たら、ここへ戻す。
 */
export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexCommand {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  signal: AbortSignal;
}

export interface CodexExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** テストから実プロセスを差し替える境界。 */
export type CodexExec = (command: CodexCommand) => Promise<CodexExecution>;

export interface CodexOptions {
  /** 生ログの置き場所（design.md §4.6） */
  runsDir: string;
  /** `codex exec` を起動する口。省略時は node:child_process を使う */
  exec?: CodexExec | undefined;
  /** ログをファイルに書く口。テストから差し替える */
  writeLog?: ((path: string, contents: string) => Promise<void>) | undefined;
  /** 省略時は Codex CLI の既定モデル */
  model?: string | undefined;
  /** 省略時は Codex CLI の既定 effort */
  effort?: CodexEffort | undefined;
  /** テスト時に固定するための時刻ソース */
  now?: (() => Date) | undefined;
  /** Codex 子プロセスへ渡す元の環境変数 */
  env?: Record<string, string | undefined> | undefined;
  /** DECIDE の呼び出しを永続化する通知 */
  onCall?: ((call: LlmCall) => void) | undefined;
  /**
   * この LlmPort が何のための呼び出しか（`LlmCall.purpose`）。省略すると DECIDE。
   *
   * `onCall` に渡すラベルと、生ログの置き場所の名前の両方に使う。
   */
  purpose?: LlmCall["purpose"] | undefined;
}

/**
 * Codex CLI を ActorPort に接続する。
 *
 * Codex の非対話モードは role ごとのツール allowlist を直接受け取らないため、
 * 実装役だけ workspace-write にし、review / investigate は read-only に固定する。
 * command 単位の拒否はプロンプトと controller の事後関門が受け持つ。Claude
 * Adapter と完全に同じ強さではないので、Codex は明示的な opt-in にしてある。
 *
 * **資格情報の無効化と、index の隠しビットの検知は、こちらにも同じだけ効く。**
 * 前者は `withheldEnv` が `NEUTRALIZED_ENV` を重ねる形なので Adapter を選ばず
 * （design.md §7）、後者は controller 側の観測に入れてあるので Adapter の外にある
 * （`indexHiddenPaths`、§10-6）。Claude 側にだけ足した拒否リストは、あくまで
 * 二重化の片側でしかない。
 */
export function codexActor(options: CodexOptions): ActorPort {
  return {
    kind: "codex",

    async run(invocation): Promise<ActorResult> {
      const logRef = join(options.runsDir, invocation.runId, "log.jsonl");
      const partial = (): ActorResult => ({
        exitCode: 1,
        logRef,
        tokens: 0,
        artifacts: [],
      });

      let execution: CodexExecution;
      try {
        execution = await (options.exec ?? executeCodex)({
          args: argsFor(invocation.role, invocation.worktree.path, options),
          cwd: invocation.worktree.path,
          env: withheldEnv(options.env ?? process.env, CODEX_ACTOR_WITHHELD_ENV),
          prompt: actorPrompt(invocation),
          signal: invocation.signal,
        });
      } catch (error) {
        await writeFailureLog(options, logRef, error);
        if (invocation.signal.aborted) {
          return partial();
        }
        throw new PortError(
          "unavailable",
          `Could not launch the Codex CLI: ${errorMessage(error)}`,
        );
      }

      const outcome = outcomeOf(execution);
      // 上限のときだけ、再開時刻を読む。読めたかどうかは生ログにも残す。
      const reset = outcome.usageLimit
        ? resetTimeIn(outcome.failure ?? "", (options.now ?? (() => new Date()))())
        : null;
      try {
        await writeCodexLog(
          options,
          logRef,
          execution,
          reset === null ? [] : [resetLogLine(reset)],
        );
      } catch (error) {
        throw new PortError(
          "unavailable",
          `Could not write the Codex raw log: ${errorMessage(error)}`,
        );
      }
      if (outcome.usageLimit) {
        const failure = outcome.failure ?? "Codex usage limit reached";
        const at = reset?.at ?? null;
        return {
          exitCode: 1,
          logRef,
          tokens: outcome.tokens,
          artifacts: outcome.artifacts,
          errorKind: "usage_limit",
          // 読めなければ null のまま返す。既定の待ちを決めるのは guard の側で、
          // Adapter は「観測できなかった」を偽らない（design.md §3.1）。
          resumeAfter: at,
          detail: at === null ? `${failure} ${unreadableResetNote(reset)}` : failure,
        };
      }

      const succeeded =
        execution.exitCode === 0 && outcome.finalMessage !== null && outcome.failure === null;

      return {
        exitCode: succeeded ? 0 : execution.exitCode || 1,
        logRef,
        tokens: outcome.tokens,
        artifacts: outcome.artifacts,
        ...(succeeded
          ? {}
          : {
              errorKind: "unavailable" as const,
              detail: outcome.failure ?? "The Codex CLI returned no final message",
            }),
      };
    },
  };
}

/** Codex CLI を DECIDE の LlmPort に接続する。 */
export function codexLlm(options: CodexOptions): LlmPort {
  const now = options.now ?? ((): Date => new Date());
  const purpose = options.purpose ?? "decide";
  let sequence = 0;

  return {
    async chooseAction(prompt) {
      sequence += 1;
      const calledAt = now().toISOString();
      const logRef = join(options.runsDir, callIdOf(purpose, calledAt, sequence), "log.jsonl");
      const signal = new AbortController().signal;

      let execution: CodexExecution;
      try {
        execution = await (options.exec ?? executeCodex)({
          args: argsFor("investigate", process.cwd(), options),
          cwd: process.cwd(),
          env: withheldEnv(options.env ?? process.env, CODEX_ACTOR_WITHHELD_ENV),
          prompt: `${prompt}\n\n${JSON_ONLY}`,
          signal,
        });
      } catch (error) {
        await writeFailureLog(options, logRef, error);
        options.onCall?.({ purpose, tokens: 0, logRef, ok: false, calledAt });
        throw new PortError(
          "unavailable",
          `Could not launch the Codex CLI: ${errorMessage(error)}`,
        );
      }

      const outcome = outcomeOf(execution);
      const reset = outcome.usageLimit ? resetTimeIn(outcome.failure ?? "", now()) : null;
      let notified = false;
      const notify = (ok: boolean): void => {
        if (notified) {
          return;
        }
        notified = true;
        options.onCall?.({
          purpose,
          tokens: outcome.tokens,
          logRef,
          ok,
          calledAt,
        });
      };

      try {
        await writeCodexLog(
          options,
          logRef,
          execution,
          reset === null ? [] : [resetLogLine(reset)],
        );
      } catch (error) {
        notify(false);
        throw new PortError(
          "unavailable",
          `Could not write the Codex raw log: ${errorMessage(error)}`,
        );
      }

      if (execution.exitCode !== 0 || outcome.finalMessage === null || outcome.failure !== null) {
        notify(false);
        const failure = outcome.failure ?? "The Codex CLI returned no final message";
        if (reset !== null) {
          // 上限のときは再開時刻を載せる。載せないと DECIDE の WAIT(usage_limit) が
          // 毎ティック起き直すことになる（`resumeAfterOf`、src/domain/port-error.ts）。
          throw new PortError(
            "usage_limit",
            reset.at === null ? `${failure} ${unreadableResetNote(reset)}` : failure,
            reset.at,
          );
        }
        throw new PortError("unavailable", failure);
      }

      try {
        const parsed = parseJson(outcome.finalMessage);
        notify(true);
        return parsed;
      } catch (error) {
        notify(false);
        throw error;
      }
    },
  };
}

/**
 * `codex exec` の argv。
 *
 * - `--json`: 生ログとトークンを機械的に読む
 * - `--ephemeral`: ent 自身が Run を保存するので Codex の session は残さない
 * - `--ignore-user-config` / `--ignore-rules`: ホスト固有の設定を実行契約へ混ぜない
 * - `-`: 長い prompt を argv に載せず stdin から渡す
 */
function argsFor(role: ActorRole, cwd: string, options: CodexOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--sandbox",
    role === "implement" ? "workspace-write" : "read-only",
    "--cd",
    cwd,
  ];
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  }
  args.push("-");
  return args;
}

function actorPrompt(invocation: ActorInvocation): string {
  const denied = invocation.deniedOperations.map((operation) => `- ${operation}`).join("\n");
  // skill は本文ごと差し込む。`codex exec` には、repo の中の skill を1回の起動へ
  // 渡す口がフラグにも `-c` の config にも無い（`skills` は struct として在るが、
  // 置き場所を指すフィールドが無い）。残る discovery は `$CODEX_HOME/skills` と
  // marketplace の plugin で、どちらもホスト側に状態を置く形になり、
  // `--ephemeral` / `--ignore-user-config` の隔離契約と噛み合わない。
  return `${PROMPT_FOR[invocation.role](invocation, "inline")}

The operations below require human approval. Do not perform them.
${denied === "" ? "- none" : denied}`;
}

interface CodexOutcome {
  finalMessage: string | null;
  tokens: number;
  artifacts: string[];
  failure: string | null;
  usageLimit: boolean;
}

/** JSONL と stderr から、Port が使う最小の結果だけを作る。 */
function outcomeOf(execution: CodexExecution): CodexOutcome {
  let finalMessage: string | null = null;
  let tokens = 0;
  let failure: string | null = null;
  const artifacts = new Set<string>();

  for (const event of eventsIn(execution.stdout)) {
    const completed = itemCompletedSchema.safeParse(event);
    if (completed.success) {
      const item = completed.data.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
      if (item.type === "file_change") {
        for (const path of pathsInFileChange(item)) {
          artifacts.add(path);
        }
      }
    }

    const turn = turnCompletedSchema.safeParse(event);
    if (turn.success) {
      // cached_input_tokens は input_tokens の内数、reasoning_output_tokens は
      // output_tokens の内数なので足さない。二重計上を避ける。
      tokens += (turn.data.usage?.input_tokens ?? 0) + (turn.data.usage?.output_tokens ?? 0);
    }

    const message = failureMessageOf(event);
    if (message !== null) {
      failure = message;
    }
  }

  if (failure === null && execution.exitCode !== 0) {
    const stderr = execution.stderr.trim();
    failure =
      stderr === "" ? `The Codex CLI exited with code ${String(execution.exitCode)}` : stderr;
  }

  return {
    finalMessage,
    tokens,
    artifacts: [...artifacts],
    failure,
    // 一時的な 429 を利用枠の上限と誤認しない。明示的に usage limit と
    // 書かれた失敗だけを WAITING_EXTERNAL に送る。
    usageLimit: failure !== null && /\busage limit\b/i.test(failure),
  };
}

function eventsIn(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // 途中で kill された末尾や将来の非 JSON 診断は、生ログには残して読み飛ばす。
    }
  }
  return events;
}

function pathsInFileChange(item: z.infer<typeof codexItemSchema>): string[] {
  const paths = new Set<string>();
  if (item.path !== undefined) {
    paths.add(item.path);
  }
  if (item.file_path !== undefined) {
    paths.add(item.file_path);
  }
  for (const change of item.changes ?? []) {
    if (change.path !== undefined) {
      paths.add(change.path);
    }
  }
  return [...paths];
}

function failureMessageOf(event: unknown): string | null {
  const direct = errorEventSchema.safeParse(event);
  if (direct.success) {
    return (
      direct.data.message ?? direct.data.error?.message ?? "The Codex CLI returned an error event"
    );
  }
  const failed = turnFailedSchema.safeParse(event);
  if (failed.success) {
    return typeof failed.data.error === "string"
      ? failed.data.error
      : (failed.data.error?.message ?? "The Codex CLI turn failed");
  }
  return null;
}

function callIdOf(purpose: LlmCall["purpose"], calledAt: string, sequence: number): string {
  return `${purpose}-${calledAt.replace(/[:.]/g, "-")}-${sequence}`;
}

/** 上限メッセージから読んだ再開時刻。読めなかったときも、読もうとした文字列を残す。 */
interface ResetTime {
  /** ISO8601。読めなければ null */
  at: string | null;
  /** メッセージの中で再開時刻に見えた部分。見つからなければ null */
  text: string | null;
}

/**
 * `... or try again at Aug 20th, 2026 9:00 PM.` から再開時刻を読む。
 *
 * **読めなくても失敗にはしない。** Codex CLI はこの文面を JSON の1フィールドとして
 * 出さないので、形が変われば黙って読めなくなる。読めたら `resume_after` に入れ、
 * 読めなければ null を返して**既定の待ちは guard に決めさせる**
 * （`usageLimitResumeAfter`、src/domain/guard-rules.ts）。
 *
 * 時刻はタイムゾーンを伴わないので、走っているマシンのローカル時刻として読む。
 * 数時間ずれても起きる時刻がずれるだけで、guard の既定が下限を持つ。
 *
 * **過去の時刻は読めなかったものとして扱う。** ここは「いま上限に当たった」直後で、
 * 過去を指す値は時計のずれか誤読になる。そのまま `resume_after` に入れると
 * `sleepingUntil` が「起きてよい」を返し、直そうとしている空転に戻る。
 */
function resetTimeIn(failure: string, now: Date): ResetTime {
  const found = /\btry again (?:at|after)\s+([^.]+)/i.exec(failure);
  const text = found?.[1]?.trim() ?? null;
  if (text === null) {
    return { at: null, text: null };
  }
  // `20th` のような序数を落とす。`Date.parse("Aug 20th, 2026 9:00 PM")` は NaN で、
  // `Aug 20, 2026 9:00 PM` なら通る。
  const parsed = Date.parse(text.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1"));
  if (Number.isNaN(parsed) || parsed <= now.getTime()) {
    return { at: null, text };
  }
  return { at: new Date(parsed).toISOString(), text };
}

/** 読めなかったことを Run の detail に残す一言。読もうとした文字列も添える */
function unreadableResetNote(reset: ResetTime | null): string {
  const text = reset?.text ?? null;
  return text === null
    ? "(ent: the message carried no reset time, so the default wait applies)"
    : `(ent: could not read a reset time from "${text}", so the default wait applies)`;
}

/** 生ログにも残す。Run の detail と合わせて、後から読み直せる形にする */
function resetLogLine(reset: ResetTime): string {
  return JSON.stringify({
    type: "ent.codex.usage_limit_reset",
    resume_after: reset.at,
    text: reset.text,
  });
}

async function writeCodexLog(
  options: CodexOptions,
  path: string,
  execution: CodexExecution,
  diagnostics: readonly string[] = [],
): Promise<void> {
  let contents =
    execution.stdout === "" || execution.stdout.endsWith("\n")
      ? execution.stdout
      : `${execution.stdout}\n`;
  if (execution.stderr.trim() !== "") {
    contents += `${JSON.stringify({ type: "ent.codex.stderr", text: execution.stderr })}\n`;
  }
  // ent が読み取った側の1行。Codex が出した行と混ざらないよう `ent.` を頭に付ける。
  for (const line of diagnostics) {
    contents += `${line}\n`;
  }
  await (options.writeLog ?? writeLogToFile)(path, contents);
}

async function writeFailureLog(options: CodexOptions, path: string, error: unknown): Promise<void> {
  const line = JSON.stringify({ type: "ent.codex.spawn_error", message: errorMessage(error) });
  await (options.writeLog ?? writeLogToFile)(path, `${line}\n`).catch(() => undefined);
}

async function writeLogToFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** 実際の `codex exec`。shell を挟まず、prompt は stdin にだけ流す。 */
async function executeCodex(command: CodexCommand): Promise<CodexExecution> {
  return await new Promise((resolve, reject) => {
    const child = spawn("codex", command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const abort = (): void => {
      child.kill("SIGTERM");
    };
    command.signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // 引数不正や未ログインで Codex が stdin を読む前に終了すると EPIPE が来る。
    // close 側の終了コードと stderr の方が原因を持つので、未処理例外にはしない。
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        command.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        command.signal.removeEventListener("abort", abort);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });

    if (command.signal.aborted) {
      abort();
    }
    child.stdin.end(command.prompt);
  });
}

const codexItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  path: z.string().optional(),
  file_path: z.string().optional(),
  changes: z.array(z.object({ path: z.string().optional() })).optional(),
});

const itemCompletedSchema = z.object({
  type: z.literal("item.completed"),
  item: codexItemSchema,
});

const turnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      cached_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      reasoning_output_tokens: z.number().optional(),
    })
    .optional(),
});

const errorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

const turnFailedSchema = z.object({
  type: z.literal("turn.failed"),
  error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(),
});
