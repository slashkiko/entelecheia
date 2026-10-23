import { z } from "zod";
import {
  APPROVAL_RULE_FLOOR,
  type ApprovalRule,
  approvalRuleSchema,
  toApprovalRule,
} from "./approval-rules.js";
import { type AutoMergeableKind, autoMergeableKindSchema } from "./kind.js";

/**
 * `.factory/policy.yaml`（各リポジトリ）と `profile.yaml`（private のプロファイル）の
 * スキーマと、2つを合わせる規則。
 *
 * **core は YAML を読まない。** 呼ぶ側が YAML を値にしてから、ここのスキーマに通す。
 * 設定は人が手で書かず、スキルを使ってエージェントに書かせる前提なので、見やすさより
 * スキーマで検査できることを優先する。キーはどれも `strictObject` で、知らないキーは
 * 誤字として落とす。
 */

/** 作業を自分で見つける出どころ。オーナーが書いた Issue は設定によらず受ける */
export const DISCOVERY_SOURCES = [
  "failing_tests",
  "doctor",
  "lint_warnings",
  "todo",
  "roadmap",
  "ai_review",
] as const;
export const discoverySourceSchema = z.enum(DISCOVERY_SOURCES);
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

/**
 * 上限。数字はどれも監査ログの実測後に決めるので、既定値を持たせない。
 * 書き忘れたときに「大きめの既定値」で回り始めるのを避ける。
 */
const limitsSchema = z.strictObject({
  wip: z.number().int().positive(),
  daily_starts: z.number().int().positive(),
  max_diff_lines: z.number().int().positive(),
});
export type Limits = z.infer<typeof limitsSchema>;

/**
 * holdout と受け入れ条件を人がどこまで読むか。`auto` は監査ログの実績で段を動かし、
 * 残りの3つはその段に固定する（`nextReviewStage`）。
 */
export const reviewModeSchema = z.enum(["auto", "all", "sample", "none"]);
export type ReviewMode = z.infer<typeof reviewModeSchema>;

const roadmapSchema = z.strictObject({
  path: z.string().min(1),
  charter: z.string().min(1).optional(),
});

export const policySchema = z.strictObject({
  version: z.literal(1),
  /** ent に同梱するプリセット。バージョンは `lock.yaml` が持つ */
  presets: z.array(z.string().min(1)).default([]),
  /** プロファイルのプリセット */
  profile_presets: z.array(z.string().min(1)).default([]),
  /** 自動マージを許す種別。プロファイルの `max.auto_merge` の中からだけ選べる */
  auto_merge: z.array(autoMergeableKindSchema).default([]),
  /** 足すだけ。下限は `APPROVAL_RULE_FLOOR` にあり、ここからは外せない */
  approval_rules: z.array(approvalRuleSchema).default([]),
  discovery: z
    .strictObject({
      failing_tests: z.boolean().default(false),
      doctor: z.boolean().default(false),
      lint_warnings: z.boolean().default(false),
      todo: z.boolean().default(false),
      roadmap: z.union([z.literal(false), roadmapSchema]).default(false),
      ai_review: z.boolean().default(false),
    })
    .prefault({}),
  holdout: z.strictObject({ review: reviewModeSchema.default("all") }).prefault({}),
  criteria: z.strictObject({ review: reviewModeSchema.default("all") }).prefault({}),
  release: z.enum(["human", "auto"]).default("human"),
  /** AI レビューの深さ。承認ルールの領域と fix・feat は呼ぶ側が deep に上げる */
  review_depth: z.enum(["quick", "standard", "deep"]).default("standard"),
  limits: limitsSchema,
  actor: z
    .strictObject({
      auth: z.enum(["subscription", "api_key"]).default("subscription"),
      /** `api_key` のとき必須。月額の上限が無い API キーは有効にできない */
      api_monthly_cap_usd: z.number().positive().nullable().default(null),
    })
    .prefault({}),
});
export type Policy = z.infer<typeof policySchema>;

/** `owner/name`。名前の付け替えに追従しないので、ID ではなく照合の鍵にだけ使う */
const repoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

export const profileSchema = z.strictObject({
  version: z.literal(1),
  owner: z.strictObject({
    /** Goal として受ける Issue の作成者。名前ではなく ID で確かめる */
    github_user_id: z.number().int().positive(),
  }),
  /** 依存更新用の GitHub App。無ければ依存更新の例外は成り立たず、全部人がマージする */
  renovate: z.strictObject({ app_id: z.number().int().positive() }).optional(),
  fleet: z
    .array(
      z.strictObject({
        repo: repoNameSchema,
        /** 登録日。登録直後の扱いの起点になる */
        since: z.iso.date(),
      }),
    )
    .default([]),
  /** 全リポジトリに足す承認ルール（重要な計算、永続データの形式など） */
  approval_rules: z.array(approvalRuleSchema).default([]),
  max: z.strictObject({
    auto_merge: z.array(autoMergeableKindSchema).default([]),
    limits: limitsSchema,
    /**
     * ポリシーが有効にできる作業の出どころ。`auto_merge` と同じく、省くと何も有効にできない。
     * 上限を書き忘れたときに、全部が開いた状態で回り始めないようにする
     */
    discovery: z.array(discoverySourceSchema).default([]),
  }),
  allow: z
    .strictObject({
      release_auto: z.boolean().default(false),
      api_key: z.boolean().default(false),
    })
    .prefault({}),
  notify: z
    .strictObject({ channel: z.enum(["github", "slack", "push"]).default("github") })
    .prefault({}),
});
export type Profile = z.infer<typeof profileSchema>;

