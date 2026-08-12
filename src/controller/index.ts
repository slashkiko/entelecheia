import { join } from "node:path";
import {
  type ActDeps,
  act,
  type RunRecorderPort,
  worktreeBranchFor,
  worktreeNameFor,
} from "../act/index.js";
import type { BudgetUsage } from "../decide/index.js";
import type { Decision, EscalateReason } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import type { Fact, Unresolved } from "../domain/fact.js";
import type { Goal, PublishStep } from "../domain/goal.js";
import { type GoalState, type GoalStatus, isTerminal, nextStatus } from "../domain/goal-state.js";
import {
  actorUsageLimitDecision,
  CONTROLLER_STATE_DB_KEY,
  consecutiveFailuresOf,
  dependencyGate,
  describeClaim,
  describeDependencyGate,
  elapsedSecondsSince,
  guardBaseOf,
  leavesWorkUncommitted,
  machineCriteriaSatisfied,
  observedValue,
  sleepingUntil,
  waitedSeconds,
} from "../domain/guard-rules.js";
import { describeViolations, findViolations } from "../domain/protected-paths.js";
import { type ActorRole, DEFAULT_ACTOR_ROLE, type Run, type RunIntent } from "../domain/run.js";
import {
  pendingReviewCriteria,
  toVerifications,
  type Verification,
} from "../domain/verification.js";
import { type PublishDeps, type PublishHold, publish } from "../publish/index.js";
import { type ReconcileDeps, reconcile } from "../reconcile/index.js";
import type { Store } from "../store/port.js";

/**
 * 1ティックの外側。lease を取り、reconcile を回し、ACT を実行し、結果を書き、
 * 状態を遷移させる。書き込みを ACT の後に置く理由は design.md §3.6。
 *
 * reconcile と act 自体は変更しない。あの2つを純粋に保ったまま、
 * 副作用と永続化をこの層に集める（design.md §8）。
 */

/**
 * lease を延長してよい回数の上限。
 *
 * 既定の leaseSeconds は 300 で延長は半分ごとなので、2.5 分に1回になる。
 * 96 回で約4時間。design.md §9 の実測では ACT の1ティックが数十分だったので、
 * 正常なティックがここに当たることはない。当たるのは刺さったときだけで、
 * そのときは lease を手放して他のワーカーに渡す方がよい。
 */
const MAX_LEASE_RENEWALS = 96;

export interface ControllerDeps
  extends ReconcileDeps,
    Pick<ActDeps, "worktree" | "actor">,
    Pick<PublishDeps, "writer" | "branch" | "report"> {
  store: Store;
  /** lease の所有者。プロセスごとに一意にする */
  owner: string;
  /** lease の有効期間（秒）。プロセスが死んだらこの時間で解放される */
  leaseSeconds: number;
  /** SIGTERM の伝播。走行中の Actor に伝えて kill する */
  signal?: AbortSignal | undefined;
  /**
   * worktree を置くディレクトリ。保護パスの検査で絶対パスを組み立てるのに使う。
   *
   * WorktreePort は名前からパスを決めるが、その規則を controller は知らない。
   * 省略すると Run.worktree（名前）をそのまま基準にするので、Actor が
   * 絶対パスを返す実装では「外に出た」と読んでしまう。実運用では必ず渡す。
   */
  worktreeRoot?: string | undefined;
  /**
   * 次のティックで何が起きるかを、起こす前に見るだけにする（`ent run <slug> --dry-run`）。
   *
   * OBSERVE / VERIFY / ASSESS / DECIDE は本当に回す。模擬すると「配管が繋がって
   * いるか」を確かめる用途に使えなくなる。飛ばすのは副作用の側だけで、
   * ACT・publish・永続化・lease・orphan Run の回収がそれにあたる。
   */
  dryRun?: boolean | undefined;
  /**
   * 観測対象の上書き。`--dry-run` が状態を書かずに `--pr` / `--issue` を効かせるために使う。
   *
   * 通常のティックでは CLI が `setObserveTarget` で永続化してから渡す。dry-run は
   * 書かないので、渡す道がここにしか無い。以前は dry-run でも永続化していて、
   * 覗いたつもりの1回が次の本番ティックの観測先を差し替えていた。
   */
  observeOverride?: { prNumber?: number; issueNumber?: number } | undefined;
  /**
   * 人間に届く1行。commit できなかったような、止めるほどではないが黙ると
   * 追えなくなることを出す。省略すると何も出ない。
   */
  log?: ((message: string) => void) | undefined;
}

/**
 * このティックが観測する PR と Issue。
 *
 * tick と preview の両方が使う。片方だけに上書きを足すと、dry-run が
 * 本番と違う対象を観測することになる。
 */
function observeTargetOf(
  state: GoalState,
  deps: ControllerDeps,
): { prNumber: number | null; issueNumber: number | null } {
  return {
    prNumber: deps.observeOverride?.prNumber ?? state.prNumber,
    issueNumber: deps.observeOverride?.issueNumber ?? state.issueNumber,
  };
}

export interface TickResult {
  /** lease を取れずスキップした場合は false */
  ran: boolean;
  /**
   * 回さなかった理由。回した場合は null。
   *
   * 「寝ている」「他のワーカーが処理中」「終端」はどれも ran: false になる。
   * 理由を持たせないと、cron から回したときにログから区別できない。
   */
  skipped: string | null;
  /** interrupted で回収した orphan Run の件数 */
  reclaimed: number;
  decision: Decision | null;
  /** ACT を実行した場合の Run。実行しなければ null */
  run: Run | null;
  /** ティック後の Goal の状態 */
  status: GoalStatus;
  /**
   * 宣言（`policies.publish`）で publish を止めた場合だけ入る。止めていなければ**キーごと入らない**。
   *
   * ティックを叩くのは人間だけではない。エージェントが回している構成では、controller が
   * 作らなかった PR をそのエージェントが代わりに立てる。そのためには「作らなかった」と
   * 「作るなら head と base はこれ」が、`decision.rationale` の散文を読まずに分かる
   * 必要がある。理由と段は `decision.action.reason` にも出るが、あちらは
   * `EscalateReason` の1語なので押す先を持てない。
   *
   * 止めていないティックで `null` を置かないのは、`dryRun` と同じ理由になる。
   * 既存の `.goals/*.yaml`（宣言を1本も書いていない）を回している側の出力を変えない。
   */
  publishHold?: PublishHold;
  /** dry-run で回した場合だけ true。通常のティックでは入らない */
  dryRun?: boolean;
  /**
   * 書いていたら移っていた状態。dry-run のときだけ入る。
   *
   * 状態を動かさないので、動かしていたらどうなったかを別に返す。
   */
  wouldTransitionTo?: GoalStatus;
  /**
   * 観測と検証の結果。dry-run のときだけ入る。
   *
   * DB に残さないので、ここで返さなければ読む手段が無い。
   */
  observed?: {
    facts: readonly Fact[];
    unresolved: readonly Unresolved[];
    verifications: readonly Verification[];
  };
}

/**
 * reconcile の1ティックを回して return する。sleep も常駐もしない（design.md §3.6）。
 *
 * 満たすべき性質:
 * - lease を取れなければ何もせずに return する。1 Goal につき reconcile は同時に1つ
 * - lease を取ったら、どの経路でも最後に解放する
 * - starting のまま残った Run の回収を reconcile より先に置く。
 *   前のプロセスが死んだまま残った Run を新しい観測より先に確定させないと、
 *   同じ Run が二重に数えられる
 * - 終端状態（COMPLETED / FAILED / ABANDONED）の Goal は回さない
 * - Fact と unresolved と Decision を書く。unresolved を落とさない（design.md §3.1）
 * - action が ACT のときだけ act を呼ぶ。write-ahead は act 側が持つ
 * - 前ティックの Fact を store から読んで carriedFacts に渡す
 * - 中断されたら、走行中の Actor に伝播し、lease を解放して return する
 * - **ティックの途中で lease を失ったら、snapshot / verifications / decision /
 *   status を1つも書かずに return する。** 期限が切れた lease は別のワーカーが
 *   奪えるので、lease は「取れた」ではなく「まだ持っている」を確かめ続ける対象になる。
 *   失った側が書き切ると、書き込む先はいま別のワーカーが進めている Goal の行になり、
 *   ダイジェストの連続（countTrailingDigest）も reconciles も2つのプロセス分が混ざる。
 *   ループ検知と予算はそこを根拠にしているので、上限の判定が静かにずれる
 * - 失ったと分かった時点で Actor を起動しない。予算を使ってから気づいても遅い。
 *   走行中なら中断を伝える。放置すると、奪ったワーカーの Actor と同じ worktree を
 *   2つのプロセスが同時に書く
 * - 失っても throw しない。`ran: false` と理由を返し、次のティックに任せる。
 *   他人の lease は解放しない（`releaseLease` が owner で弾く）
 */
