import type { AssessDeps } from "../assess/index.js";
import type { BudgetUsage, DecideDeps } from "../decide/index.js";
import type { Decision } from "../domain/action.js";
import type { Fact, Unresolved } from "../domain/fact.js";
import type { Assessment } from "../domain/gap.js";
import type { Goal } from "../domain/goal.js";
import type { ObserveDeps, ObserveTarget } from "../observe/index.js";
import type { VerifyDeps } from "../verify/index.js";

export interface ReconcileDeps extends ObserveDeps, AssessDeps, DecideDeps, VerifyDeps {}

export interface ReconcileTarget {
  goal: Goal;
  /** 観測対象。PR と Issue の番号は controller が持つ */
  observe: ObserveTarget;
  /** 前ティックまでに得た Fact。永続化は別 Goal なので呼び出し側が渡す */
  carriedFacts: readonly Fact[];
  usage: BudgetUsage;
}

export interface ReconcileResult {
  /** このティックで観測・検証した結果を含む Fact 集合 */
  facts: Fact[];
  unresolved: Unresolved[];
  assessment: Assessment;
  decision: Decision;
}

/**
 * reconcile の1ティック。OBSERVE → VERIFY → ASSESS → DECIDE を回して
 * 次の行動を返す。ACT の実行と永続化は本 Goal の範囲外。
 *
 * 満たすべき性質:
 * - どのティックも有限時間で必ず return する。sleep して常駐しない（design.md §3.6）。
 *   待ちは WAIT という Decision として返し、次のティックに任せる
 * - 同じ入力からは同じ Decision が出る（LLM を呼ばない経路について）。
 *   これが崩れるとループが収束したかを判定できない
 * - どの段が落ちてもティック全体を失敗させない。観測できなかった対象は
 *   unresolved に残り、DECIDE がそれを読んで WAIT を選ぶ
 * - 前ティックまでの Fact と今ティックの Fact が衝突したら、新しい方を採る。
 *   古い観測で ASSESS すると、直したはずの Gap が残り続ける
 */
export async function reconcile(
  _target: ReconcileTarget,
  _deps: ReconcileDeps,
): Promise<ReconcileResult> {
  throw new Error("not implemented");
}