/** プロファイルとポリシーを合わせた結果。判定はすべてこちらを読む */
export interface EffectivePolicy {
  autoMerge: AutoMergeableKind[];
  /** 下限 → プロファイル → ポリシーの順。どれも足すだけ */
  approvalRules: ApprovalRule[];
  discovery: Set<DiscoverySource>;
  roadmap: { path: string; charter: string | null } | null;
  holdout: ReviewMode;
  criteria: ReviewMode;
  release: "human" | "auto";
  reviewDepth: "quick" | "standard" | "deep";
  limits: Limits;
  actor: { auth: "subscription" } | { auth: "api_key"; monthlyCapUsd: number };
  renovateAppId: number | null;
}

/** ポリシーがプロファイルの範囲を越えた箇所。設定を読む側は、これが1件でもあれば落とす */
export type PolicyViolation =
  | { code: "auto_merge_not_allowed"; kinds: AutoMergeableKind[] }
  | { code: "limit_exceeds_max"; key: keyof Limits; value: number; max: number }
  | { code: "discovery_not_allowed"; sources: DiscoverySource[] }
  | { code: "release_auto_not_allowed" }
  | { code: "api_key_not_allowed" }
  | { code: "api_key_without_cap" };

export type ComposeResult =
  | { ok: true; policy: EffectivePolicy }
  | { ok: false; violations: PolicyViolation[] };

/**
 * プロファイルとポリシーを合わせる。**ポリシーはプロファイルより狭めることしかできない。**
 *
 * - 承認ルールは下限・プロファイル・ポリシーを全部足す。どこからも外せない
 * - 自動マージの種別、上限、作業の出どころは、プロファイルの範囲の中だけ
 * - `release: auto` と API キーは、プロファイルが許したときだけ書ける
 * - API キーは月額の上限を書かないと有効にできない
 *
 * 範囲を越えた値は丸めずに違反として返す。丸めると、書いた人の意図と違う値で
 * 黙って回り始める。違反は全部まとめて返す（1つ直すたびに次が出る形にしない）。
 */
export function composePolicy(profile: Profile, policy: Policy): ComposeResult {
  const violations: PolicyViolation[] = [];

  const allowedKinds = new Set(profile.max.auto_merge);
  const outside = policy.auto_merge.filter((kind) => !allowedKinds.has(kind));
  if (outside.length > 0) {
    violations.push({ code: "auto_merge_not_allowed", kinds: [...new Set(outside)] });
  }

  for (const key of ["wip", "daily_starts", "max_diff_lines"] as const) {
    if (policy.limits[key] > profile.max.limits[key]) {
      violations.push({
        code: "limit_exceeds_max",
        key,
        value: policy.limits[key],
        max: profile.max.limits[key],
      });
    }
  }

  const enabled = enabledSources(policy);
  const allowedSources = new Set(profile.max.discovery);
  const forbidden = [...enabled].filter((source) => !allowedSources.has(source));
  if (forbidden.length > 0) {
    violations.push({ code: "discovery_not_allowed", sources: forbidden });
  }

  if (policy.release === "auto" && !profile.allow.release_auto) {
    violations.push({ code: "release_auto_not_allowed" });
  }

  if (policy.actor.auth === "api_key") {
    if (!profile.allow.api_key) {
      violations.push({ code: "api_key_not_allowed" });
    }
    if (policy.actor.api_monthly_cap_usd === null) {
      violations.push({ code: "api_key_without_cap" });
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  const roadmap = policy.discovery.roadmap;
  const cap = policy.actor.api_monthly_cap_usd;
  return {
    ok: true,
    policy: {
      autoMerge: [...new Set(policy.auto_merge)],
      approvalRules: [
        ...APPROVAL_RULE_FLOOR,
        ...profile.approval_rules.map(toApprovalRule),
        ...policy.approval_rules.map(toApprovalRule),
      ],
      discovery: enabled,
      roadmap: roadmap === false ? null : { path: roadmap.path, charter: roadmap.charter ?? null },
      holdout: policy.holdout.review,
      criteria: policy.criteria.review,
      release: policy.release,
      reviewDepth: policy.review_depth,
      limits: policy.limits,
      actor:
        policy.actor.auth === "api_key" && cap !== null
          ? { auth: "api_key", monthlyCapUsd: cap }
          : { auth: "subscription" },
      renovateAppId: profile.renovate?.app_id ?? null,
    },
  };
}

function enabledSources(policy: Policy): Set<DiscoverySource> {
  const { roadmap, ...flags } = policy.discovery;
  const enabled = new Set<DiscoverySource>(
    (Object.keys(flags) as (keyof typeof flags)[]).filter((key) => flags[key]),
  );
  if (roadmap !== false) {
    enabled.add("roadmap");
  }
  return enabled;
}
