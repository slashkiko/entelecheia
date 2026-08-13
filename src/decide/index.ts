import { type Action, actionSchema, type Decision, type WaitReason } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import { type Fact, type Unresolved, verifiedOnly } from "../domain/fact.js";
import {
  criterionFactKey,
  LOCAL_HEAD_SHA_KEY,
  REVIEW_REVIEWED_SHA_KEY,
  REVIEW_VERDICT_KEY,
} from "../domain/fact-keys.js";
import type { Assessment, Gap } from "../domain/gap.js";
import { type AcceptanceCriterion, type Budget, durationSeconds } from "../domain/goal.js";
import { isUnavailable, isUsageLimit, resumeAfterOf } from "../domain/port-error.js";

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
  /**
   * 直近まで同じ観測が続いていた回数と、そのダイジェスト。今回のティックは含まない。
   *
   * 材料を `Decision.observed_digest` にしたのは §10-2 の未決を埋めるため。
   * Gap を別に永続化しなくても、同じ観測かどうかは digest で分かる。
   * 今回のダイジェストと突き合わせるので、「直近3回は同じだったが今回は変わった」
   * を進捗として扱える。ここで今回分まで数えてしまうと、それができない。
   */
  trailingDigest: { digest: string | null; count: number };
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
  /**
   * OBSERVE と VERIFY が集めた Fact。前ティックからの引き継ぎを含む。
   *
   * guard の判定には使わない。読むのは「レビュー役を選択肢に載せてよいか」
   * （`reviewedHeadOf`）と「WAIT を選択肢に載せてよいか」
   * （`changesRequestedHeadOf`）の2つだけで、行動を決めるのは変わらず LLM になる。
   */
  facts: readonly Fact[];
  /**
   * **このティックの OBSERVE だけが作った Fact。** 引き継ぎも検証結果も含まない
   * （`ReconcileResult.observedFacts`）。
   *
   * 「いま HEAD がどの commit か」はここから読む。`facts` の側は前ティックの値を
   * 土台にしているので、`LocalRepoPort.snapshot()` が落ちたティックには
   * 前ティックの `local.head_sha` が VERIFIED のまま残る。それを今の HEAD として
   * 読むと、確かめられなかったことが「そうなっている」に化ける（design.md §3.1）。
   *
   * **VERIFIED であることと、このティックで確かめられたことは別になる。**
   * 選択肢を消す判定はどちらも「いま HEAD がこの commit のまま」を根拠にするので、
   * 消す側だけは今ティックの観測に限る。
   */
  observedFacts: readonly Fact[];
  assessment: Assessment;
  unresolved: readonly Unresolved[];
  /** 今ティックの観測ダイジェスト。ループ検知が `usage.trailingDigest` と突き合わせる */
  observedDigest: string;
  budget: Budget;
  usage: BudgetUsage;
}

/** LLM の出力が Zod を通らなかったときの再試行回数（design.md §3.5） */
export const MAX_LLM_RETRIES = 2;

/**
 * 次に取る行動を1つ選ぶ。
 *
 * 満たすべき性質:
 * - 次の5つは LLM を呼ばずに決める（decidedBy: "guard"）
 *     予算・回数・時間の上限に到達         → ESCALATE(budget_exhausted)
 *     読めなかった観測が1件でもある         → ESCALATE(shape_mismatch)
 *     Gap が無く unresolved も無い         → COMPLETE
 *     Gap は無いが unresolved がある       → WAIT
 *     観測が変わらないまま N 回続いた       → ESCALATE(loop_detected)
 *   COMPLETE を LLM に決めさせないのは、§3.1「完了判定は VERIFIED のみ」を
 *   推論で迂回させないため。予算超過とループ検知も、暴走の停止条件を LLM に依存させない
 * - guard の判定順は上のとおり。予算超過は他のどの状態よりも優先する。
 *   shape_mismatch は Gap の有無より先に置く。形が読めていないあいだの観測を
 *   根拠に Actor を起動すると、根拠の無い intent に予算を使う。
 *   ループ検知は Gap が無い場合より後に置く。空回りしていても、満たしているなら完了でよい
 * - WAIT の reason は unresolved と criteria から決める
 *     port_failed が1件でもある                  → observation_failed
 *     pending だけで、対応する criterion が human → human_review_pending
 *     pending だけで、それ以外                     → ci_running
 * - それ以外は LlmPort に渡し、戻り値を Zod で検証する。
 *   通らなければ MAX_LLM_RETRIES 回まで再試行し、それでも駄目なら
 *   ESCALATE(invalid_decision)。検証を通らない出力は受け取らない
 * - **レビューをいつ起動するかは guard に持たせない。** 判定は6つ目にせず、
 *   LLM に渡す選択肢の側で表す。criteria に `review.verdict` を書いた Goal では
 *   Fact ができるまで Gap が残るので、行動はどのみち LLM に渡る。
 *   レビュー役の選択肢を出すのも、その criteria を書いた Goal だけにする
 *   （`criteriaAskForReview`）。ただし直近のレビューが現在の HEAD を既に
 *   読んでいるあいだは、同じ commit を2度レビューさせないために選択肢から
 *   レビュー役を外し、外した理由を書く（`reviewedHeadOf`）。**外す条件は
 *   プロンプトだけに置かない。** 同じ2つを受け取り側にも置き、外したはずの
 *   レビュー役を返してきた出力は採用しない。criteria が求めていない Goal の分は
 *   ESCALATE(invalid_decision)、レビュー済みの commit が HEAD のままの分は
 *   再試行を使い切ったら ESCALATE(review_not_converging) で止まる
 * - **WAIT も同じ手で外す。** レビュー役が `changes_requested` を返し、その commit が
 *   まだ HEAD のままなら、待っても変わるものが無い。人間を待つ WAIT を選択肢から
 *   外し、外した理由を書く（`changesRequestedHeadOf`）。ここもプロンプトだけに
 *   置かず、受け取り側にも同じ条件を置く。外したはずの WAIT を返し続けて再試行を
 *   使い切ったら ESCALATE(invalid_decision) で止まる。`review_not_converging` には
 *   数えないし、新しい ESCALATE の理由も足さない
 * - rationale は必ず埋める。§4.5 の Decision テーブルに残す
 */
