import type { Fact, Unresolved } from "../domain/fact.js";
import type { Assessment } from "../domain/gap.js";
import type { AcceptanceCriterion } from "../domain/goal.js";

/**
 * ASSESS は外部世界を触らない。OBSERVE と VERIFY が集めた Fact だけを読む。
 * Port が要らないのは、ここで新たに観測してしまうと
 * 「どのティックで見た値か」が Fact ごとにずれるため。
 */
export interface AssessTarget {
  criteria: readonly AcceptanceCriterion[];
  /** OBSERVE と VERIFY が返した Fact を合わせたもの */
  facts: readonly Fact[];
  /** unobserved と unverified を合わせたもの */
  unresolved: readonly Unresolved[];
}

export interface AssessDeps {
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

/**
 * Acceptance Criteria と Fact を突き合わせ、埋まっていない差分を返す。
 *
 * 満たすべき性質:
 * - satisfied の判定に使ってよいのは VERIFIED な Fact だけ（design.md §3.1）。
 *   INFERRED しか無い criteria は満たしたことにしない
 * - 「検証して落ちた」（unmet）と「まだ検証していない」（unknown）を分ける。
 *   混ぜると DECIDE が「直す」と「確かめる」を選び分けられない
 * - unresolved に残っている criteria は unknown。落ちたことにしない
 * - gaps が空であることと satisfied は一致する
 */
export function assess(_target: AssessTarget, _deps: AssessDeps): Assessment {
  throw new Error("not implemented");
}
