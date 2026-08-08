import { z } from "zod";
import type { Action } from "./action.js";

/**
 * Goal のライフサイクル。design.md §4.4 の状態機械をそのまま型にする。
 *
 * ESCALATE は reconcile が選ぶ行動、BLOCKED は Goal の状態でレイヤーが違う。
 * 同じ「止まっている」でも、前者は1ティックの出力、後者は次のティックが読む前提になる。
 */
export const goalStatusSchema = z.enum([
  /** 登録されたが criteria が承認されていない */
  "DRAFT",
  /** criteria の承認待ち。design.md §3.2 では YAML のレビューがこれにあたる */
  "AWAITING_CRITERIA_APPROVAL",
  "ACTIVE",
  /** 人間の承認待ち。reconcile は即 return している */
  "WAITING_HUMAN",
  /** CI や使用量上限の待ち。resume_after を持つことがある */
  "WAITING_EXTERNAL",
  /** 予算・回数・時間の上限に到達した */
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "ABANDONED",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

/**
 * 終端状態。ここからは遷移しない。
 * 終端に落ちた Goal を次のティックが拾って動かし続けると、完了判定が意味を失う。
 */
export function isTerminal(status: GoalStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "ABANDONED";
}

/**
 * Decision の action から次の状態を決める。
 *
 * 満たすべき性質:
 * - 終端状態からは遷移しない。現在の状態をそのまま返す
 * - COMPLETE → COMPLETED
 * - WAIT(review_pending) → WAITING_HUMAN、それ以外の WAIT → WAITING_EXTERNAL
 * - ESCALATE(budget_exhausted) → BLOCKED、それ以外の ESCALATE → WAITING_HUMAN
 * - ACT / VERIFY / REPLAN → ACTIVE
 * - ACTIVE でない状態からでも、上の対応で ACTIVE に戻れる（design.md §4.4 の ⇅）
 */
export function nextStatus(_current: GoalStatus, _action: Action): GoalStatus {
  throw new Error("not implemented");
}
