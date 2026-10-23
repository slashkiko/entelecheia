import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SCHEMA_ID,
  type EvidenceReport,
  evidenceReportSchema,
  levelOf,
} from "@entelecheia/core/factory/evidence-report.js";
import { removeScratch, trackScratch } from "./cleanup.js";
import { isTestFile } from "./definitions.js";
import {
  type ChangedPath,
  changedPaths,
  cloneAt,
  fileAt,
  mergeBase,
  overlayDefinitions,
  resolveCommit,
  workTreeRoot,
} from "./git.js";
import {
  fromObservedRun,
  OBSERVATIONS_SCHEMA_ID,
  type Observations,
  type ObservedRun,
  toObservedRun,
} from "./observations.js";
import { evaluate, type TestFileChange } from "./rules.js";
import { CheckUnavailable, readReports, runTask } from "./run-task.js";

/**
 * 1回の検査の手順。
 *
 * 1. head と base を commit に解決し、PR の分岐点（merge-base）を取る
 * 2. 分岐点から head までの差分を読む。テストを弱めた変更と、検査の定義の変更を探す材料になる
 * 3. 分岐点を切り出し、base の検査の定義を差し込んで verify を流す。テストの件数の基準になる
 * 4. head を切り出し、同じ定義を差し込んで verify を流す
 * 5. 規則を当てて evidence.json の形にする
 *
 * 差分を verify より先に読むのは、head のコードを流した後のリポジトリを信用しないため
 * （`git.ts` の冒頭）。
 *
 * 1・3・4 を `observe` で、1・2・5 を `judge` で、別のプロセスに分けて流せる（どちらも自分で
 * commit を解く）。再利用ワークフローは、`observe` を head を流すジョブで、`judge` を head を
 * 流さないジョブで回す（`observations.ts`）。
 * 手元では `runCheck` が全部を1つのプロセスで流す。
 *
 * 基準を base の先頭ではなく分岐点で取るのは、PR を切った後に main に入ったテストで
 * 「head のテストが減った」と読まないため。定義はどちらにも同じ base のものを差し込むので、
 * base に足された正解表のテストは両方に入り、件数の比べ方は揃う。
 */

interface Commits {
  /** 検査するリポジトリの checkout（その下のディレクトリでもよい）。head と base の commit を持っていること */
  repoDir: string;
  base: string;
  head: string;
}

export interface ObserveOptions extends Commits {
  task: string;
  timeoutMs: number;
}

export interface JudgeOptions extends Commits {
  /** `<owner>/<name>` */
  repo: string;
  pr: number | null;
  /** この ent-check を作った entelecheia の commit。分からなければ null */
  checkerSha: string | null;
  now: () => Date;
}

export type CheckOptions = ObserveOptions & JudgeOptions;

interface Resolved {
  repoDir: string;
  baseSha: string;
  headSha: string;
  forkSha: string;
}

interface Changes {
  changed: ChangedPath[];
  testFiles: TestFileChange[];
}

/** 全部を1つのプロセスで流す */
export async function runCheck(options: CheckOptions): Promise<EvidenceReport> {
  const resolved = await resolve(options);
  const changes = await readChanges(resolved);
  const observations = await observeResolved(resolved, options);
  return report(options, resolved, changes, observations);
}

/** 分岐点と head で verify を流し、見たことだけを返す。規則は当てない */
export async function observe(options: ObserveOptions): Promise<Observations> {
  return observeResolved(await resolve(options), options);
}

/**
 * 別のプロセスが残した観測に、規則を当てる。verify は流さない。
 *
 * 観測は head のコードを流したジョブから来るので、head の言い分として読む。どの commit を
 * 流したものかを自分で解いた sha と比べ、違えば検査できなかった側に倒す。差分は観測から
 * 取らず、ここで読む。
 */
export async function judge(
  options: JudgeOptions,
  observations: Observations,
): Promise<EvidenceReport> {
  const resolved = await resolve(options);
  const pairs = [
    ["base_sha", observations.base_sha, resolved.baseSha],
    ["head_sha", observations.head_sha, resolved.headSha],
    ["fork_sha", observations.fork_sha, resolved.forkSha],
  ] as const;
  for (const [key, observed, sha] of pairs) {
    if (observed !== sha) {
      throw new CheckUnavailable(`the observations are for ${key} ${observed}, not ${sha}`);
    }
  }
  // --observe は基準が時間切れなら観測を書かない。書いてあれば、head の側が作ったものになる
  if (observations.baseline.outcome.type === "timed_out") {
    throw new CheckUnavailable(BASELINE_TIMED_OUT);
  }
  return report(options, resolved, await readChanges(resolved), observations);
}