export async function tick(goal: Goal, deps: ControllerDeps): Promise<TickResult> {
  const goalId = goal.goal.id;
  const state = deps.store.getState(goalId);

  const idle = (status: GoalStatus, skipped: string): TickResult => ({
    ran: false,
    skipped,
    reclaimed: 0,
    decision: null,
    run: null,
    // 終端と休眠の分岐は dry-run の分岐より前にあるので、ここを通ると
    // dryRun が付かなかった。SKILL.md は「--dry-run なら必ず dryRun: true が付く」と
    // 書いており、それを見て preview と本番を区別するエージェントが取りこぼす。
    ...(deps.dryRun === true ? ({ dryRun: true } as const) : {}),
    status,
  });

  /**
   * ティックの途中で lease を失ったときの戻り値。
   *
   * throw しない。奪われるのは異常ではなく、期限付き所有権（design.md §4.5）が
   * 設計どおりに働いた結果でしかない。次のティックに任せる。
   *
   * status は失う前に読んだものを返す。このティックは書いていないので、
   * 自分が動かした状態は無い。decision も null にする——差し替えの判断まで
   * 済んでいても、書いていないものを「決めた」と報告すると、cron のログから
   * 書かれたと読めてしまう。走った Run だけは、実際に走ったので残す。
   */
  const lost = (status: GoalStatus, reclaimed: number, run: Run | null): TickResult => ({
    ran: false,
    skipped: "lost the lease mid-tick, so nothing is written",
    reclaimed,
    decision: null,
    run,
    status,
  });

  // 終端の Goal を動かし続けると、完了判定が意味を失う。lease も取らない。
  if (state === null) {
    return idle("DRAFT", "the Goal is not registered");
  }
  if (isTerminal(state.status)) {
    return idle(state.status, `terminal state (${state.status}), so the tick is not run`);
  }

  // 使用量上限などで寝ている間は回さない（design.md §4.4 と §10-5）。
  // lease も取らない。取ると、寝ているだけの Goal が他のワーカーを塞ぐ。
  const sleeping = sleepingUntil(state.resumeAfter, deps.now());
  if (sleeping !== null) {
    return idle(state.status, `sleeping until resume_after: ${sleeping}`);
  }

  // 依存する Goal が揃うまで進めない（design.md §10-12）。
  //
  // **lease は取らない。** resume_after と同じ理由で、待っているだけの Goal が
  // 他のワーカーを塞ぐ。並べる本数を決めるのは呼び出し側なので（README
  // 「複数の Goal を同時に回す」）、依存待ちの1本が枠を持ち続けると、
  // 進める側の Goal まで cron の1周で回らなくなる。
  //
  // **`ent start` の入口ではなくここで見る。** あちらで「ACTIVE にしない」形に
  // すると、依存先をまだ start していない順序で宣言を書けなくなる。分解した
  // サブ Goal をまとめて登録する使い方（§10-12）がそれに当たる。
  //
  // 状態は動かさない。ここで書けば止まった理由が DB に残るが、そのためには
  // lease を取ることになり、上の理由と衝突する。理由は `skipped` に載せて
  // `ent run` の出力に出す。
  const gate = dependencyGate(
    goal.goal.depends_on,
    (dependencyId) => deps.store.getState(dependencyId)?.status ?? null,
  );
  const blocked = describeDependencyGate(gate);
  if (blocked !== null) {
    return idle(state.status, blocked);
  }

  // 見るだけのティック。ここから下（lease・回収・永続化・ACT・publish）は
  // すべて書く側なので、分岐は lease を取る前に置く。
  if (deps.dryRun === true) {
    return await preview(goal, state, deps);
  }

  const leaseUntil = (): Date => new Date(deps.now().getTime() + deps.leaseSeconds * 1000);
  if (!deps.store.acquireLease(goalId, deps.owner, leaseUntil(), deps.now())) {
    // 他のワーカーが処理中。今回のティックはスキップする（design.md §4.5）。
    return idle(state.status, "another worker holds the lease");
  }

  // lease を失ったことを、走行中の Actor に伝えるための口。
  //
  // 奪われたと分かっても、ACT を最後まで走らせてよい理由は無い。奪ったワーカーの
  // Actor は同じ worktree（名前は goal.id から決まる）を使うので、放置すると
  // 2つのプロセスが同じ作業ツリーを同時に書く。
  //
  // SIGTERM（deps.signal）と束ねて1本にする。Actor から見れば「止まれ」は
  // どちらも同じ意味で、理由の違いは Run の確定値ではなく controller が返す
  // skipped に出る。
  const leaseLost = new AbortController();
  const actorSignal =
    deps.signal === undefined ? leaseLost.signal : AbortSignal.any([deps.signal, leaseLost.signal]);

  // ティックが走っているあいだ lease を延長し続ける。
  //
  // ACT は Claude Code の実行なので分単位で、design.md §9 の実測では
  // 1ティック目が 1,341,349 tokens だった。leaseSeconds は 300 なので、
  // 延長しないと ACT の途中で期限が切れる。cron から回す構成（§3.6）では、
  // そこで別プロセスが lease を奪い、同じ worktree（名前は goal.id 固定）で
  // 2つの ACT が並行する。稀な競合ではなく、実運用の既定の挙動になっていた。
  //
  // 延長できなかったときは、その戻り値を捨てない。`acquireLease` が false を
  // 返すのは「期限切れの lease を別のワーカーが持っていった」ということなので、
  // ここが奪われたことを知る唯一のタイマー経路になる。以前は戻り値を捨てて
  // いたので、奪われたことが構造上わからなかった。
  //
  // ただし延長の失敗そのもので throw はしない。タイマーのコールバックから
  // throw すると、下の try/finally の外なので clearInterval も releaseLease も
  // 走らないままプロセスが落ちる。lease が期限まで残り、どのワーカーもその Goal を
  // 進められなくなる。延長できなければ期限切れに任せる方が軽い壊れ方になる。
  //
  // 延長には上限を置く。上限が無いと、刺さった ACT や git が lease を無期限に
  // 抱え続け、cron から起動したどのワーカーも引き継げない。プロセスが生きて
  // いるかぎり lease が切れないので、design.md §3.6 の「どのティックも有限時間で
  // return する」が外から見て成立しなくなる。上限に達したら延長をやめ、lease は
  // 期限で切れる。走行中の ACT は続くが、次のティックには別プロセスが入れる。
  //
  // 延長は ACT の窓の中で走る状態 DB への書き込みでもある。関門が見るのは
  // `Store.guardDigest` で、lease の列はその射影から外してある。ここで書いても
  // 関門は動かない（`observedRepoState`）。
  let renewals = 0;
  const heartbeat: NodeJS.Timeout = setInterval(
    () => {
      renewals += 1;
      if (renewals > MAX_LEASE_RENEWALS) {
        clearInterval(heartbeat);
        return;
      }
      try {
        if (!deps.store.acquireLease(goalId, deps.owner, leaseUntil(), deps.now())) {
          leaseLost.abort();
        }
      } catch {
        // 次の延長で取り返せる。取り返せなければ lease は期限で切れる。
        // ここで abort しない。DB を1回読めなかったことと、奪われたことは違う。
      }
    },
    Math.max(1, Math.floor(deps.leaseSeconds / 2)) * 1000,
  );
  // ティックが終わればプロセスは落ちてよい。タイマーで生かし続けない。
  heartbeat.unref?.();

  try {
    // 回収を reconcile より先に置く。前のプロセスが死んだまま残った Run を
    // 新しい観測より先に確定させないと、同じ Run が二重に数えられる。
    const reclaimed = deps.store.reclaimOrphanRuns(
      goalId,
      "the previous tick exited before writing the outcome",
      deps.now().toISOString(),
    );

    // 前のティックのダイジェストは、今回の分を書く前に読む。
    const previousDigest = deps.store.latestDigest(goalId);
    const carriedFacts = deps.store.latestSnapshot(goalId)?.facts ?? [];
    const result = await reconcile(
      {
        goal,
        observe: observeTargetOf(state, deps),
        carriedFacts,
        usage: usageOf(state, goal, deps),
      },
      deps,
    );

    // 観測しているあいだに奪われていないかを、書くより先に確かめる。
    //
    // heartbeat は leaseSeconds / 2 ごとにしか鳴らないので、それより短い
    // ティックはタイマーでは1度も捕まらない。奪われたかどうかは、書く直前に
    // DB へ訊く側を正にする。ここで捕まえれば Actor も起動しないので、
    // 予算を使ってから気づくことにもならない。
    if (!holdsLease(goalId, deps)) {
      return lost(state.status, reclaimed, null);
    }

    // 観測した時刻を控える。Fact と「結論が出なかった対象」は組で書くので、
    // 片方だけ書くと §3.1 が DB 層で再発する。
    //
    // **書くのは ACT の後**にまとめる。ACT は分単位で、そのあいだに lease を
    // 奪われうる。先に書いてしまうと、奪われたと分かった時点では既に他の
    // ワーカーの Goal の行を汚した後になる。それでも observedAt は観測した時刻の
    // ままにする。書いた時刻に寄せると、Fact の時点が ACT のぶんだけ後ろにずれる。
    const observedAt = deps.now().toISOString();
    // ダイジェストは reconcile が作る。DECIDE がループ検知に使う値なので、
    // 副作用のあるこの層で作り直すと、判断に使った値と記録が食い違いうる。
    const digest = result.observedDigest;

    // このティックで controller 自身が作った Run。関門が状態 DB を見るときに、
    // この分だけを射影から外す（`observedRepoState`）。write-ahead と
    // 確定は ACT の窓のちょうど真ん中で書かれるので、外さないと自分の書き込みで
    // 鳴る。**`run` の id を使わずにここへ溜めるのは、Run を書いてから ACT が
    // 失敗した回でも id が要るため**になる。`maybeAct` は `acted: false` の回に
    // null を返すが、行は残る。
    //
    // **id と一緒に、`startRun` に渡した意図そのものを控える。** 射影から行ごと
    // 落とすので、`finishRun` が一度も書かない列——`role` / `intent` / `worktree` /
    // `attempt` / `started_at`——まで観測の外に出る。控えた値と ACT の後に
    // 突き合わせて、そこだけを別の関門で見る（`ownRunDrift`）。
    //
    // **下の `repoBaseline` は、この配列がまだ空のうちに読む。** ベースラインの
    // 時点では Run の行そのものが無いので、空で読んで初めて検査時の射影と
    // 揃う。ここを遅延させる（あとで読み直す形にする）と、ベースラインだけが
    // 自分の Run を含んだ射影になり、前後が食い違う。
    const ownRuns: OwnRun[] = [];

    // 本体リポジトリ側の汚れを ACT の前に控える。自己ホストなので、人間が
    // 編集中のファイルが最初から並んでいる。それを違反と読むと関門が毎回鳴り、
    // 鳴りっぱなしの関門は誰も見なくなる。差分だけを Actor の仕業として数える。
    const repoBefore = await repoBaseline(goal, ownRuns, deps);

    // 基準が読めなければ Actor を起動しない。関門は下で guard_unavailable に倒すが、
    // その前に1回分の予算を使ってしまうのは避ける。
    const base = guardBaseOf(goal, state);
    const run =
      base === null
        ? null
        : await maybeAct(
            goal,
            result.decision,
            base,
            result.observedFacts,
            deps,
            actorSignal,
            ownRuns,
          );

    // ACT のあいだに奪われていないか。Run はもう確定している（中断は act が
    // interrupted として書く）ので、止めるのはここから下の書き込みだけになる。
    // Actor は実際に走ったのだから、starting のまま残す方が悪い。
    if (!holdsLease(goalId, deps)) {
      return lost(state.status, reclaimed, run);
    }

    // 観測と検証の結果を、書く形に組み立てる。**組み立てるのが ACT の後なのは、
    // 実装役が走ったかどうかがここでしか分からないため**（issue #63）。
    //
    // 実装役が走ったティックでは、レビュー系の criteria を判定しない。ティックの
    // 中は OBSERVE → ACT → publish の順なので、VERIFY が読む `local.head_sha` は
    // ACT より前の観測になる。実装役が commit を積むと、ティックが終わる時点の
    // HEAD は誰も読んでいない commit になっているのに、`review.reviewed_sha` との
    // 一致だけを見た結果が「現在の HEAD へのレビュー」として 🟢 で残る。
    //
    // **鮮度の判定そのもの（`judgeReviewVerdict`）は触らない。** 順序の問題であって
    // 判定ロジックの問題ではないので、判定を通さない側——安全側——へ倒すだけにする。
    // VERIFY を publish の後ろへ移す形も採らない。ティックの構造（design.md §3.6）を
    // 変えずに済む。
    //
    // 実装役が走らなかったティックには何もしない。レビュー役は読むだけで、
    // `investigate` は別の作業ツリーを使うので、どちらも押す木の HEAD を動かさない。
    const judged = implementRan(run)
      ? pendingReviewCriteria(goal.acceptance_criteria, result.facts, result.unresolved)
      : { facts: result.facts, unresolved: result.unresolved };
    const snapshot = { observedAt, facts: judged.facts, unresolved: judged.unresolved };
    // criteria 単位の索引（design.md §4.5 の Verification）。同じ結果を facts と
    // unresolved から導くだけで、検証をもう一度回さない。二重に検証すると、
    // 同じティックの中で結果が食い違う余地が生まれる。
    const verifications = toVerifications(
      goal.acceptance_criteria,
      judged.facts,
      judged.unresolved,
      observedAt,
    );

    // Agent が触ってはいけないものに触れていないかを、ACT の外で検査する
    // （design.md §7 / §10-6）。Agent 側の disallowedTools は Agent の設定で、
    // SDK の外から同じ操作をされれば素通りする。
    const guarded = await guardedDecision(
      goal,
      result.decision,
      run,
      repoBefore,
      base,
      deps,
      ownRuns,
    );
    const actorGuarded = actorUsageLimitDecision(guarded, run);

    // 機械側の criteria が全部通ったら、controller が commit する
    // （design.md §10-11）。**「Actor が commit する」という前提を置くのをやめた。**
    // push が送るのは commit 済みの差分だけなので、commit されないと criteria が
    // 全部通っていても remote には1行も出ず、CI も人間のレビューも始まらない。
    //
    // 保護パスの関門を通ったあとに置く。違反したティックで commit すると、
    // 触ってはいけないものに触れた変更を履歴に載せることになる。
    const committed = await commitVerifiedWork(goal, guarded, verifications, deps);

    // 未 commit の変更を残したまま「機械側の番は終わった」と言い切らせない
    // （design.md §10-11）。差し替えはここまでで、書き込むのは下の1行のまま。
    //
    // 渡すのは今ティックの観測が作った Fact だけにする。merge 済みの result.facts には
    // 前ティックの local.* が残るので、観測に失敗したティックを「汚れている」と
    // 読んでしまう（design.md §3.1）。
    //
    // **いま commit したティックは見ない。** `local.dirty` は commit より前の
    // 観測なので、読むと自分が片付けた汚れで自分を止めることになる。
    const decided = committed
      ? actorGuarded
      : uncommittedDecision(goal, actorGuarded, result.observedFacts, deps);

    // ここから下がこのティックの書き込みになる。直前にもう一度確かめる。
    // guardedDecision は git を叩くので、ACT 直後の確認から時間が空く。
    if (!holdsLease(goalId, deps)) {
      return lost(state.status, reclaimed, run);
    }

    // 観測結果は ACT の後にまとめて書く（組み立ては reconcile の直後）。
    // verifications の reconcile_seq は saveSnapshot が進めた reconciles を
    // 読むので、この2つは必ず隣に置く。
    deps.store.saveSnapshot(goalId, snapshot);
    deps.store.saveVerifications(goalId, verifications);

    // PR を確保して進捗を書く。ここは throw しないので、通知の失敗で
    // ティック全体を落とさない（design.md §9 の「PR と通知」）。
    // 保護パスに触れていたら PR は作らない。通常の変更として流れてしまう。
    const published = await publish(
      {
        goal,
        run,
        decision: decided,
        verifications,
        prNumber: state.prNumber,
        digest,
        previousDigest,
      },
      deps,
    );
    if (published.prNumber !== null && published.prNumber !== state.prNumber) {
      // 次のティックが observe できるように書き戻す。ここを落とすと、
      // 作った PR を controller 自身が二度と見つけられない。
      deps.store.setObserveTarget(goalId, published.prNumber, state.issueNumber);
    }

    // 宣言（`policies.publish`）で publish を止めたなら、このティックは人間待ちで
    // 終わる。**判断の差し替えを publish の後ろに置く。** 止めた段が確定するのは
    // publish の中で、`open_pull_request` は「差分があり、まだ PR が無い」ティックに
    // しか成立しない。宣言だけを先に読んで差し替えると、押すものが無いティックまで
    // 人間を呼ぶことになる。
    const settled = publishHeldDecision(goal, decided, published.held, deps);

    // Decision は1ティックに1行だけ書く。以前は先に result.decision を書き、
    // 差し替えたときにもう1行足していたので、保護パス違反のティックだけ
    // decisions が2行になった。countTrailingDigest は行を数えるので、
    // max_unchanged_reconciles がそのぶん余計に進んでいた。
    deps.store.saveDecision(goalId, digest, settled);

    const status = nextStatus(state.status, settled.action);
    const action = settled.action;
    deps.store.setStatus(
      goalId,
      status,
      action.type === "WAIT" ? action.resumeAfter : null,
      deps.now().toISOString(),
    );

    return {
      ran: true,
      skipped: null,
      reclaimed,
      decision: settled,
      run,
      // 止めていないティックにはキーを足さない。既存の出力の形を変えない。
      ...(published.held === null ? {} : { publishHold: published.held }),
      status,
    };
  } finally {
    // 例外で抜けても解放する。残すと lease の期限までどのワーカーも動けない。
    clearInterval(heartbeat);
    deps.store.releaseLease(goalId, deps.owner);
  }
}

