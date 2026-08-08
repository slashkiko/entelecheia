import { z } from "zod";

/**
 * DECIDE が選ぶ行動。design.md §1 の図の分岐にあたる。
 *
 * PLAN → ACT → VERIFY を固定の workflow にしない。REPLAN も分岐先の一つで、
 * Plan の更新は DECIDE が選べる行動にすぎない。
 */

/** 待ちの理由。いずれも reconcile は即 return し、次のティックを待つ */
export const waitReasonSchema = z.enum([
  /** レビュー承認待ち。design.md §4.4 の WAITING_HUMAN(review_pending) */
  "review_pending",
  /** CI 完了待ち。WAITING_EXTERNAL(ci_running) */
  "ci_running",
  /** Claude の使用量上限。WAITING_EXTERNAL(usage_limit) */
  "usage_limit",
  /** Port が落ちていて観測できない。次ティックで再試行する */
  "observation_failed",
]);
export type WaitReason = z.infer<typeof waitReasonSchema>;

/** ESCALATE の理由。人間を呼ぶ必要がある状況 */
export const escalateReasonSchema = z.enum([
  "budget_exhausted",
  /** 同じ Gap が解消されないまま繰り返している */
  "loop_detected",
  /** LLM の出力が Zod を通らなかった */
  "invalid_decision",
]);
export type EscalateReason = z.infer<typeof escalateReasonSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("COMPLETE") }),
  /** Actor に実装させる。intent はそのまま Claude Code へのプロンプトになる */
  z.object({ type: z.literal("ACT"), intent: z.string().min(1) }),
  /** criteria を検証しにいく。Fact が無くて判定できないときに選ぶ */
  z.object({ type: z.literal("VERIFY") }),
  z.object({
    type: z.literal("WAIT"),
    reason: waitReasonSchema,
    /** 再開してよい時刻。分からなければ null にして指数バックオフに任せる */
    resumeAfter: z.string().datetime().nullable(),
  }),
  z.object({ type: z.literal("ESCALATE"), reason: escalateReasonSchema }),
  /** Plan を作り直す。今の Plan では Gap が埋まらないと判断したとき */
  z.object({ type: z.literal("REPLAN") }),
]);
export type Action = z.infer<typeof actionSchema>;

export const decisionSchema = z.object({
  decidedAt: z.string().datetime(),
  action: actionSchema,
  /** なぜその行動を選んだか。design.md §4.5 の Decision テーブルにそのまま入る */
  rationale: z.string().min(1),
  /**
   * guard — 純ロジックで決めた。LLM を呼んでいない
   * llm   — LlmPort の出力を Zod で検証して採用した
   *
   * L5 の改善レイヤーが「どちらの判断が当たっていたか」を後から集計できるように残す。
   */
  decidedBy: z.enum(["guard", "llm"]),
});
export type Decision = z.infer<typeof decisionSchema>;
