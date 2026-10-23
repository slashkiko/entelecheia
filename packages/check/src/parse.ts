import { parseArgs } from "node:util";
import { commitShaSchema } from "@entelecheia/core/factory/evidence-report.js";

/**
 * `ent-check` の引数の解釈だけを持つ。実行はしない（`src/main.ts` が持つ）。
 * 解釈を分けてあるのは、ent の `src/cli/parse.ts` と同じく、それ単体でテストするため。
 */

export const USAGE = `ent-check — Check a PR head against the base's check definitions and write evidence.json.

  ent-check --repo <owner>/<name> --base <sha> --head <sha> [options]

  --repo <owner>/<name>   The repository being checked (recorded in evidence.json)
  --base <rev>            The base the check definitions come from (the PR's base commit)
  --head <rev>            The commit to check (the PR's head commit)
  --pr <n>                The PR number (omit when checking a branch head)
  --dir <path>            The checkout holding both commits (default: the current directory)
  --task <name>           The mise task to run (default: verify)
  --timeout-minutes <n>   Time limit for one run of the task, including mise install
                          (default: 30, at most 1440)
  --out <path>            Also write evidence.json to this path
  --checker-sha <sha>     The entelecheia commit this ent-check was built from (recorded in
                          evidence.json; the governor rejects a report without it)

  Exit codes: 0 no rule failed (the report's level says how far the evidence reaches),
  1 a rule failed, 2 bad arguments, 3 could not check (or could not write --out).
  evidence.json goes to stdout; the task's own output goes to stderr.`;

export const DEFAULT_TASK = "verify";
export const DEFAULT_TIMEOUT_MINUTES = 30;
/**
 * 1日。setTimeout は約24.8日を超える値を1ミリ秒に丸めるので、タスクがすぐ止まり
 * 「検査できなかった」になる。それよりずっと手前で、引数の誤りにする。
 */
const MAX_TIMEOUT_MINUTES = 1440;

export interface CheckCommand {
  kind: "check";
  repo: string;
  base: string;
  head: string;
  pr: number | null;
  dir: string | null;
  task: string;
  timeoutMinutes: number;
  out: string | null;
  checkerSha: string | null;
}

export type Command = CheckCommand | { kind: "help" } | { kind: "error"; message: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;
/** mise のタスク名。`-` で始まる値を option と読ませない */
const TASK = /^[\w][\w:.-]*$/;

export function parseCommand(argv: readonly string[]): Command {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        repo: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        pr: { type: "string" },
        dir: { type: "string" },
        task: { type: "string" },
        "timeout-minutes": { type: "string" },
        out: { type: "string" },
        "checker-sha": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help === true) {
    return { kind: "help" };
  }

  const missing = (["repo", "base", "head"] as const).filter(
    (name) => typeof values[name] !== "string" || values[name] === "",
  );
  if (missing.length > 0) {
    return { kind: "error", message: `missing ${missing.map((name) => `--${name}`).join(", ")}` };
  }
  const repo = String(values.repo);
  if (!REPO.test(repo)) {
    return { kind: "error", message: `--repo must be <owner>/<name>: ${repo}` };
  }
  const task = typeof values.task === "string" ? values.task : DEFAULT_TASK;
  if (!TASK.test(task)) {
    return { kind: "error", message: `--task is not a task name: ${task}` };
  }
  const checkerSha = typeof values["checker-sha"] === "string" ? values["checker-sha"] : null;
  // 短い sha やブランチ名では、どの検査で作ったかを決められない
  if (checkerSha !== null && !commitShaSchema.safeParse(checkerSha).success) {
    return { kind: "error", message: `--checker-sha must be a full commit sha: ${checkerSha}` };
  }
  const pr = positiveInteger(values.pr, "--pr");
  if (typeof pr === "string") {
    return { kind: "error", message: pr };
  }
  const timeout = positiveInteger(values["timeout-minutes"], "--timeout-minutes");
  if (typeof timeout === "string") {
    return { kind: "error", message: timeout };
  }
  if (timeout !== null && timeout > MAX_TIMEOUT_MINUTES) {
    return {
      kind: "error",
      message: `--timeout-minutes must be at most ${MAX_TIMEOUT_MINUTES}: ${timeout}`,
    };
  }

  return {
    kind: "check",
    repo,
    base: String(values.base),
    head: String(values.head),
    pr,
    dir: typeof values.dir === "string" ? values.dir : null,
    task,
    timeoutMinutes: timeout ?? DEFAULT_TIMEOUT_MINUTES,
    out: typeof values.out === "string" ? values.out : null,
    checkerSha,
  };
}

/** 無ければ null、正の整数でなければ理由の文字列 */
function positiveInteger(
  value: string | boolean | undefined,
  name: string,
): number | null | string {
  if (value === undefined) {
    return null;
  }
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    return `${name} must be a positive integer: ${text}`;
  }
  return Number(text);
}