/**
 * このティックで実装役が走ったか。
 *
 * 押す木（`worktreeNameFor(goal.id, "implement")`）の HEAD がティックの途中で
 * 動きうるのは、この役割が走ったときだけになる。レビュー役は同じ木を読むだけで、
 * `investigate` は別の木を使う。
 *
 * Run の状態は見ない。失敗した Run でも、それまでに Actor が commit を積んで
 * いれば HEAD は動く。「動いていないと確かめられた」ときだけ判定を続ける側に倒す。
 */
function implementRan(run: Run | null): boolean {
  return run !== null && run.role === DEFAULT_ACTOR_ROLE;
}

/**
 * まだ自分が lease の持ち主か。書く直前に DB へ訊く。
 *
 * heartbeat の戻り値だけに頼らない理由は2つある。leaseSeconds / 2 より短い
 * ティックではタイマーが1度も鳴らないこと、そして鳴る間隔の内側でも奪われうる
 * こと。「取れた」は1回きりの出来事だが、「持っている」は書くたびに確かめる
 * 対象になる（design.md §4.5）。
 *
 * 期限も見る。owner が自分のままでも、lease_until を過ぎていれば他のワーカーが
 * いつ奪ってもよい状態なので、持ち主とは言わない。ただし lease_until を
 * 読めなかった場合は owner の一致だけで判断する。読めないことを「失った」と
 * 読むと、正常なティックが書けなくなる方向に倒れる。
 */
