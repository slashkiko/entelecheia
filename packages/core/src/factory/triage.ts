import { allowsAutoMerge, type WorkKind } from "./kind.js";
import type { DiscoverySource, EffectivePolicy } from "./policy.js";

/**
 * トリアージ。Issue（人が書いたものと、factory が見つけたもの）に着手してよいかを振り分ける。
 *
 * 決定的なコードで決める。憲章に照らした feat の判定だけは LLM（オーナー役のエージェント）
 * が出すが、ここに届くのはその結論だけで、着手の可否にしか使わない。merge の判定には
 * 使わない（`decideAutoMerge`）。
 *
 * 外部のテキストは材料にしない。第三者の Issue やコメント、スクレイピングの結果、
 * 依存の README、CI のログの本文から作業は作らない。ここで受ける出どころの一覧に
 * それらが無いのはそのため。
 */

/** 作業の出どころ。`owner` はオーナーが書いた Issue（作成者の ID で確かめた後のもの） */
export type WorkSource = "owner" | DiscoverySource;

export interface TriageItem {
  source: WorkSource;
  kind: WorkKind;
  /** 同じ出どころ・同じ対象の作業が、もう開いている */
  duplicate: boolean;
  /** 前に revert された作業と同じ対象。人が解くまで自動では着手しない */
  revertedTarget: boolean;
  /** ロードマップ由来の feat にだけ要る、憲章による判定。憲章が無ければ absent */
  charter?: "accept" | "reject" | "absent";
}

export interface TriageState {
  halted: boolean;
  /** 人の対応待ち（needs_human）の件数 */
  waitingHuman: number;
  /** 今日すでに自動で着手した件数 */
  startedToday: number;
  /** サブスクの枠の残りが少ない */
  quotaLow: boolean;
}

/**
 * 意図をテンプレートで作り、人を待たずに着手してよい種別。設計の決定則が挙げる4つに限る。
 *
 * ポリシーの `auto_merge` は fix と feat まで書けるが、それは merge の判定の話になる。
 * 着手の近道にまで広げると、ロードマップの feat が憲章の判定も WIP の上限も通らずに
 * 着手され、意図もロードマップの項目ではなくテンプレートから作られる。
 */
export const TEMPLATE_KINDS = [
  "deps",
  "lint",
  "flaky",
  "docs",
] as const satisfies readonly WorkKind[];

export type TriageDecision =
  /**
   * 自動で着手する。`template` なら、意図は Issue の本文を読まずテンプレートで作る。
   * factory が見つけた auto_merge の種別の作業がこれにあたる
   */
  | { decision: "start"; template: boolean }
  /** 今は着手しない。次のティックで同じ判定をやり直す */
  | { decision: "hold"; reason: "wip_limit" | "daily_limit" | "quota_low" }
  /** proposed として起票し、人の判断を待つ。件数と期限に上限がある */
  | { decision: "propose"; reason: "reverted_target" | "no_charter" }
  /** 着手しない */
  | { decision: "reject"; reason: "halted" | "duplicate" | "source_disabled" | "charter_rejected" };

/**
 * 着手を決める。上から順に見て、最初に当たったもので決まる。
 *
 * 1. factory が止まっている（halt） → 拒否
 * 2. 同じ作業が開いている → 拒否（同じ出どころ・同じ対象を重複させない）
 * 3. factory が見つけた作業で、その出どころがポリシーで無効 → 拒否
 * 4. revert された作業と同じ対象 → proposed（人が解くまで自動では着手しない）
 * 5. 1日の上限に達した → 保留
 * 6. 枠の残りが少ない → 保留（deps は Actor を動かさないので除く）
 * 7. 種別が `TEMPLATE_KINDS` にあり、ポリシーの auto_merge にもある → 着手（見つけた作業
 *    なら、意図はテンプレートで作る）
 * 8. 人の対応待ちが WIP の上限以上 → 保留（7 で抜けた種別は人の手を待たないので止めない）
 * 9. オーナーが書いた Issue → 着手
 * 10. ロードマップ由来 → 憲章が認めれば着手、退ければ拒否、憲章が無ければ proposed
 * 11. それ以外の見つけた作業（落ちたテスト・doctor・警告・TODO・AI レビュー） → 着手
 *
 * 予算（枠の残り）は着手の判定にだけ使い、merge の判定には入れない。merge に入れると、
 * 枠が減るほど人の承認が増える。
 */
export function triage(
  item: TriageItem,
  state: TriageState,
  policy: EffectivePolicy,
): TriageDecision {
  if (state.halted) {
    return { decision: "reject", reason: "halted" };
  }
  if (item.duplicate) {
    return { decision: "reject", reason: "duplicate" };
  }
  if (item.source !== "owner" && !policy.discovery.has(item.source)) {
    return { decision: "reject", reason: "source_disabled" };
  }
  if (item.revertedTarget) {
    return { decision: "propose", reason: "reverted_target" };
  }
  if (state.startedToday >= policy.limits.daily_starts) {
    return { decision: "hold", reason: "daily_limit" };
  }
  if (state.quotaLow && item.kind !== "deps") {
    return { decision: "hold", reason: "quota_low" };
  }
  if (isTemplateKind(item.kind) && allowsAutoMerge(policy.autoMerge, item.kind)) {
    // オーナーの Issue は外部テキストではないので、本文から意図を作ってよい。
    return { decision: "start", template: item.source !== "owner" };
  }
  if (state.waitingHuman >= policy.limits.wip) {
    return { decision: "hold", reason: "wip_limit" };
  }
  if (item.source === "owner") {
    return { decision: "start", template: false };
  }
  if (item.source === "roadmap") {
    switch (item.charter ?? "absent") {
      case "accept":
        return { decision: "start", template: false };
      case "reject":
        return { decision: "reject", reason: "charter_rejected" };
      case "absent":
        return { decision: "propose", reason: "no_charter" };
    }
  }
  return { decision: "start", template: false };
}

function isTemplateKind(kind: WorkKind): boolean {
  return (TEMPLATE_KINDS as readonly WorkKind[]).includes(kind);
}
