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

export const observeResultSchema = z.object({
  observedAt: z.string().datetime(),
  facts: z.array(factSchema),
});
export type ObserveResult = z.infer<typeof observeResultSchema>;

/**
 * COMPLETED 判定に使ってよい Fact だけを残す。
 * 戻り値を VerifiedFact に絞ることで、呼び出し側で evidence の有無を気にしなくて済む。
 */
export function verifiedOnly(facts: readonly Fact[]): VerifiedFact[] {
  return facts.filter((f): f is VerifiedFact => f.confidence === "VERIFIED");
}