function holdsLease(goalId: string, deps: ControllerDeps): boolean {
  const current = deps.store.getState(goalId);
  if (current === null || current.leaseOwner !== deps.owner) {
    return false;
  }
  if (current.leaseUntil === null) {
    return true;
  }
  const until = Date.parse(current.leaseUntil);
  return Number.isNaN(until) || until > deps.now().getTime();
}

/**
 * 見るだけのティック（`ent run <slug> --dry-run`）。
 *
 * 満たすべき性質:
 * - OBSERVE / VERIFY / ASSESS / DECIDE は本当に回す。観測を模擬すると、
 *   「配管が繋がっているか」を確かめるという dry-run の用途そのものが消える。
 *   LLM の呼び出し記録（recordLlmCall）も残す。トークンは実際に消費するので、
 *   記録を落とすと使用量が合わなくなる（design.md §7）
 * - 書かない。snapshot / verifications / decision / status のどれも残さない。
 *   残すと、見ただけのティックが次の判断材料（ダイジェストの連続やループ検知）を汚す
 * - lease を取らない。書かないので他のワーカーを塞ぐ理由が無い。実行中の Goal に
 *   対しても「次に何をするつもりか」は読めた方がよいので、lease の有無で弾かない
 * - ACT も publish も orphan Run の回収もしない
 * - 保護パスの検査は通常のティックと同じに通す。ここだけ結果が変わると、
 *   dry-run が「次に何が起きるか」を映さなくなる。検査そのものは触っていない
 * - 書いていたらどの状態に移っていたかを返す。状態は動かさないので、
 *   nextStatus の結果を wouldTransitionTo として別に返す
 * - **`policies.publish` で止まる分は映らない。** publish を回さないので、宣言で
 *   止めたときの `WAITING_HUMAN`（`publishHeldDecision`）はここでは出ず、
 *   `wouldTransitionTo` は止める前の判断のまま返る。`open_pull_request` が止まるのは
 *   「差分があり、まだ PR が無い」ティックだけで、それを知るには push して探すしかない。
 *   dry-run は書かないティックなので、押してから判定することはできない。
 *   `push_branch` だけは宣言から決まるので先に読めるが、ここだけ予告すると
 *   同じ関門の判定が publish と preview の2箇所に分かれる。**片方が古くなったときに
 *   どちらが実体なのか読む側から分からなくなる**ので、判定は publish に1本化して、
 *   映らないことをこの行で明示する側を採る
 * - GitHub の読み口が生きているかを確かめる（reachableCode）。dry-run は
 *   「配管が繋がっているか」を見るためのものなので、observe が触らなかった
 *   Port をそのままにすると用を成さない
 */
async function preview(goal: Goal, state: GoalState, deps: ControllerDeps): Promise<TickResult> {
  const goalId = goal.goal.id;
  const carriedFacts = deps.store.latestSnapshot(goalId)?.facts ?? [];
  const result = await reconcile(
    {
      goal,
      observe: observeTargetOf(state, deps),
      carriedFacts,
      usage: usageOf(state, goal, deps),
    },
    deps,
  );

  // 書かないだけで、criteria 単位の索引は通常のティックと同じ入力から作る。
  const verifications = toVerifications(
    goal.acceptance_criteria,
    result.facts,
    result.unresolved,
    deps.now().toISOString(),
  );

  // 読めなかった口を出力にだけ足す。DECIDE には渡さない（渡すと、dry-run が
  // 見せる判断が本当のティックの判断と別物になる）。
  const probe = await reachableCode(state, deps);
  const unresolved = probe === null ? result.unresolved : [...result.unresolved, probe];

  // ACT を実行していないので、本体リポジトリ側の差分はこのティックには無い。
  // それでも検査を通すのは、前のティックが残した違反が worktree に残っている
  // 場合に、次のティックが ESCALATE になることまで含めて見せるため。
  //
  // 状態 DB の観測も通常のティックと同じに作る。dry-run は1行も書かないので
  // 外す Run は1件も無いが、ここだけ経路を変えると dry-run が
  // 「次に何が起きるか」を映さなくなる。
  const repoBefore = await repoBaseline(goal, [], deps);
  const guarded = await guardedDecision(
    goal,
    result.decision,
    null,
    repoBefore,
    guardBaseOf(goal, state),
    deps,
    [],
  );

  // 未 commit の関門も通常のティックと同じに通す。ここを抜くと、worktree が
  // 汚れていて完了 Run が履歴にある状態で、実ティックが WAITING_HUMAN になるのに
  // dry-run は COMPLETED を予告する。「1行も push せず COMPLETED」を防ぐために
  // 足した関門を、それを覗くための道具が見ていないことになる（design.md §10-11）。
  //
  // **ただし commit する条件は書かずに判定する。** 実ティックは機械側の criteria が
  // 通っていれば先に commit するので、そのティックで関門は鳴らない。dry-run は
  // 書かない側なので commit は起こせないが、**起こしていたら鳴らなかった**ことは
  // 同じ純ロジックで分かる。ここを見ないと、実ティックが commit して進むはずの
  // ティックを dry-run だけが `ESCALATE(uncommitted_changes)` と予告する。
  const wouldCommit =
    guarded.action.type !== "ESCALATE" &&
    machineCriteriaSatisfied(goal.acceptance_criteria, verifications);
  const decided = wouldCommit
    ? guarded
    : uncommittedDecision(goal, guarded, result.observedFacts, deps);

  return {
    ran: false,
    skipped: null,
    reclaimed: 0,
    decision: decided,
    run: null,
    status: state.status,
    dryRun: true,
    wouldTransitionTo: nextStatus(state.status, decided.action),
    observed: {
      facts: result.facts,
      unresolved,
      verifications,
    },
  };
}

/**
 * 存在しない PR 番号。GitHub の PR は 1 から振られるので、これで引けば必ず 404 になる。
 * 404 は「読めたが対象が無い」で、Port は null を返す（src/adapters/github.ts）。
 */
const PROBE_PR_NUMBER = 0;

/**
 * GitHub の読み口が生きているかを確かめる。dry-run のときだけ通る。
 *
 * PR がまだ無い Goal では、observe は CodeProviderPort を1度も呼ばない。すると
 * GITHUB_TOKEN の未設定も API の障害も観測結果に現れず、「PR がまだ無い」と
 * 「GitHub が読めない」が同じ見た目になる。dry-run は起こす前に配管を確かめる
 * ためのものなので、ここだけ明示的に1回叩く。
 *
 * 叩くのは存在しない番号にして、返ってきた値は使わない。実在の PR を読むと、
 * 観測対象を指定していないのに Fact があるように見える。ここに残すのは
 * 「読めなかった」という事実だけにする（design.md §3.1）。
 *
 * 既に PR を観測しているなら、observe が同じ口を通っているので叩き直さない。
 */
async function reachableCode(state: GoalState, deps: ControllerDeps): Promise<Unresolved | null> {
  if (state.prNumber !== null) {
    return null;
  }
  try {
    await deps.code.getPullRequest(PROBE_PR_NUMBER);
    return null;
  } catch (error) {
    return {
      key: "github",
      reason: "port_failed",
      detail: `could not read CodeProviderPort: ${errorMessage(error)}`,
    };
  }
}

/**
 * 作業ツリーの状態を検査し、違反があれば Decision を差し替える。
 *
 * 満たすべき性質:
 * - 検査の入力は git が観測した変更を主にする。`Run.artifacts` は Actor の
 *   自己申告で、Bash 経由の書き込みが1件も現れない（design.md §10-6）。
 *   自己申告だけに載せている限り、`echo >` で制御ループを書き換えても素通りする
 * - **ACT を実行していないティックでも検査する。** 違反した編集は worktree に
 *   残したまま（人間が判断できるように）なので、次のティックが保護パスに触れずに
 *   終われば、その worktree ごと push されてしまう。違反は1ティックの出来事ではなく、
 *   worktree が汚れているあいだ続く状態として扱う
 * - **worktree の外は本体リポジトリ側の git で見る。** worktree の中で git を
 *   回しても、`git worktree add` で分けた本体側の作業ツリーは観測できない。
 *   `Run.artifacts` も Bash 経由の書き込みを拾わないので、
 *   `bash -c 'echo > ../../../../src/controller/index.ts'` はどちらの入力にも
 *   現れなかった。隔離が守るはずの当のファイルが検査から漏れていた
 * - 本体側は ACT 前の状態との差だけを数える。自己ホストなので人間の編集中の
 *   ファイルが最初から汚れている。それを違反にすると関門が毎回鳴る
 * - **状態 DB はバイト列ではなく論理的な行で見る。** あれは関門が見る保護対象で
 *   ありながら controller 自身の書き込み先でもあり、ACT の窓の中で `startRun` /
 *   `finishRun` / lease の延長が走る。バイト列だと WAL の checkpoint に当たった
 *   回だけ「外部からの改竄」と同じ差になっていた（`observedRepoState`）
 * - artifacts も併せて渡す。SDK が申告するパスは worktree の外を指すこともある
 * - 検査できなかったら ESCALATE(guard_unavailable)。「触っていない」と
 *   「確かめられなかった」を混ぜない（design.md §3.1）
 * - 違反があれば ESCALATE(protected_path_touched) にする。判断したのは
 *   LLM ではないので decidedBy は "guard"（design.md §7）
 * - worktree の中身は触らない。差分を残しておかないと人間が判断できない
 * - 元の rationale を残す。何をしようとしていたのかが読めなくなる
 */