export async function decide(target: DecideTarget, deps: DecideDeps): Promise<Decision> {
  // 1 回だけ読む。同じ判断に含まれる時刻を揃える。
  const decidedAt = deps.now().toISOString();
  const guard = (action: Action, rationale: string): Decision => ({
    decidedAt,
    action,
    rationale,
    decidedBy: "guard",
  });

  // 1. 予算超過。暴走の停止条件を LLM の判断に依存させない（design.md §7）ので、
  //    満たしている・満たしていないより先に見る。
  const exhausted = exhaustedBudget(target.budget, target.usage);
  if (exhausted !== null) {
    return guard(
      { type: "ESCALATE", reason: "budget_exhausted" },
      `stopping: a budget limit was reached: ${exhausted}`,
    );
  }

  // 2. 届いたが読めなかった観測がある。待っても直らないので、待たずに人間を呼ぶ。
  //    停止条件なので LLM には決めさせない（design.md §7）。
  //
  //    Gap の有無より先に置く。形が読めていないあいだの観測を根拠に Actor を
  //    起動すると、根拠の無い intent に予算を使う。予算の枯渇より後に置くのは、
  //    どの理由より先に止まるのが予算だから（既存の guard の順序を変えない）。
  //
  //    port_failed は巻き込まない。届かなかった失敗は待てば直りうるので、
  //    これまでどおり下の WAIT(observation_failed) に落とす。混在していれば
  //    1件でも「待っても直らない」がある側を採る。
  const mismatched = target.unresolved.filter((u) => u.reason === "shape_mismatch");
  if (mismatched.length > 0) {
    return guard(
      { type: "ESCALATE", reason: "shape_mismatch" },
      // 何が読めなかったかを残す。人間が直す先は detail からしか読めない。
      `${mismatched.length} observation(s) arrived but could not be read. Waiting will not fix them, so stopping: ${describeUnresolved(mismatched)}`,
    );
  }

  // 3. Gap が無い場合。完了判定は VERIFIED な Fact のみで行う（design.md §3.1）ため、
  //    COMPLETE と WAIT の選び分けは LLM に委ねない。
  //    satisfied ではなく gaps を見るのは、両者がずれた入力を渡されても
  //    「Gap が残っているのに完了」を作らないため。
  if (target.assessment.gaps.length === 0) {
    if (target.unresolved.length === 0) {
      return guard(
        { type: "COMPLETE" },
        "every criterion is satisfied by VERIFIED Facts, and nothing is left unresolved",
      );
    }

    const reason = waitReason(target);
    return guard(
      { type: "WAIT", reason, resumeAfter: null },
      `No Gap remains, but ${target.unresolved.length} target(s) are still unresolved (${reason}): ${describeUnresolved(target.unresolved)}`,
    );
  }

  // 4. 空回りの検知（design.md §7 / §10-2）。Gap が無い場合より後に置く。
  //    空回りしていても、満たしているなら完了でよい。
  //    停止条件なので LLM には決めさせない。判断するのは guard だけ。
  const unchanged = unchangedReconciles(target);
  if (unchanged >= target.budget.max_unchanged_reconciles) {
    return guard(
      { type: "ESCALATE", reason: "loop_detected" },
      `stopping: the observation stayed unchanged for ${unchanged}/${target.budget.max_unchanged_reconciles} reconciles`,
    );
  }

  // 5. Gap がある。どう埋めるかは状況依存なので LlmPort に委ねる。
  return await askLlm(target, deps, decidedAt);
}

/**
 * 上限に到達した項目を1つ返す。到達していなければ null。
 *
 * 「到達」を >= で判定する。max_actor_runs: 10 なら 10 回目を終えた時点で止める。
 */
