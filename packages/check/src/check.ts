import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SCHEMA_ID,
  type EvidenceReport,
  evidenceReportSchema,
  levelOf,
} from "@entelecheia/core/factory/evidence-report.js";
import { isTestFile } from "./definitions.js";
import {
  changedPaths,
  cloneAt,
  fileAt,
  mergeBase,
  overlayDefinitions,
  resolveCommit,
  workTreeRoot,
} from "./git.js";
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
 * 基準を base の先頭ではなく分岐点で取るのは、PR を切った後に main に入ったテストで
 * 「head のテストが減った」と読まないため。定義はどちらにも同じ base のものを差し込むので、
 * base に足された正解表のテストは両方に入り、件数の比べ方は揃う。
 */

export interface CheckOptions {
  /** 検査するリポジトリの checkout（その下のディレクトリでもよい）。head と base の commit を持っていること */
  repoDir: string;
  /** `<owner>/<name>` */
  repo: string;
  pr: number | null;
  base: string;
  head: string;
  task: string;
  timeoutMs: number;
  /** この ent-check を作った entelecheia の commit。分からなければ null */
  checkerSha: string | null;
  now: () => Date;
}

export async function runCheck(options: CheckOptions): Promise<EvidenceReport> {
  const repoDir = await workTreeRoot(options.repoDir);
  if (repoDir === null) {
    throw new CheckUnavailable(`not a git repository: ${options.repoDir}`);
  }
  const [baseSha, headSha] = await Promise.all([
    resolveCommit(repoDir, options.base),
    resolveCommit(repoDir, options.head),
  ]);
  if (baseSha === null || headSha === null) {
    throw new CheckUnavailable(
      `commit not found: ${baseSha === null ? options.base : options.head}`,
    );
  }
  const forkSha = await mergeBase(repoDir, baseSha, headSha);
  if (forkSha === null) {
    throw new CheckUnavailable(`no merge base between ${baseSha} and ${headSha}`);
  }

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

  const scratch = await mkdtemp(join(tmpdir(), "ent-check-"));
  try {
    const runAt = async (label: string, sha: string) => {
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
      throw new CheckUnavailable(
        "the verify task did not finish on the merge base within the time limit (--timeout-minutes)",
      );
    }
    // head のコードを流した後は、元のリポジトリで git を叩かない。head の切り出しと定義の
    // 書き戻しは、runAt の中でタスクより前に済ませる。
    const head = await runAt("head", headSha);

    const findings = evaluate({
      baselineOutcome: baseline.outcome,
      baselineTests: baseline.tests,
      head,
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
  } finally {
    await removeScratch(scratch);
  }
}

/**
 * 切り出しを消す。消せなくても投げない。
 *
 * 中には head のコードが作ったファイルがある。権限を外したディレクトリを残されると
 * `rm` は EACCES で投げ、その例外が出来上がった報告を押しのけて「検査できなかった」に
 * なる。head の不合格を head の側で取り消せてしまう。
 */
async function removeScratch(scratch: string): Promise<void> {
  try {
    await rm(scratch, { recursive: true, force: true });
    return;
  } catch {
    // 権限を戻してもう一度試す
  }
  try {
    await restoreWritable(scratch);
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`ent-check: could not remove ${scratch}: ${String(error)}\n`);
  }
}

async function restoreWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await restoreWritable(join(dir, entry.name));
    }
  }
}

/** 合格か。落ちた規則が1つも無いこと。段階（level）は別に読む */
export function passed(report: EvidenceReport): boolean {
  return report.results.every((result) => result.status !== "fail");
}