async function resolve(commits: Commits): Promise<Resolved> {
  const repoDir = await workTreeRoot(commits.repoDir);
  if (repoDir === null) {
    throw new CheckUnavailable(`not a git repository: ${commits.repoDir}`);
  }
  const [baseSha, headSha] = await Promise.all([
    resolveCommit(repoDir, commits.base),
    resolveCommit(repoDir, commits.head),
  ]);
  if (baseSha === null || headSha === null) {
    throw new CheckUnavailable(
      `commit not found: ${baseSha === null ? commits.base : commits.head}`,
    );
  }
  const forkSha = await mergeBase(repoDir, baseSha, headSha);
  if (forkSha === null) {
    throw new CheckUnavailable(`no merge base between ${baseSha} and ${headSha}`);
  }
  return { repoDir, baseSha, headSha, forkSha };
}

async function readChanges({ repoDir, forkSha, headSha }: Resolved): Promise<Changes> {
  const changed = await changedPaths(repoDir, forkSha, headSha);
  const testFiles: TestFileChange[] = [];
  for (const change of changed) {
    const sides = [change.path, change.previousPath].filter(
      (path): path is string => path !== undefined,
    );
    if (!sides.some(isTestFile)) continue;
    testFiles.push({
      path: change.path,
      before: await fileAt(repoDir, forkSha, change.previousPath ?? change.path),
      after: change.deleted ? null : await fileAt(repoDir, headSha, change.path),
    });
  }
  return { changed, testFiles };
}

const BASELINE_TIMED_OUT =
  "the verify task did not finish on the merge base within the time limit (--timeout-minutes)";

async function observeResolved(resolved: Resolved, options: ObserveOptions): Promise<Observations> {
  const { repoDir, baseSha, headSha, forkSha } = resolved;
  const scratch = await mkdtemp(join(tmpdir(), "ent-check-"));
  // 止められたときにも消す（`cleanup.ts`）
  const forget = trackScratch(scratch);
  try {
    const runAt = async (label: string, sha: string): Promise<ObservedRun> => {
      const dir = join(scratch, label);
      const reportDir = join(scratch, "reports", label);
      await mkdir(reportDir, { recursive: true });
      await cloneAt(repoDir, dir, sha);
      const overlay = await overlayDefinitions(repoDir, dir, sha, baseSha, scratch);
      for (const path of overlay.removed) {
        process.stderr.write(`ent-check: ${label}: removed ${path} (not in the base)\n`);
      }
      const outcome = await runTask({
        cwd: dir,
        task: options.task,
        reportDir,
        timeoutMs: options.timeoutMs,
      });
      return { outcome, tests: await readReports(reportDir) };
    };

    const baseline = await runAt("baseline", forkSha);
    if (baseline.outcome.type === "timed_out") {
      // 基準が取れないと、head の件数を何とも比べられない。head の不合格にはしない。
      throw new CheckUnavailable(BASELINE_TIMED_OUT);
    }
    // head のコードを流した後は、元のリポジトリで git を叩かない。head の切り出しと定義の
    // 書き戻しは、runAt の中でタスクより前に済ませる。
    const head = await runAt("head", headSha);
    return {
      schema: OBSERVATIONS_SCHEMA_ID,
      base_sha: baseSha,
      head_sha: headSha,
      fork_sha: forkSha,
      baseline: fromObservedRun(baseline),
      head: fromObservedRun(head),
    };
  } finally {
    removeScratch(scratch);
    forget();
  }
}

function report(
  options: JudgeOptions,
  { baseSha, headSha }: Resolved,
  { changed, testFiles }: Changes,
  observations: Observations,
): EvidenceReport {
  const baseline = toObservedRun(observations.baseline);
  const findings = evaluate({
    baselineOutcome: baseline.outcome,
    baselineTests: baseline.tests,
    head: toObservedRun(observations.head),
    testFiles,
    changedPaths: changed.flatMap((change) =>
      change.previousPath === undefined ? [change.path] : [change.path, change.previousPath],
    ),
  });
  // 書く側でも schema を通す。形の崩れた evidence.json を出すより、検査できなかったと
  // 言うほうが、読む側の判断を誤らせない。
  return evidenceReportSchema.parse({
    schema: EVIDENCE_SCHEMA_ID,
    repo: options.repo,
    pr: options.pr,
    head_sha: headSha,
    base_sha: baseSha,
    check_definition_sha: baseSha,
    checker_sha: options.checkerSha,
    level: levelOf(findings.results),
    ...findings,
    holdout: null,
    review: null,
    generated_at: options.now().toISOString(),
  } satisfies EvidenceReport);
}

/** 合格か。落ちた規則が1つも無いこと。段階（level）は別に読む */
export function passed(report: EvidenceReport): boolean {
  return report.results.every((result) => result.status !== "fail");
}