function exhaustedBudget(budget: Budget, usage: BudgetUsage): string | null {
  if (usage.actorRuns >= budget.max_actor_runs) {
    return `actor runs ${usage.actorRuns}/${budget.max_actor_runs}`;
  }
  if (usage.reconciles >= budget.max_reconciles) {
    return `reconciles ${usage.reconciles}/${budget.max_reconciles}`;
  }
  if (usage.consecutiveFailures >= budget.max_consecutive_failures) {
    return `consecutive failures ${usage.consecutiveFailures}/${budget.max_consecutive_failures}`;
  }

  const limit = durationSeconds(budget.max_wall_clock);
  if (limit === null) {
    // goalSchema を通っていれば起きない。解釈できない上限を「上限なし」と読むと
    // 停止条件が黙って消えるので、人間を呼ぶ側に倒す。
    return `cannot parse max_wall_clock: ${budget.max_wall_clock}`;
  }
  if (usage.elapsedSeconds >= limit) {
    return `elapsed time ${usage.elapsedSeconds}s/${budget.max_wall_clock}`;
  }

  return null;
}

/**
 * 今回を含めて、観測が変わらないまま何回続いたか。
 *
 * 今ティックのダイジェストが直近の連続と違えば 1 に戻す。
 * 「3回同じだったが今回は変わった」を空回りと読むと、進んだ直後に止めてしまう。
 */
function unchangedReconciles(target: DecideTarget): number {
  const trailing = target.usage.trailingDigest;
  return trailing.digest === target.observedDigest ? trailing.count + 1 : 1;
}

/**
 * 待ちの理由を決める。
 *
 * port_failed を最優先にするのは、観測できていない状態で「承認待ち」と決めつけると
 * 状態を取り違えるため。GitHub が落ちているだけかもしれない。
 */
function waitReason(target: DecideTarget): WaitReason {
  // 観測が成立していない理由は、届かなかった（port_failed）と
  // 届いたが読めなかった（shape_mismatch）の2つある。どちらも「観測できて
  // いない」ので、承認待ちや CI 待ちより先に倒す。
  //
  // shape_mismatch は上の guard が ESCALATE で先に止めるので、実際にはここへ
  // 来ない。それでも集合に残してあるのは、落とすと ci_running に化けるため。
  // 恒久的なスキーマ不一致が「CI 実行待ち」を名乗り、Gap ゼロの WAIT はループ
  // 検知より手前で return するので、予算に当たるまでそのラベルで回り続ける。
  // 判定順を動かしたときに、その壊れ方へ静かに戻らないようにしておく。
  const unobservable = new Set(["port_failed", "shape_mismatch"]);
  if (target.unresolved.some((u) => unobservable.has(u.reason))) {
    return "observation_failed";
  }

  // pending の中身は unresolved の reason だけでは分からない。
  // 人間の承認待ちか CI 待ちかは criteria の verification 形式で分かれる。
  const humanKeys = new Set(
    target.criteria
      .filter((c) => c.verification.type === "human")
      .map((c) => criterionFactKey(c.id)),
  );
  if (target.unresolved.some((u) => humanKeys.has(u.key))) {
    // 待つ相手が人間であることを語の側に書く。`review_pending` は
    // 「controller のレビュー役の結論待ち」とも読めたが、レビュー役は ACT で
    // 同期に走るので待つ状態が無く、その読みに与える語も要らない。
    return "human_review_pending";
  }

  return "ci_running";
}

function describeUnresolved(unresolved: readonly Unresolved[]): string {
  return unresolved.map((u) => `${u.key}(${u.reason}): ${u.detail}`).join(" / ");
}

/**
 * プロンプト用に unresolved を並べる。Gap に現れる分は detail を落とす。
 *
 * `type: human` の criterion が pending のとき、verify は prompt 全文を
 * `Unresolved.detail` に積む。assess の unknownDetail() はそれを Gap の detail に
 * 丸ごと埋め込むので、そのまま並べると同じ数十行がプロンプトに2回入る。
 *
 * 2つのセクションは重なり方が非対称になっている。criterion に紐づく unresolved
 * （key が `criteria.<id>.passed`）は必ず対応する Gap があり、detail ごとそちらに
 * 現れる。観測レベルの unresolved（`github.ci` の port_failed など）は Gap には
 * 現れず、このセクションが唯一の置き場になる。したがって落としてよいのは前者だけ。
 *
 * 判断材料の全文は Gap 側に一本化する。あちらは kind が付いていて、LLM が
 * ACT と VERIFY を選び分ける材料になる。どの criterion が pending かは
 * key と reason が残るのでこちらからも読める。
 */
function describeUnresolvedForPrompt(
  unresolved: readonly Unresolved[],
  gaps: readonly Gap[],
): string {
  const inGaps = new Set(gaps.map((gap) => criterionFactKey(gap.criterionId)));
  return unresolved
    .map((u) =>
      inGaps.has(u.key) ? `${u.key}(${u.reason})` : `${u.key}(${u.reason}): ${u.detail}`,
    )
    .join(" / ");
}

