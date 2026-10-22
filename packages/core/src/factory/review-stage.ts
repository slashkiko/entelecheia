import type { ReviewMode } from "./policy.js";

/**
 * holdout と受け入れ条件を、人がどこまで読むかの段。リポジトリごとに別々に持つ。
 *
 * - all: すべて読む。承認するまで検査に使わない
 * - sample: 一定の割合だけ読み、残りはそのまま使う
 * - none: 読まない。週に数件を監査ログに出すだけ
 *
 * 段を上げるのは決定的なコードで、監査ログの実績だけを見る。下げることと固定することは
 * 人も `policy.yaml` でできる（`holdout.review` と `criteria.review` に
 * `all | sample | none` を書く）。承認ルールに当たる領域は、
 * 段に関わらず人がマージする（`decideAutoMerge` の側で決まる）。
 */
export type ReviewStage = "all" | "sample" | "none";

/** 人が読んだ1件の結果。直した・却下したは、Actor 側の案が足りなかったことを意味する */
export type ReviewOutcome = "approved" | "corrected" | "rejected";

export interface ReviewStageInput {
  /** いまの段。`mode` が固定のときは無視する */
  current: ReviewStage;
  mode: ReviewMode;
  /** いまの段で人が読んだ結果。古い順 */
  outcomes: readonly ReviewOutcome[];
  /** いまの段に上がってから、自動マージの後に revert が出たか */
  revertedAfterAutoMerge: boolean;
  /** 上がる判定に使う直近の件数（N）と、直した・却下したの割合の上限。どちらも実測後に決める */
  window: number;
  maxCorrectionRate: number;
}

const UP: Readonly<Record<ReviewStage, ReviewStage>> = {
  all: "sample",
  sample: "none",
  none: "none",
};
const DOWN: Readonly<Record<ReviewStage, ReviewStage>> = {
  all: "all",
  sample: "all",
  none: "sample",
};

/**
 * 次の段を決める。
 *
 * 満たすべき性質:
 * - `mode` が固定（all / sample / none）なら、その段を返す。実績では動かさない
 * - 自動マージの後に revert が出たら1段下げる。上げる条件より先に見る
 * - 抜き取りで却下が出たら1段下げる（all へ戻す）
 * - 直近 N 件が揃い、直した・却下したの割合が上限以下なら1段上げる
 * - N 件に満たないうちは動かさない。少ない件数の偶然で上がらないようにする
 * - 1回に動くのは1段だけ
 */
export function nextReviewStage(input: ReviewStageInput): ReviewStage {
  if (input.mode !== "auto") {
    return input.mode;
  }
  const current = input.current;

  if (input.revertedAfterAutoMerge) {
    return DOWN[current];
  }
  if (current === "sample" && input.outcomes.includes("rejected")) {
    return DOWN[current];
  }

  if (input.window <= 0 || input.outcomes.length < input.window) {
    return current;
  }
  const recent = input.outcomes.slice(-input.window);
  const misses = recent.filter((outcome) => outcome !== "approved").length;
  return misses / recent.length <= input.maxCorrectionRate ? UP[current] : current;
}
