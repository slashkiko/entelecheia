import { z } from "zod";

/**
 * Fact の出所と信頼度。
 *
 * VERIFIED — 外部から検証可能な一次情報だけに与える。
 *   検証コマンドの終了コード、CI の conclusion、GitHub API のレスポンス、git の出力。
 * INFERRED — LLM の推論やコード読解。Plan の材料には使ってよいが、
 *   Goal を COMPLETED にする判定には使わない。
 *
 * 「Agent がそう思っているだけ」と「実際に確認できた」を型で分離するのが目的。
 * VERIFIED には evidence を必須にして、あとから人間が追跡できない主張を作れなくする。
 */
export const evidenceSchema = z.object({
  /** 何を実行・参照して得た値か。コマンド行、API パス、ログ URL など */
  source: z.string().min(1),
  /** 終了コード、レスポンス断片、失敗ジョブ名など、追跡の手がかり */
  detail: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

const factBase = {
  /** ドット区切りの観測キー。例: "github.ci.conclusion" */
  key: z.string().min(1),
  value: z.unknown(),
  observedAt: z.string().datetime(),
};

export const verifiedFactSchema = z.object({
  ...factBase,
  confidence: z.literal("VERIFIED"),
  evidence: evidenceSchema,
});

export const inferredFactSchema = z.object({
  ...factBase,
  confidence: z.literal("INFERRED"),
  evidence: evidenceSchema.optional(),
});

export const factSchema = z.discriminatedUnion("confidence", [
  verifiedFactSchema,
  inferredFactSchema,
]);
export type Fact = z.infer<typeof factSchema>;
export type VerifiedFact = z.infer<typeof verifiedFactSchema>;
export type InferredFact = z.infer<typeof inferredFactSchema>;

/**
 * 観測・検証を試みたが結論を出せなかった対象。
 *
 * Fact を作らないだけだと「対象が存在しない」と「対象を確かめられなかった」が
 * どちらも Fact の不在に畳まれ、GitHub の障害が「PR は無い」と読めてしまう。
 * 捏造せずに区別を残すため、Fact の外側に理由付きで積む。
 *
 * ASSESS が出す「desired と observed の差分」とは別物なので Gap とは呼ばない。
 */
export const unresolvedSchema = z.object({
  /** 結論が出れば入るはずだった観測キー */
  key: z.string().min(1),
  /**
   * port_failed — Port が throw した。外部が落ちている可能性がある
   * pending     — 手続きとしてまだ結論が出ていない。人間の承認待ち、参照先 Fact の不在など
   */
  reason: z.enum(["port_failed", "pending"]),
  /** どの呼び出しが、なぜ結論に至らなかったか */
  detail: z.string(),
});
export type Unresolved = z.infer<typeof unresolvedSchema>;

export const observeResultSchema = z.object({
  observedAt: z.string().datetime(),
  facts: z.array(factSchema),
  /** 観測を試みて結論が出なかったもの。空配列は「取りこぼしなし」を意味する */
  unobserved: z.array(unresolvedSchema),
});
export type ObserveResult = z.infer<typeof observeResultSchema>;

export const verifyResultSchema = z.object({
  verifiedAt: z.string().datetime(),
  /** criteria.<id>.passed。true/false のどちらも「検証できた」結果なので VERIFIED */
  facts: z.array(factSchema),
  /** 検証を試みて結論が出なかった criteria。落ちた criteria とは別物 */
  unverified: z.array(unresolvedSchema),
});
export type VerifyResult = z.infer<typeof verifyResultSchema>;

/**
 * COMPLETED 判定に使ってよい Fact だけを残す。
 * 戻り値を VerifiedFact に絞ることで、呼び出し側で evidence の有無を気にしなくて済む。
 */
export function verifiedOnly(facts: readonly Fact[]): VerifiedFact[] {
  return facts.filter((f): f is VerifiedFact => f.confidence === "VERIFIED");
}
