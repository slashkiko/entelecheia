import { z } from "zod";

/**
 * LlmPort を1回呼んだ記録。
 *
 * design.md §7 は「トークン使用量は必ず記録する」と書いているが、その置き場は
 * `Run.tokens` しか用意されていなかった。DECIDE の LLM 呼び出しは Actor を
 * 起動しないので Run を作らず、結果として DECIDE 分のトークンが1件も残らない。
 * ASSESS と DECIDE を Actor 層経由に寄せた（§3.5）以上、消費はここにも出る。
 *
 * Run とは別のテーブルにする。Run は worktree と attempt を持つ「Actor を1回
 * 起動した記録」で、判断のための1問1答とはライフサイクルが違う。同じ行に混ぜると
 * `max_actor_runs` の数え方が壊れる。
 */
export const llmCallSchema = z.object({
  /** 何のために呼んだか。いまは DECIDE だけだが、ASSESS を寄せたときに増える */
  purpose: z.literal("decide"),
  /** 入力と出力の合計。単価をかければ「従量課金だったらいくらだったか」が出る */
  tokens: z.number().int().nonnegative(),
  /** 生ログのパス。DB には入れない（design.md §4.6） */
  logRef: z.string().min(1),
  /** 採用できる応答が返ったか。失敗した呼び出しもトークンは消費している */
  ok: z.boolean(),
  calledAt: z.string().datetime(),
});
export type LlmCall = z.infer<typeof llmCallSchema>;
