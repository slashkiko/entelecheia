/**
 * fleet に登録したリポジトリの状態。登録直後 → 通常 → 一時停止 → 通常、の3つ。
 *
 * - 登録直後（onboarding）は自動マージをしない。人がマージした PR が K 件、revert なしで
 *   bake time を過ぎたら通常に上がる
 * - revert が出ると、どの状態からでも一時停止（suspended）になる
 * - 一時停止から戻すのは人だけ。factory が自分で戻す道は無い
 *
 * halt はこの3つとは別に重なる旗で、ここでは持たない。立っている間は状態に関わらず
 * 何もしない、という扱いは判定の側（`decideAutoMerge`・`triage`）が受け持つ。
 */
export type RepoPhase = "onboarding" | "normal" | "suspended";

export type RepoState =
  | { phase: "onboarding"; cleanMerges: number }
  | { phase: "normal" }
  | { phase: "suspended"; reason: string };

export type RepoEvent =
  /** merge した PR が、赤を出さずに bake time を過ぎた */
  | { type: "bake_passed" }
  /** merge が原因で main が赤になり、revert した */
  | { type: "reverted"; reason: string }
  /** 人が再開した。`by` は人だけを受ける形にしてある */
  | { type: "resumed"; by: "human" };

export const INITIAL_REPO_STATE: RepoState = { phase: "onboarding", cleanMerges: 0 };

/**
 * 次の状態を決める。`cleanMergesToGraduate` は K（登録直後を抜けるのに要る件数）で、
 * 監査ログの実測後に決めるので、呼ぶ側が渡す。
 *
 * 満たすべき性質:
 * - revert はどの状態からでも一時停止にする。登録直後の数えかけも捨てる
 * - 一時停止は `resumed` でしか抜けない。`bake_passed` が何回来ても一時停止のまま
 * - 再開した先は通常にする。登録直後へは戻さない（登録直後は1度だけ通る）
 * - 当てはまらない出来事は状態を変えない
 */
export function nextRepoState(
  state: RepoState,
  event: RepoEvent,
  cleanMergesToGraduate: number,
): RepoState {
  if (event.type === "reverted") {
    return { phase: "suspended", reason: event.reason };
  }

  switch (state.phase) {
    case "onboarding": {
      if (event.type !== "bake_passed") {
        return state;
      }
      const cleanMerges = state.cleanMerges + 1;
      return cleanMerges >= cleanMergesToGraduate
        ? { phase: "normal" }
        : { phase: "onboarding", cleanMerges };
    }
    case "normal":
      return state;
    case "suspended":
      return event.type === "resumed" ? { phase: "normal" } : state;
  }
}