async function guardedDecision(
  goal: Goal,
  decision: Decision,
  run: Run | null,
  repoBefore: RepoBaseline,
  base: string | null,
  deps: ControllerDeps,
  ownRuns: readonly OwnRun[],
): Promise<Decision> {
  // act と同じ規則で worktree の場所を決める。ここがずれると、
  // 隔離の中の編集を「外に出た」と読んでしまう。
  //
  // 見るのは「このティックで Actor が走った作業ツリー」に加えて、**必ず実装役の
  // 作業ツリー**にする。走っていないティック（ACT 以外・dry-run）は実装役だけ。
  //
  // **実装役を必ず混ぜるのは、push するのが実装役の木だから**（`pushWorktree`、
  // src/publish/index.ts）。走った role の木だけを検査していると、自分の木を持つ
  // 役割（いまは `investigate`）が走ったティックでは「検査した木」と「押す木」が
  // 別になる。読むだけの役割も Bash は持つので、`git -C ../<goal-id>` で実装役の
  // 木を書いて commit する経路は塞がっていない。その commit は
  // `changedPaths("<goal-id>-investigate", ...)` にも本体リポジトリ側の観測
  // （worktree の置き場は除外される）にも出ないまま push される。
  // `review` は実装役と同じ木を見るので、下の `seen` で1つに畳まれる。
  //
  // 前のティックが残した違反は worktree に残ったままなので、どちらの木でも
  // 毎ティック再検知される。押す木を必ず検査に含める、が守りたい不変条件になる。
  const primaryRole = run?.role ?? DEFAULT_ACTOR_ROLE;
  const worktreePath = worktreePathFor(goal, primaryRole, run, deps);
  const roles: readonly ActorRole[] =
    primaryRole === DEFAULT_ACTOR_ROLE ? [primaryRole] : [primaryRole, DEFAULT_ACTOR_ROLE];

  const escalate = (reason: "protected_path_touched" | "guard_unavailable", detail: string) => ({
    decidedAt: deps.now().toISOString(),
    action: { type: "ESCALATE", reason } as const,
    rationale: `${detail} (original decision: ${decision.rationale})`,
    decidedBy: "guard" as const,
  });

  // 基準が読めない。記録が壊れているか、書き換えられている。
  // 「触っていない」と「確かめられなかった」を混ぜない（design.md §3.1）。
  if (base === null) {
    return escalate(
      "guard_unavailable",
      "stopping: the gate baseline (guard_base_sha) is not shaped like a commit id",
    );
  }

  // 射影から落とした Run の不変列を、控えた値と突き合わせる。
  //
  // **下の早期 return より前に置く。** Actor が worktree を1文字も編集しなければ
  // `inspected` も `escaped` も空になり、そこで `decision` がそのまま返る。
  // この検査を違反の枝に混ぜると、いちばん通したくない経路——何も編集せずに
  // DB だけを1行書き換える——で一度も走らない。
  const drift = ownRunDrift(goal.goal.id, ownRuns, deps);
  if (drift !== null) {
    return escalate(drift.reason, drift.detail);
  }

  // 作業ツリーごとに「編集されたパスの集合」と「そのツリーの場所」を組で持つ。
  // 場所は `findViolations` が相対パスを組み立てるのに要るので、集合だけを
  // 合流させると、別のツリーのパスを別のツリーの基点で読むことになる。
  //
  // 同じ木は2度検査しない。`review` は `implement` と同じ作業ツリーを見るので
  // （`worktreeNameFor`）、名前で畳まないと同じ違反が二重に並ぶ。畳む前に
  // primaryRole の側を回すので、Actor の自己申告（artifacts）は落ちない。
  const inspected: { path: string; edited: readonly string[] }[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const name = worktreeNameFor(goal.goal.id, role);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const path = role === primaryRole ? worktreePath : worktreePathFor(goal, role, null, deps);
    let changed: readonly string[];
    try {
      changed = await deps.worktree.changedPaths(name, base);
    } catch (error) {
      return escalate(
        "guard_unavailable",
        `stopping: could not inspect the protected paths: ${errorMessage(error)}`,
      );
    }
    // artifacts は SDK が申告する編集で、走った Actor の木にしか紐付かない。
    const artifacts = role === primaryRole ? (run?.artifacts ?? []) : [];
    inspected.push({ path, edited: [...artifacts, ...changed] });
  }

  if ("error" in repoBefore) {
    return escalate(
      "guard_unavailable",
      `stopping: could not record the main repository state: ${repoBefore.error}`,
    );
  }

  let escaped: readonly string[];
  try {
    // before 側（repoBaseline）と同じ観測を取る。片側だけ git の汚れに絞ると、
    // git に見えない書き込み（.git/hooks・core.hooksPath・状態 DB）は
    // baseline にしか現れず、下の filter が after 側のエントリしか見ないので
    // 指紋がどう変わっても escaped に入らない。観測を足したのに関門が一度も
    // 鳴らない、という形になる。前後で同じものを見ること。
    const after = await observedRepoState(goal, ownRuns, deps);
    // 中身の指紋で比べる。パスの集合だけだと、人間が編集中のファイルを
    // Actor が上書きしたときに前後で同じパスが並び、差がゼロになる。
    //
    // **この差分の取り方に残る穴（design.md §10-6 の (c) (d)）:**
    // - ベースラインは ACT 直前のティック内スナップショットなので、1回の改変を
    //   人間が掃除しないまま次のティックへ進むと、その内容がベースラインに入って
    //   鳴り止む。指紋で比べているので同じファイルをもう一度書き換えれば再び鳴るが、
    //   改変された controller のソースはディスクに残ったままになる
    // - ACT は分単位なので、その間に人間が repoRoot を編集すると差分に載る。
    //   worktree の外なので protected_path_touched になる。安全側だが誤検知
    //
    // この2つは逆向きで、検知を永続化するか、編集を Actor プロセスに紐付けないと
    // 同時には解けない。MVP では両方残している。
    // 前後どちらかにしか無いパスも変化として数える。after 側だけを走査すると、
    // 消された hook（before にあって after に無い）が差分に出ない。
    const paths = new Set([...repoBefore.state.keys(), ...after.keys()]);
    escaped = [...paths].filter((path) => repoBefore.state.get(path) !== after.get(path));
  } catch (error) {
    return escalate(
      "guard_unavailable",
      `stopping: could not inspect the main repository: ${errorMessage(error)}`,
    );
  }

  // 出どころで分けて渡す。worktree 側と本体リポジトリ側では、同じ
  // `.goals/.state/...` という文字列が別のものを指すため（`PathOrigin`）。
  // 一緒くたにすると、本体の goals.db の改竄が「worktree の中の実行時状態」
  // として除外され、関門が鳴らないまま素通りする。
  if (inspected.every((tree) => tree.edited.length === 0) && escaped.length === 0) {
    return decision;
  }

  const violations = [
    ...inspected.flatMap((tree) =>
      findViolations(tree.edited, tree.path, goal.policies.protected_paths),
    ),
    ...findViolations(escaped, worktreePath, goal.policies.protected_paths, "repo_root"),
  ];
  if (violations.length === 0) {
    return decision;
  }

  return escalate(
    "protected_path_touched",
    `stopping: the control loop itself was touched: ${describeViolations(violations)}`,
  );
}

/**
 * 役割ごとの worktree の場所。act と同じ規則で決める。
 *
 * WorktreePort は名前からパスを決めるが、その規則を controller は知らない。
 * `worktreeRoot` を渡されていなければ、走った Run が控えた場所に落とす。
 *
 * role を明示で受ける。既定を持たせると、呼び出し側が implement と review の
 * どちらを指しているのかが読めなくなる（`worktreeNameFor` と同じ理由）。
 */
function worktreePathFor(
  goal: Goal,
  role: ActorRole,
  run: Run | null,
  deps: ControllerDeps,
): string {
  const worktreeName = worktreeNameFor(goal.goal.id, role);
  return deps.worktreeRoot === undefined
    ? (run?.worktree ?? worktreeName)
    : join(deps.worktreeRoot, worktreeName);
}