/**
 * LLM が選んでよい行動。ここに無いものは受け取らない。
 *
 * COMPLETE と ESCALATE を除くのは、収束と停止の判定を推論で迂回させないため。
 * COMPLETE は design.md §3.1 の「完了判定は VERIFIED のみで行う」、
 * ESCALATE は §7 の「暴走の停止条件を LLM の判断に依存させない」にあたる。
 *
 * ESCALATE を最初から閉じていなかったのは、`llmActionSchema` が COMPLETE だけを
 * 弾いていたため。実際に全周させたところ、reconcile の2回目で LLM が
 * `ESCALATE(loop_detected)` を返し、ループしていないのに採用された。
 * `budget_exhausted` も同じ口から入る。どちらも guard が持つべき判断になる。
 *
 * guard 側から `loop_detected` を出す実装は下の `unchangedReconciles()` にある。
 * ここで閉じるのは LLM 側の口で、実際に停止させるのは guard になる（design.md §10-2）。
 */
/**
 * 行動の種類ごとに、LLM が選んでよいかを1つずつ決める。
 *
 * `Set<string>` ではなく `Record<Action["type"], boolean>` にしてあるのは、
 * ここが「LLM に何を決めさせないか」の境界そのものだから。文字列の集合だと、
 * `"REPLANN"` のような打ち間違いが黙って合法な行動を1つ消し、`actionSchema` に
 * 行動を1つ足してもコンパイルが通ってしまう。増えた行動は既定で拒否されるので、
 * 壊れ方は「安全側に倒れて静かに動かない」になり、気づくのが遅れる。
 *
 * mapped type にすると、行動を足した時点で「LLM に選ばせるか」を書くまで
 * ビルドが通らない。判断を忘れる余地を型で消す。
 * `src/adapters/claude.ts` の `DENIED_TOOLS` が同じ形をしている。
 */
const LLM_MAY_CHOOSE: Record<Action["type"], boolean> = {
  // guard が決める。design.md §3.1 と §7。
  COMPLETE: false,
  ESCALATE: false,
  // Gap の埋め方は LLM に委ねる。
  ACT: true,
  VERIFY: true,
  WAIT: true,
  REPLAN: true,
};

const LLM_ACTIONS = Object.entries(LLM_MAY_CHOOSE)
  .filter(([, allowed]) => allowed)
  .map(([type]) => type);

const llmActionSchema = actionSchema.refine((action) => LLM_MAY_CHOOSE[action.type], {
  message: `The LLM may only choose ${LLM_ACTIONS.join(" / ")}. COMPLETE and ESCALATE are decided by the guard`,
});

/**
 * LlmPort に委ねる。戻り値は必ず Zod で検証し、通らなければ受け取らない（design.md §3.5）。
 * 失敗した理由は次の prompt に載せる。同じ誤りを繰り返させても回数を消費するだけなので。
 */
