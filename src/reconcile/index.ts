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
  //
  // 上書きは同じキーが来たときしか起きないので、土台に載せる前に
  // 陳腐化した分を落としておく。詳細は expireStaleFacts のコメント。
  const observedFacts = mergeFacts(
    expireStaleFacts(target.carriedFacts, observed.facts),
    observed.facts,
  );

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

/** PR の head sha。CI の Fact がどのコミットのものかは、これでしか分からない */
const HEAD_SHA_KEY = "github.pr.head_sha";

/** head sha に紐づく観測。sha が変われば、前ティックの値は今の値ではない */
const CI_KEY_PREFIX = "github.ci.";

/**
 * 陳腐化した観測を引き継がない。
 *
 * CI が実行中のあいだ observe は `github.ci.conclusion` の Fact を作らない
 * （conclusion が null なので未観測扱い）。上書きは同じキーが来たときしか
 * 起きないので、前のコミットで観測した `conclusion=success` が head_sha の
 * 変わったあとも生き残る。ティックの順序は reconcile → act なので、Actor が
 * push した次のティックでは「head_sha は新しいのに conclusion は古い success」
 * という状態が必ず一度できる。そこで `type: fact` の criterion が古い evidence で
 * passed になり、新しいコミットの CI を待たずに COMPLETE が出る。
 *
 * 「捏造した観測を作らない」（design.md §3.1）を守るなら、古い観測を今の観測として
 * 使うこの経路も塞ぐ。CI の Fact は head sha に紐づくので、head_sha が違う値で
 * 観測できたときだけ、引き継いだ `github.ci.*` を落とす。
 *
 * 落とす条件を「違う値で観測できた」に限るのは、確かめられなかったことを
 * 「変わった」と読まないため。PR の Port が落ちたティックで CI の結論まで捨てると、
 * 観測の失敗が既に確かめた事実を消すことになる。
 *
 * 今ティックの観測が作った Fact は落とさない。落とすのは引き継いだ分だけになる。
 */
function expireStaleFacts(carried: readonly Fact[], observed: readonly Fact[]): Fact[] {
  const before = carried.find((f) => f.key === HEAD_SHA_KEY);
  const now = observed.find((f) => f.key === HEAD_SHA_KEY);
  // 片方でも観測できていないなら「変わった」とは言えない。確かめた事実を残す。
  if (before === undefined || now === undefined || before.value === now.value) {
    return [...carried];
  }

  return carried.filter((fact) => !fact.key.startsWith(CI_KEY_PREFIX));
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
