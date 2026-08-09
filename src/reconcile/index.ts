import { type AssessDeps, assess } from "../assess/index.js";
import { type BudgetUsage, type DecideDeps, decide } from "../decide/index.js";
import type { Decision } from "../domain/action.js";
import { digestOf } from "../domain/digest.js";
import type { Fact, Unresolved } from "../domain/fact.js";
import type { Assessment } from "../domain/gap.js";
import type { Goal } from "../domain/goal.js";
import { type ObserveDeps, type ObserveTarget, observe } from "../observe/index.js";
import { type VerifyDeps, verify } from "../verify/index.js";

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
  /**
   * 観測値のダイジェスト（design.md §4.5 の `Decision.observed_digest`）。
   * DECIDE がループ検知に使うので、呼び出し側ではなくここで作る。
   */
  observedDigest: string;
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
  target: ReconcileTarget,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const criteria = target.goal.acceptance_criteria;

  // OBSERVE。Port が落ちても observe() が unobserved に積むので、ここで throw はしない。
  const observed = await observe(target.observe, deps);
  // 前ティックの Fact を土台にし、今ティックの観測で上書きする。
  // 古い観測で ASSESS すると、直したはずの Gap が残り続ける。
  const observedFacts = mergeFacts(target.carriedFacts, observed.facts);

  // VERIFY。type: fact の criteria は観測結果を参照するので OBSERVE の後に回す。
  const verified = await verify({ setup: target.goal.setup, criteria, facts: observedFacts }, deps);
  const facts = mergeFacts(observedFacts, verified.facts);

  // 「観測できなかった」と「検証できなかった」は DECIDE から見れば同じ「結論が出ていない対象」。
  // 区別は Unresolved.key と reason が持っているので、ここでは並べるだけでよい。
  const unresolved: Unresolved[] = [...observed.unobserved, ...verified.unverified];

  const assessment = assess({ criteria, facts, unresolved }, deps);
  // ループ検知（§7 の max_unchanged_reconciles）が今ティックの観測と
  // 直近の連続を突き合わせる。DECIDE に渡す値なのでここで作る。
  const observedDigest = digestOf(facts);
  const decision = await decide(
    {
      criteria,
      assessment,
      unresolved,
      observedDigest,
      budget: target.goal.budget,
      usage: target.usage,
    },
    deps,
  );

  // 待ちは Decision として返し、次のティックに任せる。ここで sleep しない（design.md §3.6）。
  return { facts, unresolved, assessment, observedDigest, decision };
}

/** 同じキーは後から来た方を採る。キーごとに1件だけ残す */
function mergeFacts(base: readonly Fact[], incoming: readonly Fact[]): Fact[] {
  const merged = new Map<string, Fact>();
  for (const fact of base) {
    merged.set(fact.key, fact);
  }
  for (const fact of incoming) {
    merged.set(fact.key, fact);
  }
  return [...merged.values()];
}
