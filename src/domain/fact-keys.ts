import { z } from "zod";

/**
 * OBSERVE が返しうる観測キーの一覧。
 *
 * Phase 0 で最初に詰まったのがここだった。テストは `local.head_sha` を要求するのに
 * Port の型は `headSha` で、対応表がコードにもドキュメントにも無かった。
 * Goal YAML だけを渡された実装者は当てられない。
 *
 * キーを Goal YAML 側に書かせる案もあったが、観測キーは Goal ごとに変わらず
 * OBSERVE の実装が決めるものなので、レジストリはコード側に置く。
 * Goal YAML は `verification: { type: fact, key: ... }` でここを参照するだけにし、
 * 実在しないキーは Zod が弾く。
 *
 * 命名規則:
 * - ドット区切りの小文字 snake_case
 * - 第1セグメントは観測元（`local` / `github`）
 * - 第2セグメント以降は論理リソース（`pr` / `ci` / `issue`）とその属性
 * - Port の camelCase フィールド名はここで snake_case に変換される
 */
export const observedFactKeySchema = z.enum([
  // LocalRepoPort.snapshot()
  "local.branch",
  "local.head_sha",
  "local.dirty",

  // CodeProviderPort.getPullRequest()
  "github.pr.number",
  "github.pr.state",
  "github.pr.head_sha",
  "github.pr.mergeable",
  "github.pr.review_decision",
  "github.pr.requested_reviewers",

  // CodeProviderPort.getLatestCiRun()
  "github.ci.status",
  "github.ci.conclusion",
  "github.ci.failed_jobs",

  // CodeProviderPort.getIssue()
  "github.issue.number",
  "github.issue.state",
  "github.issue.labels",
  "github.issue.linked_pr",
]);
export type ObservedFactKey = z.infer<typeof observedFactKeySchema>;

/**
 * VERIFY が criteria の結果を書き出すキー。
 *
 * criteria の id は Goal ごとに違うので列挙できない。
 * Goal YAML の `verification: { type: fact }` からここを参照させると
 * criteria 同士が循環しうるため、参照できるのは observedFactKeySchema 側だけにしてある。
 */
export function criterionFactKey(criterionId: string): string {
  return `criteria.${criterionId}.passed`;
}
