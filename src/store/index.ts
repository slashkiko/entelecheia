import type { Decision } from "../domain/action.js";
import type { Fact, Unresolved } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import type { GoalStatus } from "../domain/goal-state.js";
import type { Run, RunIntent, RunOutcome } from "../domain/run.js";

/**
 * design.md §4.5 のテーブルを SQLite に持つ。
 *
 * 機械だけが書く実行時状態を、人間が編集する `.goals/*.yaml` から分ける（§4.6）。
 * 同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
 *
 * ファイルではなく DB にする理由は §4.7。履歴がクエリになること、クラッシュ整合性、
 * イベントの冪等性の3つで、並行制御は決め手ではない。
 */

/** Goal の実行時状態。Goal YAML には現れない側 */
export interface GoalState {
  id: string;
  status: GoalStatus;
  /** lease の所有者。誰も持っていなければ null */
  leaseOwner: string | null;
  leaseUntil: string | null;
  /** 使用量上限などで待つ場合の再開時刻。分からなければ null */
  resumeAfter: string | null;
  /** ACTIVE にした時刻。経過時間の上限判定に使う */
  activatedAt: string | null;
  /** これまでに回した reconcile の回数 */
  reconciles: number;
  /**
   * 観測対象。Goal YAML は宣言部だけを持つので、ここが置き場になる。
   * PR が未作成なら null。
   */
  prNumber: number | null;
  issueNumber: number | null;
}

export interface Snapshot {
  observedAt: string;
  facts: readonly Fact[];
  /** 観測・検証できなかった対象。DB 層で落とすと §3.1 が DB で再発する */
  unresolved: readonly Unresolved[];
}

export interface Store {
  /** Goal を登録する。既にあれば宣言部だけ更新し、実行時状態は触らない */
  upsertGoal(goal: Goal): void;
  getState(goalId: string): GoalState | null;
  setStatus(goalId: string, status: GoalStatus, resumeAfter: string | null): void;
  setObserveTarget(goalId: string, prNumber: number | null, issueNumber: number | null): void;

  /**
   * lease を取る。取れたら true。
   * 行ロックではなく期限付きの所有権にすることで、クラッシュしても自動で解放される。
   */
  acquireLease(goalId: string, owner: string, until: Date): boolean;
  releaseLease(goalId: string, owner: string): void;

  /** 1ティックの観測結果をまとめて書く。reconciles もここで進める */
  saveSnapshot(goalId: string, snapshot: Snapshot): void;
  /** 直近のスナップショット。facts は次ティックの carriedFacts になる */
  latestSnapshot(goalId: string): Snapshot | null;

  /** design.md §4.5 の Decision テーブル。L5 に食わせる履歴なので必ず残す */
  saveDecision(goalId: string, observedDigest: string, decision: Decision): void;
  /** 古い順。収束したかを見るには並びが要る */
  listDecisions(goalId: string): Decision[];

  /** 副作用の前に意図を書く（§3.6）。戻り値は Run の id */
  startRun(goalId: string, intent: RunIntent): string;
  finishRun(runId: string, outcome: RunOutcome): void;
  /**
   * starting のまま残った Run を interrupted で確定し、その件数を返す。
   * 前のプロセスが死んだまま残った Run を回収する。
   */
  reclaimOrphanRuns(goalId: string, detail: string, finishedAt: string): number;
  listRuns(goalId: string): Run[];

  close(): void;
}

/**
 * SQLite を開いて Store を返す。
 *
 * 実装は Node 24 標準の `node:sqlite` を使う。better-sqlite3 と Drizzle は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 *
 * 満たすべき性質:
 * - WAL を有効にする。複数リーダー + 単一ライターが同時に動く（design.md §4.7）
 * - スキーマは開いた時点で用意する。存在すれば何もしない
 * - `:memory:` を渡せばファイルを作らない。テストはこれを使う
 * - unresolved を落とさない。facts と同じスナップショットに属する行として残す
 */
export function openStore(_path: string): Store {
  throw new Error("not implemented");
}
