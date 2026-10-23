import { parseArgs } from "node:util";
import { commitShaSchema } from "@entelecheia/core/factory/evidence-report.js";

/**
 * `ent-check` の引数の解釈だけを持つ。実行はしない（`src/main.ts` が持つ）。
 * 解釈を分けてあるのは、ent の `src/cli/parse.ts` と同じく、それ単体でテストするため。
 */

export const USAGE = `ent-check — Check a PR head against the base's check definitions and write evidence.json.

  ent-check --repo <owner>/<name> --base <sha> --head <sha> [options]
  ent-check --observe --base <sha> --head <sha> [--dir, --task, --timeout-minutes, --out]
  ent-check --observations <path> --repo <owner>/<name> --base <sha> --head <sha>
            [--pr, --dir, --out, --checker-sha]

  --repo <owner>/<name>   The repository being checked (recorded in evidence.json)
  --base <rev>            The base the check definitions come from (the PR's base commit)
  --head <rev>            The commit to check (the PR's head commit)
  --pr <n>                The PR number (omit when checking a branch head)
  --dir <path>            The checkout holding both commits (default: the current directory)
  --task <name>           The mise task to run (default: verify)
  --timeout-minutes <n>   Time limit for one run of the task, including mise install
                          (default: 30, at most 1440)
  --out <path>            Also write the JSON to this path
  --checker-sha <sha>     The entelecheia commit this ent-check was built from (recorded in
                          evidence.json; the governor rejects a report without it)
  --observe               Only run the task on the merge base and the head, and output what was
                          observed (the observations JSON) instead of evidence.json
  --observations <path>   Do not run the task. Apply the rules to the observations written by
                          --observe, together with the diff read here, and write evidence.json

  Exit codes: 0 no rule failed (the report's level says how far the evidence reaches; with
  --observe, the task ran on both commits), 1 a rule failed, 2 bad arguments, 3 could not check
  (or could not write --out). The JSON goes to stdout; the task's own output goes to stderr.`;

export const DEFAULT_TASK = "verify";
export const DEFAULT_TIMEOUT_MINUTES = 30;
/**
 * 1日。setTimeout は約24.8日を超える値を1ミリ秒に丸めるので、タスクがすぐ止まり
 * 「検査できなかった」になる。それよりずっと手前で、引数の誤りにする。
 */
const MAX_TIMEOUT_MINUTES = 1440;

interface CommitsCommand {
  base: string;
  head: string;
  dir: string | null;
  out: string | null;
}

/** 全部を1つのプロセスで流す */
export interface CheckCommand extends CommitsCommand {
  kind: "check";
  repo: string;
  pr: number | null;
  task: string;
  timeoutMinutes: number;
  checkerSha: string | null;
}

/** verify を流して、見たことだけを書く（`--observe`） */
export interface ObserveCommand extends CommitsCommand {
  kind: "observe";
  task: string;
  timeoutMinutes: number;
}

/** 別のプロセスが書いた観測に規則を当てる（`--observations`） */
export interface JudgeCommand extends CommitsCommand {
  kind: "judge";
  observations: string;
  repo: string;
  pr: number | null;
  checkerSha: string | null;
}

export type Command =
  | CheckCommand
  | ObserveCommand
  | JudgeCommand
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * それぞれの形で使わない option。黙って捨てると、呼ぶ側は効いていると思い込む
 * （`--observations` に `--task` を付けても、タスクは流れない）
 */
const UNUSED: Readonly<Record<"observe" | "judge", readonly string[]>> = {
  observe: ["repo", "pr", "checker-sha"],
  judge: ["task", "timeout-minutes"],
};

const REPO = /^[\w.-]+\/[\w.-]+$/;
const REQUIRED = ["repo", "base", "head"] as const;
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
        observe: { type: "boolean" },
        observations: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help === true) {
    return { kind: "help" };
  }

  const observations = typeof values.observations === "string" ? values.observations : null;
  if (values.observe === true && observations !== null) {
    return { kind: "error", message: "--observe and --observations cannot be used together" };
  }
  if (observations === "") {
    return { kind: "error", message: "--observations must be a path" };
  }
  const stage = values.observe === true ? "observe" : observations !== null ? "judge" : null;
  if (stage !== null) {
    const unused = UNUSED[stage].filter((name) => values[name] !== undefined);
    if (unused.length > 0) {
      const flag = stage === "observe" ? "--observe" : "--observations";
      return {
        kind: "error",
        message: `${unused.map((name) => `--${name}`).join(", ")} cannot be used with ${flag}`,
      };
    }
  }

  const required = stage === "observe" ? (["base", "head"] as const) : REQUIRED;
  const missing = required.filter(
    (name) => typeof values[name] !== "string" || values[name] === "",
  );
  if (missing.length > 0) {
    return { kind: "error", message: `missing ${missing.map((name) => `--${name}`).join(", ")}` };
  }
  const repo = String(values.repo ?? "");
  if (stage !== "observe" && !REPO.test(repo)) {
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

  const commits: CommitsCommand = {
    base: String(values.base),
    head: String(values.head),
    dir: typeof values.dir === "string" ? values.dir : null,
    out: typeof values.out === "string" ? values.out : null,
  };
  const timeoutMinutes = timeout ?? DEFAULT_TIMEOUT_MINUTES;
  if (stage === "observe") {
    return { kind: "observe", ...commits, task, timeoutMinutes };
  }
  if (observations !== null) {
    return { kind: "judge", ...commits, observations, repo, pr, checkerSha };
  }
  return { kind: "check", ...commits, repo, pr, task, timeoutMinutes, checkerSha };
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
