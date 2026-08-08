import type { ActDeps } from "../act/index.js";
import type { Decision } from "../domain/action.js";
import type { Goal } from "../domain/goal.js";
import type { GoalStatus } from "../domain/goal-state.js";
import type { Run } from "../domain/run.js";
import type { ReconcileDeps } from "../reconcile/index.js";
import type { Store } from "../store/index.js";

/**
 * 1ティックの外側。lease を取り、reconcile を回し、結果を書き、ACT を実行し、
 * 状態を遷移させる。
 *
 * reconcile と act 自体は変更しない。あの2つを純粋に保ったまま、
 * 副作用と永続化をこの層に集める（design.md §8）。
 */

export interface ControllerDeps extends ReconcileDeps, Pick<ActDeps, "worktree" | "actor"> {
  store: Store;
  /** lease の所有者。プロセスごとに一意にする */
  owner: string;
  /** lease の有効期間（秒）。プロセスが死んだらこの時間で解放される */
  leaseSeconds: number;
  /** SIGTERM の伝播。走行中の Actor に伝えて kill する */
  signal?: AbortSignal | undefined;
}

export interface TickResult {
  /** lease を取れずスキップした場合は false */
  ran: boolean;
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
export async function tick(_goal: Goal, _deps: ControllerDeps): Promise<TickResult> {
  throw new Error("not implemented");
}
