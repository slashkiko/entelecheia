import { commitShaSchema } from "@entelecheia/core/factory/evidence-report.js";
import { z } from "zod";
import type { TestCase } from "./junit.js";
import type { TaskOutcome } from "./rules.js";

/**
 * verify を流して見たこと（`ent.observations/v1`）。分岐点と head の2回分を持つ。
 *
 * 再利用ワークフローは、verify を流すジョブと evidence.json を作るジョブを分ける。head の
 * コードを流したジョブは、同じユーザーで動く head のプロセスに報告もトークンも触られうる。
 * そこで流すジョブは見たことだけをこの形で残し、判定は head を流さない別のジョブが、
 * 自分で読んだ差分とこれを合わせて行う。
 *
 * **中身は head の言い分として読む。** head のジョブはこのファイルも差し替えられるので、
 * 読む側は形と大きさを検め、どの commit を流したものかを自分で解いた sha と比べる。
 * それでも、テストの件数や skip の数を head が偽ることは防げない。防げるのは、差分から決まる
 * 規則と段階の計算を head に触らせないところまでになる。
 */

export const OBSERVATIONS_SCHEMA_ID = "ent.observations/v1";

/** 流すジョブが観測を残し、判定するジョブが取り出す artifact の名前 */
export const OBSERVATIONS_ARTIFACT_NAME = "ent-observations";

/** artifact の中のファイルの名前 */
export const OBSERVATIONS_FILE_NAME = "observations.json";

/**
 * 読む上限。テスト1件はおよそ数十バイトなので、数万件の報告でも収まる。head が巨大な
 * ファイルを置いても、判定のジョブがそれを読み込んで止まらないようにする
 */
export const MAX_OBSERVATIONS_BYTES = 16 * 1024 * 1024;

const outcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("exited"), exit_code: z.number().int() }),
  z.strictObject({ type: z.literal("timed_out") }),
]);

const runSchema = z.strictObject({
  outcome: outcomeSchema,
  /** 報告が読めなければ null */
  tests: z.array(z.strictObject({ name: z.string(), skipped: z.boolean() })).nullable(),
});

export const observationsSchema = z.strictObject({
  schema: z.literal(OBSERVATIONS_SCHEMA_ID),
  base_sha: commitShaSchema,
  head_sha: commitShaSchema,
  /** PR の分岐点。`baseline` はここを流した結果 */
  fork_sha: commitShaSchema,
  baseline: runSchema,
  head: runSchema,
});
export type Observations = z.infer<typeof observationsSchema>;

export interface ObservedRun {
  outcome: TaskOutcome;
  tests: TestCase[] | null;
}

export function toObservedRun(run: Observations["baseline"]): ObservedRun {
  return {
    outcome:
      run.outcome.type === "exited"
        ? { type: "exited", exitCode: run.outcome.exit_code }
        : { type: "timed_out" },
    tests: run.tests,
  };
}

export function fromObservedRun(run: ObservedRun): Observations["baseline"] {
  return {
    outcome:
      run.outcome.type === "exited"
        ? { type: "exited", exit_code: run.outcome.exitCode }
        : { type: "timed_out" },
    tests: run.tests,
  };
}
