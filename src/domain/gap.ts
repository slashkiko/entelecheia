import { z } from "zod";

/**
 * ASSESS の出力。Desired State と Observed State の差分。
 *
 * §3.1 の unresolved（観測・検証できなかった対象）とは別物。
 * unresolved は「確かめられなかった」という観測側の事実で、Gap は
 * 「Goal を満たすために埋める必要がある」という判断にあたる。
 * ただし確かめられていない criteria は Gap の unknown として現れるので、
 * unresolved は Gap に変換される入力の一つになる。
 */
export const gapSchema = z.object({
  criterionId: z.string().min(1),
  /**
   * unmet   — 検証できて、不合格だった。何を直せばよいかが分かっている
   * unknown — まだ検証できていない。埋める前に確かめる必要がある
   *
   * この2つを混ぜると、DECIDE が「直す」と「確かめる」を選び分けられない。
   */
  kind: z.enum(["unmet", "unknown"]),
  /** なぜ Gap と判定したか。人間と LLM の両方が読む */
  detail: z.string(),
});
export type Gap = z.infer<typeof gapSchema>;

export const assessmentSchema = z.object({
  assessedAt: z.string().datetime(),
  gaps: z.array(gapSchema),
  /**
   * 全 criteria を満たしたか。VERIFIED な Fact だけで判定する。
   * gaps が空であることと同値だが、完了判定という意味を型に残すために別に持つ。
   */
  satisfied: z.boolean(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
