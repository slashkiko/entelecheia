import type { Decision } from "../domain/action.js";
import type { Snapshot } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import type { GoalListItem, GoalState, GoalStatus } from "../domain/goal-state.js";
import type { LlmCall } from "../domain/llm-call.js";
import type { Run, RunIntent, RunOutcome } from "../domain/run.js";
import type { Verification } from "../domain/verification.js";

/**
 * 実行時状態を書き出す先の Port。**使う側が所有する口**で、実装は持たない。
 *
 * design.md §4.1 の Port は「その段階が実際に呼ぶメソッドだけを並べる、テストで
 * 差し替える単位」を指す。ここは controller と CLI が呼ぶ分を並べたもので、
 * SQLite であることはこの口からは見えない。
 *
 * **かつてこの宣言は SQLite 実装そのもの（`src/store/index.ts`）にあった。**
 * `src/controller/index.ts` が永続化のファイルを名指しで import しており、
 * 内側が外側を参照する唯一の経路になっていた。しかも `src/store/` は
 * `src/adapters/` の下に無いので、「Adapter を import してよいのは合成ルートだけ」
 * というルールの網にも掛かっていなかった（design.md §3.3）。実装を
 * `src/store/sqlite.ts` に分け、そちらを import してよい場所を合成ルートに絞る。
 *
 * DB を持つ理由そのものは design.md §4.7、テーブルの割り方は §4.5 にある。
 */
export interface Store {
  /** Goal を登録する。既にあれば宣言部だけ更新し、実行時状態は触らない */
  upsertGoal(goal: Goal): void;
  getState(goalId: string): GoalState | null;
  /** 登録済みの Goal を id の昇順で一覧する */
  listGoals(): GoalListItem[];
  /**
   * 状態を書く。時刻は store が作らず、呼び出し側の時計から受け取る。
   * store が `new Date()` を使うと、注入した時計で動くティックと時間軸がずれる。
   *
   * `activatedAt` を渡すと、ACTIVE に入る時点でだけ activated_at を埋める。
   * 経過時間の上限（design.md §7）の起点になる。
   */
  setStatus(
    goalId: string,
    status: GoalStatus,
    resumeAfter: string | null,
    activatedAt?: string,
  ): void;
  setObserveTarget(goalId: string, prNumber: number | null, issueNumber: number | null): void;

  /**
   * 関門が差分を取る相手を記録する（`GoalState.guardBaseSha`）。
   *
   * 書くのは `ent start` の1回だけにする。走行中に書き換えられる口を作ると、
   * 「Actor が何を書いたか」の基準が途中で動く。基準が動く関門は、同じ差分に
   * 対して別の答えを返すので、止まった理由をあとから再現できない。
   */
  setGuardBase(goalId: string, sha: string): void;

  /**
   * 「もう追わない」を1回で書く。status を ABANDONED にし、理由を残す。
   *
   * `setStatus` と分けてある。ABANDONED だけは理由と対で意味を持つので、
   * status を任意に選べる口から書けると、理由の無い ABANDONED が作れてしまう。
   * 完了（COMPLETED）はここから書けない。完了判定は VERIFIED のみ（§3.1）。
   *
   * 落とせるかの判定（終端か、lease を持っていないか）は呼び出し側で行う。
   * store は書くだけにして、断る理由を CLI と controller で二重に持たない。
   */
  abandon(goalId: string, reason: string): void;

  /**
   * lease を取る。取れたら true。同じ owner で呼び直せば期限を延長する。
   * 行ロックではなく期限付きの所有権にすることで、クラッシュしても自動で解放される。
   *
   * 期限切れの判定に使う `now` も引数で受け取る。ここだけ store が実時計を
   * 読んでいたので、注入した時計で動くティックと時間軸が分かれ、
   * 「期限切れの lease を奪う」経路をテストから再現できなかった。
   */
  acquireLease(goalId: string, owner: string, until: Date, now: Date): boolean;
  releaseLease(goalId: string, owner: string): void;

  /** 1ティックの観測結果をまとめて書く。reconciles もここで進める */
  saveSnapshot(goalId: string, snapshot: Snapshot): void;
  /** 直近のスナップショット。facts は次ティックの carriedFacts になる */
  latestSnapshot(goalId: string): Snapshot | null;

  /**
   * design.md §4.5 の Verification テーブル。criteria 単位の索引になる。
   * facts の `criteria.<id>.passed` と二重表現になるが、§4.5 の役割分担に従う。
   */
  saveVerifications(goalId: string, verifications: readonly Verification[]): void;
  /** 直近のティックの検証結果。§9 の完了判定はこれを読む */
  latestVerifications(goalId: string): Verification[];

  /** design.md §4.5 の Decision テーブル。L5 に食わせる履歴なので必ず残す */
  saveDecision(goalId: string, observedDigest: string, decision: Decision): void;
  /** 古い順。収束したかを見るには並びが要る */
  listDecisions(goalId: string): Decision[];
  /**
   * 直近の Decision に付いた観測ダイジェスト。1件も無ければ null。
   * 「前のティックから状態が変わったか」を、Fact を読み直さずに判定する。
   */
  latestDigest(goalId: string): string | null;
  /**
   * 末尾から数えて、同じ観測ダイジェストが何回連続しているか。
   * ループ検知（design.md §7 の `max_unchanged_reconciles`）が読む。
   */
  countTrailingDigest(goalId: string, digest: string): number;

  /**
   * LlmPort を1回呼んだ記録。Run とは別に持つ（design.md §7）。
   * 呼んだ直後に書く。まとめて後から書くと、途中で kill されたぶんが消える。
   */
  recordLlmCall(goalId: string, call: LlmCall): void;
  /** 古い順。トークンの合計はここから出す */
  listLlmCalls(goalId: string): LlmCall[];

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