/**
 * 機械側の criteria が全部通ったティックで、Actor が書いたものを commit する。
 *
 * **「Actor が commit する」という前提を置くのをやめた**（design.md §10-11）。
 * intent に書いてもプロンプトに書いても、従ったことは確かめられない（§3.2）。
 * 実測でも、同じ設定・同じモデルの Actor が commit するティックとしないティックの
 * 両方が出た。push が送るのは commit 済みの差分だけなので、commit されないと
 * criteria が全部通っていても remote には1行も出ず、CI も人間のレビューも始まらない。
 *
 * **関門が止めたティックでは commit しない。** 保護パスに触れた変更を履歴に
 * 載せると、あとから通常の変更として流れる余地が生まれる（§10-6 が push を
 * 止めているのと同じ理由）。`guard_unavailable` も同じ扱いで、検査できて
 * いない以上「触っていない」とは言えない。
 *
 * **押す木に commit する。** `worktreeNameFor(goal.id, "implement")` に固定する
 * のは publish と同じ理由で、Run 側に従わせると検査した木と押す木がずれる。
 *
 * 失敗しても throw しない。commit できなかったティックは、これまでどおり
 * 未 commit の関門（`uncommittedDecision`）が拾う。ここで落とすと、
 * 観測も Decision も書かないまま ティックが終わる。
 */
