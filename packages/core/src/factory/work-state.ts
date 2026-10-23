import type { GoalStatus } from "../domain/goal-state.js";

/**
 * 作業（Issue 1つ）の状態。GitHub のラベル（`factory:*`）と ent の DB の両方に持ち、
 * 食い違ったら GitHub を正とする。
 *
 * ```
 * proposed ─triage─▶ accepted ─criteria─▶ working ─bundle─▶ pr_open ─auto─▶ merged ─bake─▶ done
 *    │                                       │                 │                 │
 *    └expire─▶ rejected                      └──── needs_human ◀┘                 └revert─▶ reverted
 * ```
 */
export type WorkState =
  | "proposed"
  | "accepted"
  | "working"
  | "pr_open"
  | "needs_human"
  | "merged"
  | "done"
  | "reverted"
  | "rejected";

export type WorkEvent =
  /** トリアージが着手を認めた */
  | { type: "triage_accepted" }
  /** proposed のまま期限が来た */
  | { type: "expired" }
  /** 受け入れ条件が承認された（段に応じて人か自動） */
  | { type: "criteria_approved" }
  /** Actor の作業が bundle になり、governor が PR にした */
  | { type: "pr_opened" }
  /** 試行・再実行の上限に達した、または約束違反（bundle が base の子孫でない等） */
  | { type: "escalated"; reason: string }
  /** 検査を最後まで回せなかった（終了コード 3）。上限までは同じ状態で再実行する */
  | { type: "check_infra_error" }
  /** decideAutoMerge の結果 */
  | { type: "decided"; decision: "auto_merge" | "human_merge" }
  /** 自動マージか、人のマージで main に入った */
  | { type: "merged" }
  /**
   * 人が `factory:approved` を付けた。付けた時点の head sha（`approvedSha`）にだけ効き、
   * その後に push されて今の head（`headSha`）が変わっていれば何も起きない。PR が無い
   * 作業（working で上限に達したもの）では `pr` が null になる。
   *
   * 「PR はあるが sha が読めなかった」は表せない。読めなかったときは、この出来事を送らない
   */
  | { type: "human_approved"; pr: { approvedSha: string; headSha: string } | null }
  /** 人か factory が閉じた */
  | { type: "closed" }
  /** bake time を赤なしで過ぎた */
  | { type: "bake_passed" }
  /** merge が原因で main が赤になり、revert した */
  | { type: "reverted" };

/** ここからは遷移しない */
export function isTerminalWork(state: WorkState): boolean {
  return state === "done" || state === "reverted" || state === "rejected";
}

/**
 * 次の状態を決める。当てはまらない出来事は状態を変えない。
 *
 * 不正な出来事を例外にしないのは、GitHub のラベルと ent の DB が食い違ったまま
 * 同じ出来事が2度届くことがあるため（冪等にする）。「受けたが動かなかった」は
 * 呼ぶ側が戻り値と元の状態を比べて分かる。
 *
 * 満たすべき性質:
 * - 終端（done / reverted / rejected）からは動かない
 * - merged を通らずに done と reverted には行かない
 * - 自動マージの判定が「人がマージ」なら needs_human に行く。自動では merged にならない
 * - 人が閉じたら、merge 済みでない限り rejected になる
 * - 人の承認は、付けた時点の head sha が今の head と同じときだけ効く。PR があれば pr_open に
 *   戻して判定をやり直し、PR が無ければ working に戻して Actor を回す
 *
 * `decideAutoMerge` の入力には承認が無い。入力が変わらない限り、やり直しても同じ理由で
 * needs_human に戻る。承認ルールの下限は判定の側で必ず足し直すので、承認ルールに当たる PR も
 * 同じく戻り、人がそのままマージする。承認で何を外すか（承認ルールか、分類器の判定か）は、
 * governor を配線する段で入力に足して決める。それまでは、承認で動くのは「Actor を回し直すか」
 * だけになる
 */
export function nextWorkState(state: WorkState, event: WorkEvent): WorkState {
  if (isTerminalWork(state)) {
    return state;
  }
  if (event.type === "closed") {
    // merge 済みのものは、閉じても main から消えない。bake time の見張りを続ける。
    return state === "merged" ? state : "rejected";
  }

  switch (state) {
    case "proposed":
      if (event.type === "triage_accepted") return "accepted";
      if (event.type === "expired") return "rejected";
      return state;
    case "accepted":
      return event.type === "criteria_approved" ? "working" : state;
    case "working":
      if (event.type === "pr_opened") return "pr_open";
      if (event.type === "escalated") return "needs_human";
      return state;
    case "pr_open":
      if (event.type === "decided") {
        // 自動マージでも、merge したことは merge の出来事で知る。head が動いていれば
        // merge は起きないので、判定だけで merged にはしない。
        return event.decision === "human_merge" ? "needs_human" : state;
      }
      if (event.type === "merged") return "merged";
      if (event.type === "escalated") return "needs_human";
      // check_infra_error は同じ状態のまま再実行する
      return state;
    case "needs_human":
      if (event.type === "merged") return "merged";
      if (event.type === "human_approved") {
        if (event.pr === null) {
          return "working";
        }
        if (event.pr.approvedSha !== event.pr.headSha) {
          // 承認の後に push された。承認したのは今の差分ではない。
          return state;
        }
        // PR があるなら、人が見たのは差分そのもの。Actor を回し直さず、判定をやり直す。
        return "pr_open";
      }
      return state;
    case "merged":
      if (event.type === "bake_passed") return "done";
      if (event.type === "reverted") return "reverted";
      return state;
    case "done":
    case "reverted":
    case "rejected":
      // 先頭の isTerminalWork で返している。型の網羅のためだけに置く。
      return state;
  }
}

/**
 * 作業の状態と、ent の Goal の状態の対応。fleet は Issue から同じ Goal の型を作るので、
 * `ent list` と同じ語で読めるようにする。proposed には Goal がまだ無い。
 */
export const GOAL_STATUS_OF_WORK: Readonly<Record<WorkState, GoalStatus | null>> = {
  proposed: null,
  accepted: "AWAITING_CRITERIA_APPROVAL",
  working: "ACTIVE",
  pr_open: "WAITING_EXTERNAL",
  needs_human: "WAITING_HUMAN",
  merged: "WAITING_EXTERNAL",
  done: "COMPLETED",
  reverted: "FAILED",
  rejected: "ABANDONED",
};
