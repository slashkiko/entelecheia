import type { Decision } from "../domain/action.js";
import type { Unresolved } from "../domain/fact.js";
import type { Assessment } from "../domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../domain/goal.js";

/**
 * これまでに使った分。Goal の budget と突き合わせて上限判定に使う。
 * 永続化は別 Goal なので、いまは呼び出し側が組み立てて渡す。
 */
export interface BudgetUsage {
  actorRuns: number;
  reconciles: number;
  consecutiveFailures: number;
  /** Goal を ACTIVE にしてからの経過秒数 */
  elapsedSeconds: number;
}

/**
 * LLM への口。design.md §3.5 のとおり Actor 層経由に寄せ、依存を1系統にする。
 * 実装は Claude Agent SDK になるが、ここでは知らないままにしておく。
 */
export interface LlmPort {
  /** 構造化出力を求める。戻り値は呼び出し側が Zod で検証する */
  chooseAction(prompt: string): Promise<unknown>;
}

export interface DecideDeps {
  llm: LlmPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

export interface DecideTarget {
  /**
   * WAIT の理由を決めるのに要る。「人間の承認待ち」と「CI 待ち」は
   * unresolved の reason だけでは区別できず、criteria の verification 形式で分かれる。
   */
  criteria: readonly AcceptanceCriterion[];
  assessment: Assessment;
  unresolved: readonly Unresolved[];
  budget: Budget;
  usage: BudgetUsage;
}

/** LLM の出力が Zod を通らなかったときの再試行回数（design.md §3.5） */
export const MAX_LLM_RETRIES = 2;

/**
 * 次に取る行動を1つ選ぶ。
 *
 * 満たすべき性質:
 * - 次の3つは LLM を呼ばずに決める（decidedBy: "guard"）
 *     予算・回数・時間の上限に到達      → ESCALATE(budget_exhausted)
 *     Gap が無く unresolved も無い      → COMPLETE
 *     Gap は無いが unresolved がある    → WAIT
 *   COMPLETE を LLM に決めさせないのは、§3.1「完了判定は VERIFIED のみ」を
 *   推論で迂回させないため。予算超過も、暴走の停止条件を LLM に依存させない
 * - guard の判定順は上のとおり。予算超過は他のどの状態よりも優先する
 * - WAIT の reason は unresolved と criteria から決める
 *     port_failed が1件でもある                  → observation_failed
 *     pending だけで、対応する criterion が human → review_pending
 *     pending だけで、それ以外                     → ci_running
 * - それ以外は LlmPort に渡し、戻り値を Zod で検証する。
 *   通らなければ MAX_LLM_RETRIES 回まで再試行し、それでも駄目なら
 *   ESCALATE(invalid_decision)。検証を通らない出力は受け取らない
 * - rationale は必ず埋める。§4.5 の Decision テーブルに残す
 */
export async function decide(_target: DecideTarget, _deps: DecideDeps): Promise<Decision> {
  throw new Error("not implemented");
}