async function askLlm(
  target: DecideTarget,
  deps: DecideDeps,
  decidedAt: string,
): Promise<Decision> {
  const failures: string[] = [];
  // その Goal がレビューの結論を criteria で求めているか。求めていなければ
  // レビュー役は選択肢に無く、返ってきても採用しない。
  const asksForReview = criteriaAskForReview(target.criteria);
  // レビュー役を選択肢から外しているか。外している場合は、その commit の sha。
  const reviewedHead = reviewedHeadOf(target);
  // WAIT を選択肢から外しているか。外している場合は、指摘の付いた commit の sha。
  const changesRequestedHead = changesRequestedHeadOf(target);
  // 外したはずのレビュー役を返してきた回数。全試行がこれなら、出力の形が
  // 壊れているのではなく、実装が進まないままレビューだけを回そうとしている。
  let reviewRejections = 0;

  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    let raw: unknown;
    try {
      raw = await deps.llm.chooseAction(
        buildPrompt(target, failures, reviewedHead, changesRequestedHead),
      );
    } catch (error) {
      // 使用量上限だけは名指しで分かる（design.md §10-3）。待てば直るので
      // ESCALATE ではなく WAIT にし、§4.4 の WAITING_EXTERNAL(usage_limit) へ繋ぐ。
      // 再試行しない。上限に当たっている間は何度呼んでも同じで、回数を消費するだけ。
      if (isUsageLimit(error)) {
        return {
          decidedAt,
          action: { type: "WAIT", reason: "usage_limit", resumeAfter: resumeAfterOf(error) },
          rationale: `LlmPort hit its usage limit: ${errorMessage(error)}`,
          decidedBy: "guard",
        };
      }
      // Port 自身が失敗したなら、呼び直しても同じ結果になる。未ログイン・
      // 認証切れ・モデル名の誤りはここに来る。再試行の回数を消費させない。
      if (isUnavailable(error)) {
        return {
          decidedAt,
          action: { type: "ESCALATE", reason: "invalid_decision" },
          rationale: `LlmPort could not be called. Calling it again will not fix that, so no retry: ${errorMessage(error)}`,
          decidedBy: "guard",
        };
      }
      // それ以外は、Port が落ちているのか出力が壊れているのかを区別できない。
      // どちらも「採用できなかった試行」として同じ回数制限に載せる。
      failures.push(`LlmPort failed: ${errorMessage(error)}`);
      continue;
    }

    const parsed = llmActionSchema.safeParse(raw);
    if (parsed.success) {
      // 選択肢から外したレビュー役を返してきた。Zod は通るが採用しない。
      // 起動してから「読む対象が前回と同じだった」と気づく形にすると、
      // 1回分の予算を使ってから止まることになる。
      //
      // **「書いていない選択肢は選ばれない」を根拠に、受け取り側を空にしない。**
      // 同じファイルの `LLM_MAY_CHOOSE` が、その油断で一度焼かれた記録を残している
      // （ESCALATE をプロンプトから省いただけで閉じたつもりになり、実走の2回目で
      // `ESCALATE(loop_detected)` が採用された）。選択肢から外す条件は2つあるので、
      // 受け取り側にも同じ2つを置く。
      if (isReviewAct(parsed.data)) {
        // 1. criteria がレビューの結論を求めていない Goal。
        //    この経路が空いていると、レビュー役の Run が1つできた時点で
        //    `review.*` の pending が積まれ、Gap ゼロの Goal では guard の3番目が
        //    WAIT を返して LLM が呼ばれなくなる。`latest()` は同じ Run を返し続けるので
        //    pending は自力で消えず、予算が尽きるまで抜けられない
        //    （`criteriaAskForReview` の注記に同じことが書いてある）。
        if (!asksForReview) {
          failures.push(
            "An ACT with the review role cannot be chosen. This Goal's criteria ask for neither review.verdict nor review.reviewed_sha, so launching the review role fills no Gap",
          );
          continue;
        }

        // 2. 直近のレビューが現在の HEAD を既に読んでいる。
        if (reviewedHead !== null) {
          reviewRejections += 1;
          failures.push(
            `An ACT with the review role cannot be chosen. The latest review already read the current HEAD (${reviewedHead}), and the implementation has not moved a single line. Do not review the same commit twice`,
          );
          continue;
        }
      }

      // 選択肢から外した WAIT を返してきた。こちらの条件は1つで、
      // 「レビュー役が変更を求め、その commit がまだ HEAD のまま」になる。
      //
      // 外しているのは WAIT という行動そのものなので、reason は見ない。
      // 待つ相手を人間から CI に付け替えても、実装が1行も進んでいない事実は
      // 変わらず、次のティックも同じ観測から始まる。
      if (parsed.data.type === "WAIT" && changesRequestedHead !== null) {
        failures.push(
          `WAIT cannot be chosen. The review role returned changes_requested for the current HEAD (${changesRequestedHead}), so waiting changes nothing. Choose an ACT that fixes the findings`,
        );
        continue;
      }

      const action = withoutLlmResumeAfter(parsed.data);
      return {
        decidedAt,
        action,
        rationale: `${target.assessment.gaps.length} Gap(s) remain, so the choice went to LlmPort and ${describeAction(action)} was adopted`,
        decidedBy: "llm",
      };
    }

    failures.push(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  // 全試行がレビュー役だったなら、出力の形が壊れているのではない。実装が
  // 進まないままレビューだけを回そうとしている状態で、止めた理由を読む人間には
  // 別のものとして届く必要がある（`invalid_decision` に畳まない）。
  //
  // 数えるのは 2 の拒否（レビュー済みの commit が HEAD のまま）だけにする。
  // criteria がレビューを求めていない Goal で拒否した分は数えない。あちらには
  // レビューの往復そのものが無く、起きているのは「選択肢に無い行動を返してきた」
  // ——COMPLETE や ESCALATE を返してきたのと同じこと——なので、
  // `invalid_decision` の側で止まるのが正しい。理由の文言は failures に残る。
  if (reviewRejections === MAX_LLM_RETRIES + 1) {
    return {
      decidedAt,
      action: { type: "ESCALATE", reason: "review_not_converging" },
      rationale: `The implementation has not moved, yet all ${reviewRejections} attempts tried to review an already-reviewed commit (${reviewedHead}). Reviewing the same commit twice fills no Gap`,
      decidedBy: "guard",
    };
  }

  // 採用できる出力が出なかった。捏造して進めるより人間を呼ぶ。
  // 判断したのは LLM ではなくこの guard なので decidedBy は "guard" にする。
  return {
    decidedAt,
    action: { type: "ESCALATE", reason: "invalid_decision" },
    rationale: `None of the ${MAX_LLM_RETRIES + 1} LlmPort outputs could be adopted: ${failures.join(" / ")}`,
    decidedBy: "guard",
  };
}

/**
 * レビュー役を選択肢から外すか。外すなら、既に読まれている commit の sha を返す。
 *
 * 実装役の作業ツリーの HEAD（`local.head_sha`）と、直近のレビューが読んだ commit
 * （`review.reviewed_sha`）が一致しているあいだは、レビューを回しても読む対象が
 * 前回と同じになる。「レビュー → レビュー → レビュー」と回る経路を構造として塞ぐ。
 *
 * **この照合が成立するのは、レビュー役が実装役と同じ作業ツリーを見るから**になる
 * （`worktreeNameFor`）。別の作業ツリーに分けると、レビュー役の HEAD は base から
 * 動かないので `local.head_sha` と二度と一致しない。
 *
 * どちらかが観測できていなければ外さない。確かめられなかったことを
 * 「同じ commit だ」と読むと、レビューが必要なティックで選択肢が消える。
 * 見るのは VERIFIED な Fact だけで、推論で選択肢を消さない（design.md §3.1）。
 *
 * **`local.head_sha` は今ティックの観測（`target.observedFacts`）からしか読まない。**
 * VERIFIED であることは「このティックで確かめられた」ことを意味しない。`facts` は
 * 前ティックの Fact を土台にしているので、`LocalRepoPort.snapshot()` が落ちた
 * ティックには前ティックの head が VERIFIED のまま残り、上の「確かめられなければ
 * 外さない」が成立しなくなる。
 *
 * 2つの材料で出どころを分けているのは、腐り方が違うため。「commit X を読んだ
 * レビューがこう結論した」は後から変わらないので `facts` の繰り越しで足りる。
 * 「X がまだ HEAD だ」は Actor が push するたびに変わるので、今ティックの観測を要る。
 *
 * 外さない側に倒れたティックでは、同じ commit をもう一度レビューさせる出力が
 * 通りうる。予算1回分の代償になるが、確かめていない一致を根拠に選択肢を消して
 * `ESCALATE(review_not_converging)` まで進む方が重い。
 */
function reviewedHeadOf(target: DecideTarget): string | null {
  const reviewed = verifiedOnly(target.facts).find((f) => f.key === REVIEW_REVIEWED_SHA_KEY);
  const head = verifiedOnly(target.observedFacts).find((f) => f.key === LOCAL_HEAD_SHA_KEY);
  if (reviewed === undefined || head === undefined || reviewed.value !== head.value) {
    return null;
  }
  return String(head.value);
}

/**
 * WAIT を選択肢から外すか。外すなら、指摘の付いた commit の sha を返す。
 *
 * レビュー役が `changes_requested` を返し、その commit がまだ HEAD のままなら、
 * 待って変わるものが何も無い。指摘を直せるのは実装役だけで、人間の承認も CI も
 * この状態を先へ進めない。それでも DECIDE は `WAIT` を選び続けていた（issue #61）。
 *
 * 待つ相手として名前を与えられるものが無いので、reason を足すのではなく WAIT
 * そのものを外す。`reviewedHeadOf` が「同じ commit を2度レビューさせない」ために
 * レビュー役を外すのと同じ手になる。
 *
 * 判定は `reviewedHeadOf`（レビューが現在の HEAD を読んでいる）に verdict の
 * 一致を重ねたもので、見るのは VERIFIED な Fact だけになる。推論で選択肢を
 * 消さない（design.md §3.1）。確かめられていない `changes_requested` を根拠に
 * WAIT を消すと、レビューが走っていない Goal で人間を待つ手段が無くなる。
 *
 * **HEAD の一致は今ティックの観測に限る**（`reviewedHeadOf`）。VERIFIED な Fact
 * だけを見ても、繰り越した `local.head_sha` を今の HEAD として読めば同じ穴が開く。
 * 1ティックは OBSERVE → ACT の順なので、実装役が走ったティックの `reviewed_sha` と
 * `local.head_sha` は同じ sha を指す。次のティックで local の観測が落ちれば、
 * 繰り越した head は必ず reviewed_sha と一致し、**そのティックで選びたい
 * `WAIT(observation_failed)` が消える。**
 *
 * これは guard ではない。`decide()` の 1〜4 は5つのままで、完了判定の境界には
 * 触れない。ここが決めるのは LLM に渡す行動の範囲だけになる。
 */
function changesRequestedHeadOf(target: DecideTarget): string | null {
  const reviewedHead = reviewedHeadOf(target);
  if (reviewedHead === null) {
    return null;
  }
  const verdict = verifiedOnly(target.facts).find((f) => f.key === REVIEW_VERDICT_KEY);
  return verdict?.value === "changes_requested" ? reviewedHead : null;
}

/** レビュー役として Actor を起動する ACT か */
function isReviewAct(action: Action): boolean {
  return action.type === "ACT" && action.role === "review";
}

/**
 * LLM が返した WAIT から resumeAfter を落とす。
 *
 * 「いつまで寝るか」も停止条件の一種で、遠い未来を返されれば Goal を
 * 無期限に止められる。LLM に閉じているのが行動の種類だけで、待つ長さは
 * 自由に決められる状態は、§7 の「停止条件を LLM の判断に依存させない」と噛み合わない。
 * resumeAfter を埋めてよいのは、使用量上限のリセット時刻を Port から
 * 受け取ったときだけになる（design.md §10-3 / §10-5）。
 */
function withoutLlmResumeAfter(action: Action): Action {
  return action.type === "WAIT" ? { ...action, resumeAfter: null } : action;
}

/**
 * LLM に渡すプロンプトを組み立てる。
 *
 * `reviewedHead` が入っているティックは、選べる行動からレビュー役を外す。
 * **黙って消さない。** 外した理由と、その commit の sha を書く。書いていない
 * 選択肢は選ばれないが、なぜ選べないかが読めないと、LLM も人間も
 * 「レビューを回せば埋まる Gap」を前にして同じ出力を繰り返す。
 *
 * criteria がレビューの結論を求めていない Goal では、レビュー役の行そのものを
 * 出さない（`criteriaAskForReview`）。
 *
 * `changesRequestedHead` が入っているティックは、同じ手で WAIT を外す
 * （`waitActionLines`）。
 *
 * **`intent` を英語で書かせるのは、ここに差し込む材料が何語でも変わらない。**
 * criteria の description も Gap の detail も宣言部（`.goals/*.yaml`）から来るので、
 * このリポジトリでは日本語になる。何も言わなければモデルはそれに引きずられて
 * 日本語の `intent` を返すが、その文字列は PR 進捗コメントの `###` 見出し
 * （`commentBody`、src/publish/index.ts）と `decidedBy: "llm"` の rationale
 * （`describeAction`）にそのまま載る。**英語で読む人が最初に見る1行**になるので、
 * 宣言部の言語とは切り離す。
 */
function buildPrompt(
  target: DecideTarget,
  failures: readonly string[],
  reviewedHead: string | null,
  changesRequestedHead: string | null,
): string {
  const criteria = target.criteria
    .map((c) => `- ${c.id} (${c.verification.type}): ${c.description}`)
    .join("\n");
  const gaps = target.assessment.gaps
    .map((g) => `- ${g.criterionId} [${g.kind}] ${g.detail}`)
    .join("\n");
  const unresolved =
    target.unresolved.length === 0
      ? "- none"
      : `- ${describeUnresolvedForPrompt(target.unresolved, target.assessment.gaps)}`;

  const sections = [
    "There are Gaps left against the Goal's acceptance criteria. Choose one action to take next.",
    `## Acceptance Criteria\n${criteria}`,
    `## Gap\n${gaps}`,
    `## Targets with no conclusion yet\n${unresolved}`,
    `## Budget remaining\n- actor runs: ${target.usage.actorRuns}/${target.budget.max_actor_runs}\n- reconciles: ${target.usage.reconciles}/${target.budget.max_reconciles}\n- consecutive failures: ${target.usage.consecutiveFailures}/${target.budget.max_consecutive_failures}\n- elapsed time: ${target.usage.elapsedSeconds}s/${target.budget.max_wall_clock}`,
    [
      "## Actions you may choose",
      '- {"type":"ACT","intent":"what to make the Actor do"} - fill a Gap by implementing or fixing. Without a role it runs as the implement role',
      ...reviewActionLines(target.criteria, reviewedHead),
      '- {"type":"VERIFY"} - confirm criteria that have not been verified. Use it for Gaps whose kind is unknown',
      ...waitActionLines(changesRequestedHead),
      '- {"type":"REPLAN"} - the current approach will not fill the Gap',
      "",
      "COMPLETE and ESCALATE cannot be chosen. Completion and the stop conditions are decided by the controller.",
      ...waitClosingLines(changesRequestedHead),
      "Write the `intent` in English, whatever language the Goal, its criteria and the Gaps above are written in. It becomes the heading of the PR progress comment.",
      // 出力形式の強制はトランスポートの責務なので adapter 側に一本化する。
      // LlmPort の契約は「戻り値を Zod で検証する」までしか言っていない。
    ].join("\n"),
  ];

  if (failures.length > 0) {
    sections.push(
      `## Why the previous output was not adopted\n${failures.map((f) => `- ${f}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * WAIT に関する行。選べるティックは選択肢として、
 * 選べないティックは外した理由として書く。
 *
 * `reviewActionLines` と同じ手を採る。選べないときに JSON の書式そのものを
 * 出さないのは、書いていない選択肢は選ばれないという性質をここで使っているため。
 * 「形だけ見せて選ぶなと添える」より「選べる形を1つ減らす」方が確実になる。
 *
 * 外した理由には commit の sha と `changes_requested` を書く。黙って消すと、
 * なぜ待てないのかが読めず、LLM も人間も同じ出力を繰り返す。
 */
function waitActionLines(changesRequestedHead: string | null): string[] {
  if (changesRequestedHead === null) {
    return [
      '- {"type":"WAIT","reason":"human_review_pending|ci_running|usage_limit|observation_failed"}',
    ];
  }
  return [
    `- WAIT cannot be chosen this tick. The review role returned changes_requested for the current HEAD (${changesRequestedHead}), so waiting changes nothing. Only the implement role can fix the findings`,
  ];
}

/**
 * 「選べる行動」の末尾に置く、WAIT の使い方の注記。
 *
 * 誘い文句は形の一種なので、WAIT を外したティックには出さない。形だけ消して
 * 「人間を待つべきだと判断したら」を残すと、消したはずの選択肢がそこから読まれる。
 */
function waitClosingLines(changesRequestedHead: string | null): string[] {
  if (changesRequestedHead !== null) {
    return [];
  }
  return [
    "WAIT cannot say how long to sleep. The wake time is decided by the controller too.",
    "If you judge that a human must be waited for, choose WAIT(human_review_pending).",
  ];
}

/**
 * レビュー役に関する行。起動できるティックは選択肢として、
 * 起動できないティックは外した理由として書く。
 *
 * 起動できないときに JSON の書式そのものを出さないのは、書いていない選択肢は
 * 選ばれないという性質をここで使っているため。形だけ見せて「選ぶな」と
 * 添えるより、選べる形を1つ減らす方が確実になる。
 *
 * レビューを求めていない Goal には、外した理由すら書かない。あちらには
 * レビュー役という選択肢が最初から無く、「今回は選べない」と書けば
 * 「いつかは選べる」と読める。
 */
function reviewActionLines(
  criteria: readonly AcceptanceCriterion[],
  reviewedHead: string | null,
): string[] {
  if (!criteriaAskForReview(criteria)) {
    return [];
  }
  if (reviewedHead === null) {
    return [
      '- {"type":"ACT","role":"review","intent":"what to read and how to judge it"} - launch a separate Actor as the review role. It only reads and cannot write, so this alone does not advance the implementation',
    ];
  }
  return [
    `- An ACT with the review role cannot be chosen this tick. The latest review already read the current HEAD (${reviewedHead}), and the implementation has not moved a single line. Do not review the same commit twice`,
  ];
}

/**
 * その Goal が criteria でレビューの結論を要求しているか。
 *
 * **レビュー役を起動できるかどうかを、ここで criteria に紐づける。**
 * 読むのは2箇所で、プロンプトに選択肢を出すか（`reviewActionLines`）と、
 * 返ってきた ACT を採用するか（`askLlm`）になる。前者だけに置くと、
 * 「書いていない選択肢は選ばれない」に受け取り側を預けたことになる。
 *
 * 宣言部は「レビューをいつ起動するかは criteria が作る Gap で決まる」と
 * 書いているが、Gap は LLM を動機づけるだけで起動を絞りはしない。選択肢を
 * 無条件に出すと、`review.verdict` を1文字も書いていない Goal でもレビュー役を
 * 起動でき、Actor 実行1回分の予算が消える。
 *
 * それだけでは済まない。レビュー役の Run が1つでもできると、その最終メッセージが
 * 読めなかったティックは `review.*` が `pending` として `unresolved` に積まれる。
 * Gap がゼロの Goal では guard の3番目が WAIT を返して LLM が呼ばれず、
 * 「レビューをもう一度回す」という選択そのものができない。`latest()` は同じ Run を
 * 返し続けるので pending は自力で消えず、予算が尽きるまで WAIT が続く。
 * criteria に書いた Goal は verdict が欠ければ Gap が立って LLM に渡るので
 * 自力で回復でき、**書いていない Goal だけが完了に届かなくなる**という逆転が起きる。
 * 起動の口を criteria に閉じておけば、その Run が最初から存在しない。
 *
 * これは guard の判定ではない。guard は5つのままで、レビューの結論を1つも見ない
 * （`decide()` の1〜4）。ここが決めるのは、LLM に渡す行動の範囲——見せる選択肢と、
 * 受け取る出力——だけになる。どちらも Gap が LLM に渡ったあとの話で、
 * 完了判定の境界には触れない。
 */
function criteriaAskForReview(criteria: readonly AcceptanceCriterion[]): boolean {
  const reviewKeys = new Set<string>([REVIEW_VERDICT_KEY, REVIEW_REVIEWED_SHA_KEY]);
  return criteria.some(
    (criterion) =>
      criterion.verification.type === "fact" && reviewKeys.has(criterion.verification.key),
  );
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "ACT":
      // role も残す。`ent show` と Decision テーブルから、実装役とレビュー役の
      // どちらを起動したティックだったかを読み分けられるようにする。
      return `ACT(${action.role ?? "implement"}: ${action.intent})`;
    case "WAIT":
      return `WAIT(${action.reason})`;
    case "ESCALATE":
      return `ESCALATE(${action.reason})`;
    default:
      return action.type;
  }
}
