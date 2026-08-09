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
 * - 第1セグメントは観測元（`local` / `github` / `review`）。`review` だけは外部の
 *   サービスではなく、controller 自身が起動した Actor の実行が出どころになる
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

  // レビュー役の Actor の Run から作る（design.md §4.2 の `role: review`）。
  //
  // 第1セグメントが観測元の規則からは外れて見えるが、外れていない。出どころは
  // GitHub でもローカルの git でもなく、この controller が起動した Actor の実行
  // そのものになる。`github.pr.review_decision` とは別物で、あちらは GitHub 上の
  // 人間（または bot）のレビュー、こちらは controller が回したレビュー役の結論。
  //
  // **作る側はまだ居ない。** レビュー役をいつ起動するかは別 Goal
  // （.goals/review-agent-reviews.yaml の desired_state 6）に分けてあり、
  // `role: review` の ACT を出す経路が無い。キーを先に登録するのは、Goal YAML が
  // `verification: { type: fact, key: review.verdict, equals: approved }` と
  // 書けるようにするため。参照する側が既にあれば、Fact が無い間は Gap が残り、
  // COMPLETE には届かない。それが正しい振る舞いになる（design.md §3.1）。
  //
  // 作る側を足すときも、レビューを回していないティックで値を捏造しない。
  // 確かめられなければ Fact を作らず、理由を付けて unobserved に残す。
  /** レビュー役の結論。`approved` か `changes_requested` */
  "review.verdict",
  /**
   * その結論がどの commit を読んだ結果か。
   *
   * verdict だけでは、いつの時点のコードのレビューか分からない。実装が進んだ
   * あとの Fact をそのまま完了判定に使わせないために、対にして残す。
   */
  "review.reviewed_sha",
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
