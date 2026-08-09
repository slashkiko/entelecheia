import { createHash } from "node:crypto";
import { join } from "node:path";
import { type ActDeps, act, type RunRecorderPort } from "../act/index.js";
import type { BudgetUsage } from "../decide/index.js";
import type { Decision } from "../domain/action.js";
import type { Fact } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import { type GoalStatus, isTerminal, nextStatus } from "../domain/goal-state.js";
import { describeViolations, findViolations } from "../domain/protected-paths.js";
import type { Run } from "../domain/run.js";
import { toVerifications } from "../domain/verification.js";
import { type PublishDeps, publish } from "../publish/index.js";
import { type ReconcileDeps, reconcile } from "../reconcile/index.js";
import type { GoalState, Store } from "../store/index.js";

/**
 * 1ティックの外側。lease を取り、reconcile を回し、結果を書き、ACT を実行し、
 * 状態を遷移させる。
 *
 * reconcile と act 自体は変更しない。あの2つを純粋に保ったまま、
 * 副作用と永続化をこの層に集める（design.md §8）。
 */

export interface ControllerDeps
  extends ReconcileDeps,
    Pick<ActDeps, "worktree" | "actor">,
    Pick<PublishDeps, "writer" | "branch"> {
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
    status,
  });

  // 終端の Goal を動かし続けると、完了判定が意味を失う。lease も取らない。
  if (state === null) {
    return idle("DRAFT", "Goal が登録されていない");
  }
  if (isTerminal(state.status)) {
    return idle(state.status, `終端状態（${state.status}）なので回さない`);
  }

  // 使用量上限などで寝ている間は回さない（design.md §4.4 と §10-5）。
  // lease も取らない。取ると、寝ているだけの Goal が他のワーカーを塞ぐ。
  const sleeping = sleepingUntil(state.resumeAfter, deps.now());
  if (sleeping !== null) {
    return idle(state.status, `resume_after まで寝ている: ${sleeping}`);
  }

  const until = new Date(deps.now().getTime() + deps.leaseSeconds * 1000);
  if (!deps.store.acquireLease(goalId, deps.owner, until)) {
    // 他のワーカーが処理中。今回のティックはスキップする（design.md §4.5）。
    return idle(state.status, "他のワーカーが lease を持っている");
  }

  try {
    // 回収を reconcile より先に置く。前のプロセスが死んだまま残った Run を
    // 新しい観測より先に確定させないと、同じ Run が二重に数えられる。
    const reclaimed = deps.store.reclaimOrphanRuns(
      goalId,
      "前のティックが確定を書けずに終了した",
      deps.now().toISOString(),
    );

    // 前のティックのダイジェストは、今回の分を書く前に読む。
    const previousDigest = deps.store.latestDigest(goalId);
    const carriedFacts = deps.store.latestSnapshot(goalId)?.facts ?? [];
    const result = await reconcile(
      {
        goal,
        observe: { prNumber: state.prNumber, issueNumber: state.issueNumber },
        carriedFacts,
        usage: usageOf(state, goal, deps),
      },
      deps,
    );

    // Fact と「結論が出なかった対象」を組で書く。片方だけ書くと §3.1 が DB 層で再発する。
    const observedAt = deps.now().toISOString();
    deps.store.saveSnapshot(goalId, {
      observedAt,
      facts: result.facts,
      unresolved: result.unresolved,
    });
    // criteria 単位の索引（design.md §4.5 の Verification）。同じ結果を facts と
    // unresolved から導くだけで、検証をもう一度回さない。二重に検証すると、
    // 同じティックの中で結果が食い違う余地が生まれる。
    const verifications = toVerifications(
      goal.acceptance_criteria,
      result.facts,
      result.unresolved,
      observedAt,
    );
    deps.store.saveVerifications(goalId, verifications);
    // ダイジェストは reconcile が作る。DECIDE がループ検知に使う値なので、
    // 副作用のあるこの層で作り直すと、判断に使った値と記録が食い違いうる。
    const digest = result.observedDigest;
    deps.store.saveDecision(goalId, digest, result.decision);

    const run = await maybeAct(goal, result.decision, deps);

    // Agent が触ってはいけないものに触れていないかを、ACT の外で検査する
    // （design.md §7 / §10-6）。Agent 側の disallowedTools は Agent の設定で、
    // SDK の外から同じ操作をされれば素通りする。
    const guarded = guardedDecision(goal, result.decision, run, deps);
    if (guarded !== result.decision) {
      // 判断を差し替えたので、記録も差し替えた方で残す。
      deps.store.saveDecision(goalId, digest, guarded);
    }

    // PR を確保して進捗を書く。ここは throw しないので、通知の失敗で
    // ティック全体を落とさない（design.md §9 の「PR と通知」）。
    // 保護パスに触れていたら PR は作らない。通常の変更として流れてしまう。
    const published = await publish(
      {
        goal,
        run,
        decision: guarded,
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

    const status = nextStatus(state.status, guarded.action);
    const action = guarded.action;
    deps.store.setStatus(
      goalId,
      status,
      action.type === "WAIT" ? action.resumeAfter : null,
      deps.now().toISOString(),
    );

    return { ran: true, skipped: null, reclaimed, decision: guarded, run, status };
  } finally {
    // 例外で抜けても解放する。残すと lease の期限までどのワーカーも動けない。
    deps.store.releaseLease(goalId, deps.owner);
  }
}

/**
 * Actor が編集したファイルを検査し、違反があれば Decision を差し替える。
 *
 * 満たすべき性質:
 * - ACT を実行していないティックでは何もしない。検査する対象が無い
 * - 違反があれば ESCALATE(protected_path_touched) にする。判断したのは
 *   LLM ではないので decidedBy は "guard"（design.md §7）
 * - worktree の中身は触らない。差分を残しておかないと人間が判断できない
 * - 元の rationale を残す。何をしようとしていたのかが読めなくなる
 */
function guardedDecision(
  goal: Goal,
  decision: Decision,
  run: Run | null,
  deps: ControllerDeps,
): Decision {
  if (run === null || run.artifacts.length === 0) {
    return decision;
  }

  const violations = findViolations(
    run.artifacts,
    // act と同じ規則で worktree の場所を決める。ここがずれると、
    // 隔離の中の編集を「外に出た」と読んでしまう。
    deps.worktreeRoot === undefined ? run.worktree : join(deps.worktreeRoot, run.worktree),
    goal.policies.protected_paths,
  );
  if (violations.length === 0) {
    return decision;
  }

  return {
    decidedAt: deps.now().toISOString(),
    action: { type: "ESCALATE", reason: "protected_path_touched" },
    rationale: `制御ループ自体に触れたので停止する: ${describeViolations(violations)}（元の判断: ${decision.rationale}）`,
    decidedBy: "guard",
  };
}

/**
 * まだ寝ているなら、その時刻を返す。起きてよければ null。
 *
 * 解釈できない値は「起きてよい」と読む。resume_after が壊れているせいで
 * Goal が永久に止まる方が、1ティック早く起きるより悪い。
 */
function sleepingUntil(resumeAfter: string | null, now: Date): string | null {
  if (resumeAfter === null) {
    return null;
  }
  const at = Date.parse(resumeAfter);
  if (Number.isNaN(at) || at <= now.getTime()) {
    return null;
  }
  return resumeAfter;
}

/** action が ACT のときだけ Actor を起動する。write-ahead は act 側が持つ */
async function maybeAct(goal: Goal, decision: Decision, deps: ControllerDeps): Promise<Run | null> {
  if (decision.action.type !== "ACT") {
    return null;
  }

  const goalId = goal.goal.id;
  const intent = decision.action.intent;
  const runs: RunRecorderPort = {
    start: async (runIntent) => deps.store.startRun(goalId, runIntent),
    finish: async (runId, outcome) => {
      deps.store.finishRun(runId, outcome);
    },
  };

  const actDeps: ActDeps = {
    worktree: deps.worktree,
    actor: deps.actor,
    runs,
    signal: deps.signal,
    now: deps.now,
  };

  // 同じ intent の何回目か。Task を持たないので Run の履歴から数える。
  const attempt = deps.store.listRuns(goalId).filter((r) => r.intent === intent).length + 1;
  const result = await act({ goal, decision, attempt }, actDeps);
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

  // 末尾から連続する failed だけを数える。間に成功が挟まれば連続は切れる。
  let consecutiveFailures = 0;
  for (const run of [...runs].reverse()) {
    if (run.status !== "failed") {
      break;
    }
    consecutiveFailures += 1;
  }

  const activatedAt = state.activatedAt === null ? null : Date.parse(state.activatedAt);
  const elapsedSeconds =
    activatedAt === null ? 0 : Math.max(0, Math.floor((deps.now().getTime() - activatedAt) / 1000));

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
    consecutiveFailures,
    elapsedSeconds,
    trailingDigest,
  };
}

/**
 * 観測値のダイジェスト。design.md §4.5 の `Decision.observed_digest` に入る。
 *
 * キー順に正規化してから取る。Fact の並びは観測の順序で決まるので、
 * そのまま食わせると同じ状態でも別のダイジェストになる。
 */
function digestOf(facts: readonly Fact[]): string {
  const normalized = [...facts]
    .map((f) => `${f.key}=${JSON.stringify(f.value ?? null)}@${f.confidence}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}