async function commitVerifiedWork(
  goal: Goal,
  decision: Decision,
  verifications: readonly Verification[],
  deps: ControllerDeps,
): Promise<boolean> {
  if (decision.action.type === "ESCALATE") {
    return false;
  }
  if (!machineCriteriaSatisfied(goal.acceptance_criteria, verifications)) {
    return false;
  }

  const passed = verifications
    .filter((verification) => verification.result === "passed")
    .map((verification) => verification.criterionId)
    .join(", ");
  const message = `${goal.goal.name}\n\nThe controller committed this because the machine-checkable criteria passed (${passed}).\nThe Actor's execution stays in the Run's raw log (design.md §10-11).`;

  try {
    return await deps.worktree.commit(worktreeNameFor(goal.goal.id, DEFAULT_ACTOR_ROLE), message);
  } catch (error) {
    // 検査ではないので、確かめられなかったことにはしない。次のティックで
    // 未 commit の関門が同じ状態を拾う。
    deps.log?.(`could not commit: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * 未 commit の変更を残したまま「機械側の番は終わった」と言い切らせない。
 *
 * push は commit 済みの差分しか送らない（`git push -u origin HEAD:<branch>`）のに、
 * VERIFY は worktree の作業ツリーを見る。Actor が実装を書いたまま commit しないと、
 * criteria は全部 passed になるのに remote には何も出ない。controller からは
 * 「ローカルは全部通っているのに PR だけが古い」に見え、COMPLETE か
 * WAIT(review_pending) に落ちる。前者は終端で取り消せず、後者の待ち相手は
 * 「実装が載った PR」なので永久に終わらない（design.md §10-11）。
 *
 * 満たすべき性質:
 * - 差し替えるのは「このティックで書き残しが commit されない」と言い切れるティックに
 *   する。COMPLETE と WAIT と VERIFY の3つで、WAIT は LLM が返したものも guard が
 *   Gap ゼロから出したものも同じ意味を持つ。判定は `leavesWorkUncommitted` が正
 * - `WAIT(usage_limit)` は差し替えない。あれは判断そのものを保留しただけで、
 *   上限が明ければ続きがある（design.md §10-5）。待てば直る状態で人間を呼ばない
 * - ACT が出たティックは触らない。実装の途中で作業ツリーが汚れているのは正常で、
 *   ここまで止めると Actor は1ティックも実装を進められない
 * - **Actor がまだ1度も走っていない Goal では見ない。** 1ティック目は worktree が
 *   無く、`local.*` は controller 自身のリポジトリを観測する（`src/wiring/index.ts` の
 *   `verifyRoot`）。自己ホストでは人間の編集で汚れているのが普通なので、そこを
 *   Actor の書き残しと読むと、どの Goal も最初のティックから進まなくなる
 * - **worktree を観測した dirty だけを見る。** 「Run が1件でもあれば worktree を
 *   観測している」は代理にならない。`act` は `worktree.ensure` より先に
 *   Run(starting) を書く（write-ahead）ので、worktree を作れずに失敗した Run が
 *   1本あるだけでその前提は破れ、`verifyRoot` は controller 自身のリポジトリに
 *   落ちたままになる。どこを観測した値かは、同じ観測が作る `local.branch` で分かる。
 *   worktree が checkout するブランチ名の規則は `worktreeBranchFor` が正
 * - **材料は今ティックの観測が作った Fact に限る。** reconcile は前ティックの Fact を
 *   土台にして今ティックの観測で上書きするので、`LocalRepoPort` が落ちたティックには
 *   前ティックの `local.dirty` が VERIFIED のまま残る（陳腐化して落ちるのは
 *   `github.ci.*` だけ）。それを今の観測として読むと、「確かめられなかった」が
 *   「汚れている」に化け、捏造した違反で人間を呼ぶことになる（design.md §3.1）。
 *   逆に「確かめられなかった」を「綺麗」とも読まない——そのティックは Fact が
 *   欠けるので、そもそも criteria が揃わず COMPLETE には届かない
 * - 判断したのは LLM ではないので decidedBy は "guard"（design.md §7）
 * - **止めた理由と、進めるために何をすればよいかを rationale に書く。** ここが
 *   `ent get`（`decision.rationale`）にも PR の進捗コメントにもそのまま出る
 *   唯一の説明になる。「止まった」しか読めない関門は、人間から見れば
 *   原因不明の停止と区別がつかない
 * - 元の rationale を残す。何をしようとしていたのかが読めなくなる
 */
function uncommittedDecision(
  goal: Goal,
  decision: Decision,
  observedFacts: readonly Fact[],
  deps: ControllerDeps,
): Decision {
  if (!leavesWorkUncommitted(decision)) {
    return decision;
  }

  // 前のティックで書き残されたものを、このティックで検知する。だから材料は
  // 今回の Run ではなく、Goal に紐づく Run の履歴になる。保護パスの関門と同じく、
  // 1ティックの出来事ではなく worktree が汚れているあいだ続く状態として扱う。
  if (deps.store.listRuns(goal.goal.id).length === 0) {
    return decision;
  }

  // 今ティックの観測が worktree を見ていなければ、その dirty は Actor の
  // 書き残しではない。controller 自身のリポジトリの汚れで人間を呼ばない。
  //
  // 突き合わせる相手は**実装役の作業ツリー**に固定する。`local.*` を観測する
  // のも criteria のコマンドを流すのも実装役の側で（`src/wiring/index.ts` の
  // `verifyRoot`）、PR に載るのもそのブランチだからになる。役割が増えても
  // ここを review 側にすると、レビュー中の作業ツリーの汚れを実装の書き残しと
  // 読む一方で、実装役が書き残したものを見落とす。
  const worktreeBranch = worktreeBranchFor(worktreeNameFor(goal.goal.id, "implement"));
  if (!observedValue(observedFacts, "local.branch", worktreeBranch)) {
    return decision;
  }

  if (!observedValue(observedFacts, "local.dirty", true)) {
    return decision;
  }

  // 人間に案内するパスも、上で突き合わせた実装役の作業ツリーに揃える。
  const worktreePath = worktreePathFor(goal, "implement", null, deps);
  return {
    decidedAt: deps.now().toISOString(),
    action: { type: "ESCALATE", reason: "uncommitted_changes" },
    rationale:
      `Changes written by the Actor are left uncommitted in the worktree ` +
      `(${worktreePath}, branch ${worktreeBranch}). Uncommitted diffs are never pushed, which means ` +
      `${describeClaim(decision.action)} leave the remote without a single line of the implementation. ` +
      `To move forward, inspect the diff with \`git -C ${worktreePath} status\`, then either keep it ` +
      `by committing (\`git -C ${worktreePath} add -A && git -C ${worktreePath} commit\`) ` +
      `or drop it by reverting (\`git -C ${worktreePath} checkout -- .\`), ` +
      `and run this Goal again (\`ent run ${goal.goal.id}\`) ` +
      `(original decision: ${decision.rationale})`,
    decidedBy: "guard",
  };
}

/**
 * 宣言（`policies.publish`）で publish を止めたティックの判断。止めていなければそのまま返す。
 *
 * 満たすべき性質:
 * - 止めた段ごとに別の理由にする。`ent list` が出すのは種別と理由だけなので
 *   （`stoppedReason`）、1つに畳むと「push を止めたのか PR を止めたのか」を
 *   読む側がもう一度調べることになる
 * - 状態は `WAITING_HUMAN` になる（`nextStatus`）。**COMPLETE を上書きする。**
 *   PR が1本も無いまま「終わった」と言い切ると、完了判定が意味を失う。
 *   ここで止めなければ、宣言した Goal ほど静かに COMPLETED へ抜ける
 * - 判断したのは LLM ではないので decidedBy は "guard"（design.md §7）
 * - 止めた理由と、人間が何をすれば進むのかを rationale に書く。ここが
 *   `ent get`（`decision.rationale`）と `ent list` に出る唯一の説明になる
 * - 元の rationale を残す。何をしようとしていたのかが読めなくなる
 *
 * **この rationale は PR には出ない。** 差し替えるのは publish の**後ろ**なので、
 * `publish` が進捗コメントに載せた `decision` は差し替え前のものになる。同じファイルの
 * `uncommittedDecision` は publish の前で差し替わるため PR と `ent get` に同じ文字列が
 * 出るが、こちらはその規約から外れる。**差し替えを前へ動かす形は採れない。**
 * `open_pull_request` を止めるかどうかは「push が通り、まだ PR が無い」を確かめたあと
 * ——つまり publish の中——でしか決まらない。
 *
 * 代わりに、PR に要る分は `heldNotes`（`src/publish/index.ts`）が NOTE として書く。
 * 文字列は別でも**同じ事実**を言う（手で押しても解けないこと、`auto` に戻すか
 * `ent abandon` で終端にすること）。片方を直すときはもう片方も見る。
 *
 * **2つの段は、解け方が違う。** `open_pull_request` は人間が PR を立てれば次のティックの
 * `findPullRequest` が見つけるので、宣言を書き換えなくても進む。`push_branch` にはその
 * 経路が無い——押さないと決めた口（`BranchPort.push`）が remote を知る唯一の経路なので、
 * 人間が手で押しても controller には見えない。宣言を `auto` に戻すまで毎ティック同じ
 * 理由で止まり、予算だけが減る。**その非対称を rationale に書く。** 書かないと、
 * 押したのに止まり続ける理由を人間がコードから探すことになる。
 */
function publishHeldDecision(
  goal: Goal,
  decision: Decision,
  held: PublishHold | null,
  deps: ControllerDeps,
): Decision {
  if (held === null) {
    return decision;
  }

  // 案内するのは実装役の作業ツリーに揃える。押すのも commit もそちらで
  // （`pushWorktree` / `commitVerifiedWork`）、人間が手で押す先も同じになる。
  const worktreePath = worktreePathFor(goal, DEFAULT_ACTOR_ROLE, null, deps);
  // ブランチと base は `PublishHold` から取る。**ここで組み立て直さない。**
  // 同じ2つを機械可読なキー（`publishHold`）にも出しているので、別々に作ると
  // 文面と payload が食い違いうる。読む側は同じティックの出力の中で矛盾を見る。
  const branch = held.branch;
  const base = held.base;
  const declaration = `policies.publish.${held.step} in .goals/${goal.goal.id}.yaml`;

  const rationale =
    held.step === "push_branch"
      ? `policies.publish.push_branch: manual is declared, so the controller did not push. ` +
        `Even with committed diffs left in the worktree (${worktreePath}, branch ${branch}), ` +
        `not a single line reaches the remote. To move forward, a human reviews the contents and ` +
        `pushes it themselves (\`git -C ${worktreePath} push -u origin HEAD:${branch}\`). ` +
        `**Pushing does not get the controller past this point.** The port that was declared closed ` +
        `is the only path by which the controller learns about the remote, so a human push cannot be ` +
        `observed. Until ${declaration} is set back to auto, every tick stops for the same reason, ` +
        `and the reconcile budget keeps draining meanwhile. ` +
        `If this Goal is no longer worth following, terminate it with ` +
        `\`ent abandon ${goal.goal.id} --reason <reason>\` ` +
        `(original decision: ${decision.rationale})`
      : `policies.publish.open_pull_request: manual is declared, so the controller did not open a ` +
        `pull request. The push is done, so branch ${branch} is on the remote. ` +
        `To move forward, a human reviews the contents and opens the pull request ` +
        `(\`gh pr create --head ${branch} --base ${base}\`). ` +
        `The next tick finds that pull request and moves on, so ${declaration} can stay as it is ` +
        `(original decision: ${decision.rationale})`;

  return {
    decidedAt: deps.now().toISOString(),
    action: { type: "ESCALATE", reason: HELD_REASONS[held.step] },
    rationale,
    decidedBy: "guard",
  };
}

/**
 * 止めた段と、人間を呼ぶ理由の対応。
 *
 * 宣言部のキー名をそのまま理由にしてある。`ent get` を読んだ人間が、
 * `.goals/<slug>.yaml` のどの行を書き換えれば挙動が変わるのかを翻訳表なしで辿れる。
 */
const HELD_REASONS = {
  push_branch: "push_branch_declared_manual",
  open_pull_request: "open_pull_request_declared_manual",
} as const satisfies Record<PublishStep, EscalateReason>;

/**
 * ACT 前の本体リポジトリの汚れ。
 *
 * 控えられなかったことも値として持つ。ここで例外にすると、git が読めない環境で
 * ティックそのものが落ちる。落とすのではなく guard_unavailable として
 * 人間に渡すほうが、「確かめられなかった」を握り潰さずに済む（design.md §3.1）。
 */
type RepoBaseline = { state: ReadonlyMap<string, string> } | { error: string };

async function repoBaseline(
  goal: Goal,
  ownRuns: readonly OwnRun[],
  deps: ControllerDeps,
): Promise<RepoBaseline> {
  try {
    return { state: await observedRepoState(goal, ownRuns, deps) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * このティックで controller 自身が書いた Run と、そのとき渡した意図。
 *
 * 意図を捨てて id だけを持つと、射影から落とした行の**不変列**を誰も見なくなる
 * （`ownRunDrift`）。
 */
type OwnRun = { id: string; intent: RunIntent };

/**
 * 射影から落とした Run の行が、controller が書いたままかを確かめる。
 *
 * **なぜ要るか。** 状態 DB の論理ダイジェストは `ownRunIds` の行を**丸ごと**
 * 落とす。ところが controller が ACT の窓の中で書き換えるのは `finishRun` の9列
 * （`status` / `finished_at` / `exit_code` / `log_ref` / `tokens` / `artifacts` /
 * `detail` / `error_kind` / `actor_resume_after`）だけで、`role` / `intent` /
 * `worktree` / `attempt` / `started_at` は `startRun` が1回書いたきり動かない。
 * 行ごと落とすと、その不変列まで観測の外に出る。
 *
 * **とくに `role` が外に出ていると、実装役が自分でレビューを承認できた。**
 * 実装役の ACT の窓の中で
 * `UPDATE runs SET role='review' WHERE goal_id=? AND status='starting'` を流すと
 * （Run の id を知る必要すら無い）、次のティックで `latestReviewRun`
 * （`src/adapters/review-run.ts`）がその Run を「直近のレビュー役の Run」として
 * 選ぶ。`log_ref` は controller が正しく書いているので生ログの偽造も要らず、
 * 実装役が自分で書いた最終メッセージが `review.verdict` と `review.reviewed_sha`
 * の Fact になり、`judgeReviewVerdict` が criterion を passed にする。
 *
 * **行が消えたことも改竄として数える。** `goal_id` を書き換えられると、行は
 * `listRuns(goalId)` から落ちる。「見つからない」を「変わっていない」と読まない。
 *
 * **読めなかったら `guard_unavailable` に倒す。** `listRuns` は `role` や
 * `status` をスキーマに通すので、値そのものを壊されると throw する。ティックごと
 * 落とすのでも、握り潰すのでもなく、人間に渡す（design.md §3.1）。
 *
 * **残る穴は (c) と同じ形になる。** ここが見るのはティック内の前後差だけなので、
 * 鳴ったティックで Goal は `WAITING_HUMAN` に落ちるが、書き換えられた行は DB に
 * 残る。次のティックではその行が射影の内側に入るので鳴り止む。人間が掃除しない
 * まま回し続けると、`role='review'` の行はそのまま残る（design.md §10-6 の (h)）。
 */
function ownRunDrift(
  goalId: string,
  ownRuns: readonly OwnRun[],
  deps: ControllerDeps,
): { reason: "protected_path_touched" | "guard_unavailable"; detail: string } | null {
  if (ownRuns.length === 0) {
    return null;
  }

  let rows: readonly Run[];
  try {
    rows = deps.store.listRuns(goalId);
  } catch (error) {
    return {
      reason: "guard_unavailable",
      detail:
        `stopping: could not read the Run rows this tick created` +
        ` (${CONTROLLER_STATE_DB_KEY}): ${errorMessage(error)}`,
    };
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const own of ownRuns) {
    const row = byId.get(own.id);
    if (row === undefined) {
      return {
        reason: "protected_path_touched",
        detail:
          `the row for Run ${own.id}, created by this tick, has disappeared from this Goal` +
          ` (${CONTROLLER_STATE_DB_KEY})`,
      };
    }
    const changed = OWN_RUN_IMMUTABLE.filter(
      (column) => row[column.key] !== own.intent[column.key],
    );
    if (changed.length > 0) {
      return {
        reason: "protected_path_touched",
        detail:
          `columns only the controller writes have been rewritten on Run ${own.id}, ` +
          `created by this tick (${CONTROLLER_STATE_DB_KEY}): ` +
          changed
            .map(
              (column) =>
                `${column.name} should be ${JSON.stringify(own.intent[column.key])} but is ` +
                `${JSON.stringify(row[column.key])}`,
            )
            .join(", "),
      };
    }
  }

  return null;
}

/**
 * `startRun` が1回書いたきり動かない列。`finishRun` の UPDATE には1つも入らない。
 *
 * `Run` と `RunIntent` で同じ名前を持つものだけを並べる。`goal_id` はここに無いが、
 * 書き換えられると `listRuns(goalId)` から行ごと消えるので、上の「見つからない」で
 * 捕まる。
 *
 * 比較は `!==` で足りる。`attempt` だけが数値で、`node:sqlite` は 2^53 を越える
 * INTEGER を bigint で返す（`1n !== 1` なので、素通しだと大きい値で誤検知する）。
 * ただし `listRuns` は行を `runRowSchema`（`attempt: z.number()`）に通してから
 * 返すので、bigint はここまで届かない。届いた回は parse が throw して、上の
 * `guard_unavailable` に倒れる。
 */
const OWN_RUN_IMMUTABLE: readonly { key: keyof RunIntent & keyof Run; name: string }[] = [
  { key: "intent", name: "intent" },
  { key: "actor", name: "actor" },
  { key: "role", name: "role" },
  { key: "worktree", name: "worktree" },
  { key: "attempt", name: "attempt" },
  { key: "startedAt", name: "started_at" },
];

/**
 * ACT の前後で比べる観測を1つにまとめる。
 *
 * `repoDirtyState` は git が見える汚れで、`outOfSightState` は git の観測手段では
 * 原理的に出てこないもの（`.git/hooks/**`、`core.hooksPath`、状態 DB）を指す。
 * 前者だけを見ていたころは、Actor が `.git/hooks/pre-push` を1本置くだけで、
 * push のたびに controller の権限・全環境変数でそれが走った。関門の計測手段が
 * git だったので、原理的に見えなかった（design.md §8 の主張が届かない範囲）。
 *
 * `outOfSightState` を持たない実装（テストの fake など）では、git 側だけを見る。
 * 持っていないことを違反にはしない。
 *
 * **状態 DB だけは store から取る**（issue #62）。`.goals/.state/goals.db` は
 * この関門が見る保護対象でありながら、controller 自身の書き込み先でもある。
 * ACT の窓——ベースラインを控えてから検査するまでの間——で、controller は必ず
 * この DB に書く。Run の write-ahead（`startRun`）と確定（`finishRun`）、
 * そして lease の延長になる。
 *
 * かつてはこれも adapter がファイルの**バイト列**で見ていた。SQLite は WAL なので
 * 普段その書き込みは `goals.db-wal` に載るだけだが、WAL が既定の閾値を越えた
 * コミットでは自動 checkpoint が走り、`goals.db` の中身が動く。ティックの形が
 * 同じでも、そのプロセスがそれまでに書いた量が閾値を跨いだ回だけ
 * `ESCALATE(protected_path_touched)` になっていた。人間も Actor も触っていない
 * のに関門が鳴り、実装役の成果が publish されないまま worktree に残る。
 *
 * **保護対象からは外さない。** `.goals/.state/**` は `PROTECTED_PATH_FLOOR` に
 * 残る。外せば、DB を直接書き換えて状態を偽造されても関門が鳴らない。
 * 変えたのは観測の作り方で、**バイト列ではなくこの Goal に属する行の内容**から
 * 論理ダイジェストを作る（`Store.guardDigest`）。checkpoint では動かず、同じ
 * ディレクトリで別の Goal を回す2本目の ent の書き込みでも動かない。
 * 何を諦めたかは `guardDigestOf`（`src/store/sqlite.ts`）に書いてある。
 *
 * `ownRuns` はそのティックで controller 自身が作った Run になる。
 * ベースラインの時点ではまだ1件も無く（行そのものが無い）、検査の時点では
 * 作った分だけ挙がる。どちらも同じ射影になるので、前後で値が一致する。
 * 落とした行の不変列は `ownRunDrift` が別に突き合わせる。
 *
 * **`depends_on` も渡す。** 依存ゲート（`dependencyGate`）は他の Goal の
 * `status` を直接読むうえ、その呼び出しは lease を取る前——どのティックの
 * ACT の窓の外——にある。射影に入れないと、`UPDATE goals SET status='COMPLETED'`
 * を依存先へ流すだけでゲートを開けられて、どちらのダイジェストにも差が出ない
 * （design.md §10-6 の (f)）。窓の中で書き換えられた分だけはここで鳴る。
 */
async function observedRepoState(
  goal: Goal,
  ownRuns: readonly OwnRun[],
  deps: ControllerDeps,
): Promise<Map<string, string>> {
  const dirty = await deps.worktree.repoDirtyState();
  const outOfSight = (await deps.worktree.outOfSightState?.()) ?? new Map<string, string>();
  return new Map([
    ...dirty,
    ...outOfSight,
    [
      CONTROLLER_STATE_DB_KEY,
      deps.store.guardDigest(
        goal.goal.id,
        ownRuns.map((own) => own.id),
        goal.goal.depends_on,
      ),
    ],
  ]);
}

/**
 * action が ACT のときだけ Actor を起動する。write-ahead は act 側が持つ。
 *
 * `signal` は deps.signal（SIGTERM）と lease の喪失を束ねたもの。act は
 * これを見て Run を interrupted で確定するので、奪われた側の Run が failed に
 * ならない。意図して止めたものを failed にすると、再試行の上限を無駄に消費する。
 *
 * `observedFacts` は**今ティックの観測が作った Fact だけ**を渡す。act はそこから
 * PR のタイトルと本文を取り出してレビュー役に載せる（`pullRequestTextFrom`）。
 * 持ち越しを混ぜた `result.facts` を渡すと、GitHub を読めなかったティックにも
 * 前回のタイトルと本文が届き、観測の失敗が古い値で埋まって見えなくなる
 * （下の `uncommittedDecision` が `result.observedFacts` を選ぶのと同じ理由）。
 */
async function maybeAct(
  goal: Goal,
  decision: Decision,
  base: string,
  observedFacts: readonly Fact[],
  deps: ControllerDeps,
  signal: AbortSignal,
  ownRuns: OwnRun[],
): Promise<Run | null> {
  if (decision.action.type !== "ACT") {
    return null;
  }

  const goalId = goal.goal.id;
  const intent = decision.action.intent;
  // Run の write-ahead と確定は、ACT の窓の中で controller 自身が状態 DB へ書く
  // 唯一の経路になる（もう1つは lease の延長）。**書いた id をここで控える。**
  // 関門はこの分だけを状態 DB の射影から外すので（`observedRepoState`）、
  // 控え損ねると自分の書き込みで `protected_path_touched` が鳴る。
  //
  // `act` の戻り値からではなく、書いた側で控える。`act` は Run を書いたあとに
  // 中断されても `acted: false` を返しうるし、確定を書けなかった回もある。
  // 行が残った回は必ず id が要る。
  //
  // **意図も一緒に控える。** 射影から行ごと落とすので、`finishRun` が書かない
  // 不変列（`role` など）まで観測の外に出る。ACT の後に、ここで控えた値と
  // 突き合わせる（`ownRunDrift`）。
  const runs: RunRecorderPort = {
    start: async (runIntent) => {
      const runId = deps.store.startRun(goalId, runIntent);
      ownRuns.push({ id: runId, intent: runIntent });
      return runId;
    },
    finish: async (runId, outcome) => {
      deps.store.finishRun(runId, outcome);
    },
  };

  const actDeps: ActDeps = {
    worktree: deps.worktree,
    actor: deps.actor,
    runs,
    signal,
    now: deps.now,
  };

  // 同じ intent の何回目か。Task を持たないので Run の履歴から数える。
  const attempt = deps.store.listRuns(goalId).filter((r) => r.intent === intent).length + 1;
  const result = await act({ goal, decision, attempt, base, facts: observedFacts }, actDeps);
  return result.acted ? result.run : null;
}

/**
 * 予算の消費量を DB から組み立てる。
 *
 * reconciles は saveSnapshot で進むので、このティック分はまだ入っていない。
 * 上限に「到達した次のティック」で止まる形になる。
 */
function usageOf(state: GoalState, goal: Goal, deps: ControllerDeps): BudgetUsage {
  const runs = deps.store.listRuns(goal.goal.id);

  // 解釈できない activated_at を 0 秒として扱うと、max_wall_clock だけが
  // 黙って無効化される（NaN との比較は常に false になる）。停止条件が消えるより、
  // 人間を呼ぶ側に倒す。decide の durationSeconds が上限を読めなかったときと同じ扱い。
  //
  // 人間か外部を待っていた分は引く。待てと指示したのは controller の側なので、
  // その時間を Goal の予算から引くのは筋が通らない（`waitedSeconds`）。
  const now = deps.now();
  const elapsedSeconds = Math.max(
    0,
    elapsedSecondsSince(state.activatedAt, now) -
      waitedSeconds(deps.store.listDecisions(goal.goal.id), state.activatedAt, now),
  );

  // 直近まで同じ観測が続いていた回数。今回のティックは含まない。
  // 含めると、DECIDE が「今回は変わった」を判定できなくなる。
  const digest = deps.store.latestDigest(goal.goal.id);
  const trailingDigest = {
    digest,
    count: digest === null ? 0 : deps.store.countTrailingDigest(goal.goal.id, digest),
  };

  return {
    actorRuns: runs.length,
    reconciles: state.reconciles,
    consecutiveFailures: consecutiveFailuresOf(runs),
    elapsedSeconds,
    trailingDigest,
  };
}
