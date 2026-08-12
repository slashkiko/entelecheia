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
  /**
   * **このティックの OBSERVE だけが作った Fact。** 引き継ぎも検証結果も含まない。
   *
   * `facts` は前ティックの Fact を土台にして今ティックの観測で上書きしたものなので、
   * Port が落ちたティックには前ティックの値が VERIFIED のまま残る（陳腐化して
   * 落ちるのは `expireStaleFacts` が名指ししたキーだけ）。「今この瞬間そうなっている」を根拠に止める
   * 関門がそこを読むと、「確かめられなかった」が「そうなっている」に化ける
   * （design.md §3.1）。今の観測に限りたい読み手のために別に返す。
   *
   * 読み手は2つ。呼び出し側の関門と、DECIDE の `DecideTarget.observedFacts`
   * （選択肢から WAIT とレビュー役を外す判定が「いま HEAD がこの commit のまま」を
   * ここから読む）になる。
   */
  observedFacts: Fact[];
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
  //
  // **名前で `observed.facts` と区別する。** こちらは引き継ぎ込みで、あちらは
  // 今ティックの観測だけになる。両方を `observedFacts` と呼んでいたときに、
  // 「今ティックの観測」を要求する読み手（DECIDE）へ引き継ぎ込みの方が渡っていた。
  const carriedAndObserved = mergeFacts(
    expireStaleFacts(target.carriedFacts, observed.facts),
    observed.facts,
  );

  // VERIFY。type: fact の criteria は観測結果を参照するので OBSERVE の後に回す。
  const verified = await verify(
    { setup: target.goal.setup, criteria, facts: carriedAndObserved },
    deps,
  );
  const facts = mergeFacts(carriedAndObserved, verified.facts);

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
      // 検証結果まで含めた Fact を渡す。DECIDE がここを読むのは
      // 「レビュー役を選択肢に載せてよいか」と「WAIT を選択肢に載せてよいか」の
      // 2点だけで、guard の判定には使わない。
      facts,
      // 今ティックの観測だけを別に渡す。上の `facts` は前ティックの Fact を
      // 土台にしているので、Port が落ちたティックには前ティックの値が VERIFIED の
      // まま残る。「いま HEAD がこの commit のまま」を根拠に選択肢を消す判定が
      // そこを読むと、確かめられなかったことが「そうなっている」に化ける
      // （design.md §3.1 / `ReconcileResult.observedFacts`）。
      observedFacts: observed.facts,
      assessment,
      unresolved,
      observedDigest,
      budget: target.goal.budget,
      usage: target.usage,
    },
    deps,
  );

  // 待ちは Decision として返し、次のティックに任せる。ここで sleep しない（design.md §3.6）。
  return {
    facts,
    observedFacts: [...observed.facts],
    unresolved,
    assessment,
    observedDigest,
    decision,
  };
}

/** PR の head sha。CI の Fact がどのコミットのものかは、これでしか分からない */
const HEAD_SHA_KEY = "github.pr.head_sha";

/** head sha に紐づく観測。sha が変われば、前ティックの値は今の値ではない */
const CI_KEY_PREFIX = "github.ci.";

/** PR そのものを読めたか。読めたティックには必ず作られるので、可否の目印に使える */
const PR_NUMBER_KEY = "github.pr.number";

/** 未解決のレビュースレッドの件数。head sha に紐づかず、時間とともに変わる */
const UNRESOLVED_THREADS_KEY = "github.pr.unresolved_threads";

/**
 * 陳腐化した観測を引き継がない。
 *
 * 上書きは同じキーが来たときしか起きないので、今ティックの観測が作らなかったキーは
 * 前ティックの値が VERIFIED のまま残る。「いま確かめられなかった」が
 * 「いまもそうなっている」に化けるこの経路を、キーごとに塞ぐ。
 *
 * 今ティックの観測が作った Fact は落とさない。落とすのは引き継いだ分だけになる。
 *
 * 条件は独立に評価する。**片方の条件で早期 return しない。** 件数の失効は
 * head_sha が動かないティックでこそ効くので、sha の判定の後ろに置くと、
 * 直したい経路でだけ効かない関門になる。
 */
function expireStaleFacts(carried: readonly Fact[], observed: readonly Fact[]): Fact[] {
  const stale: ((key: string) => boolean)[] = [];
  if (headShaChanged(carried, observed)) {
    stale.push((key) => key.startsWith(CI_KEY_PREFIX));
  }
  if (threadCountUnread(observed)) {
    stale.push((key) => key === UNRESOLVED_THREADS_KEY);
  }

  if (stale.length === 0) {
    return [...carried];
  }
  return carried.filter((fact) => !stale.some((matches) => matches(fact.key)));
}

/**
 * head sha が違う値で観測できたか。引き継いだ `github.ci.*` を落とす条件になる。
 *
 * CI が実行中のあいだ observe は `github.ci.conclusion` の Fact を作らない
 * （conclusion が null なので未観測扱い）。そのため、前のコミットで観測した
 * `conclusion=success` が head_sha の変わったあとも生き残る。ティックの順序は
 * reconcile → act なので、Actor が push した次のティックでは「head_sha は新しいのに
 * conclusion は古い success」という状態が必ず一度できる。そこで `type: fact` の
 * criterion が古い evidence で passed になり、新しいコミットの CI を待たずに
 * COMPLETE が出る。
 *
 * 落とす条件を「違う値で観測できた」に限るのは、確かめられなかったことを
 * 「変わった」と読まないため。PR の Port が落ちたティックで CI の結論まで捨てると、
 * 観測の失敗が既に確かめた事実を消すことになる。
 */
function headShaChanged(carried: readonly Fact[], observed: readonly Fact[]): boolean {
  const before = carried.find((f) => f.key === HEAD_SHA_KEY);
  const now = observed.find((f) => f.key === HEAD_SHA_KEY);
  // 片方でも観測できていないなら「変わった」とは言えない。確かめた事実を残す。
  return before !== undefined && now !== undefined && before.value !== now.value;
}

/**
 * PR そのものは読めたのに、未解決スレッドの件数だけ読めなかったか。
 * 引き継いだ `github.pr.unresolved_threads` を落とす条件になる。
 *
 * **`github.ci.*` とは性質が違うので、sha では判定できない。** CI の conclusion は
 * head sha に紐づき、同じ sha なら不変なので、sha が動かない限り引き継いで安全になる。
 * 未解決スレッドの件数は sha に紐づかない。**bot は新しいコミットが無くても
 * スレッドを立てられる**ので、同じ sha のまま件数だけが変わる。
 *
 * 件数の読み取り（GraphQL）は失敗しても Fact を作らず、`unobserved` も積まない
 * （design.md §4.3）。1ティックだけを見れば criterion は埋まらないが、前ティックで
 * 0 を観測していれば、その 0 が引き継がれて `equals: 0` が passed になる。
 * 1時間前の件数を今の件数として使うのは §3.1 が禁じている「捏造した観測」で、
 * `unobserved` を積まない以上、WAIT でも止まらない。
 *
 * PR ごと読めなかったティックでは落とさない。`headShaChanged` と同じく、
 * 確かめられなかったことを「変わった」と読まないため。そのティックは件数以外も
 * 欠けており、`github.pr` の `port_failed` が WAIT(observation_failed) を立てる。
 */
function threadCountUnread(observed: readonly Fact[]): boolean {
  const readPr = observed.some((f) => f.key === PR_NUMBER_KEY);
  const readCount = observed.some((f) => f.key === UNRESOLVED_THREADS_KEY);
  return readPr && !readCount;
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
