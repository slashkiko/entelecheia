import { z } from "zod";
import { actorRoleSchema } from "./run.js";

/**
 * DECIDE が選ぶ行動。design.md §1 の図の分岐にあたる。
 *
 * PLAN → ACT → VERIFY を固定の workflow にしない。REPLAN も分岐先の一つで、
 * Plan の更新は DECIDE が選べる行動にすぎない。
 */

/** 待ちの理由。いずれも reconcile は即 return し、次のティックを待つ */
export const waitReasonSchema = z.enum([
  /**
   * 人間の承認待ち。design.md §4.4 の WAITING_HUMAN にあたる。
   *
   * `review_pending` を名指しし直したもの。あちらは「人間の承認待ち」と
   * 「controller 自身のレビュー役の結論待ち」の両方に読めた。controller の
   * レビュー役に待つ状態は無い（レビュー役は ACT で同期に走る）ので、後者に
   * 与える語は無く、待つ相手が人間であることを語の側に書いておく。
   */
  "human_review_pending",
  /**
   * `human_review_pending` の旧名。新しく選ぶことはない。
   *
   * **消さない。** decisions テーブルは読むたびに `actionSchema.parse` を通る
   * （`listDecisions`）ので、enum から落とすと既に走っている Goal の行が
   * そこで落ち、履歴を読み直せなくなる。語は入れ替えるのではなく足す。
   * 遷移先は `human_review_pending` と同じ WAITING_HUMAN のままにする。
   */
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
  /**
   * Agent が保護パスを書き換えた、あるいは worktree の外に出た。
   *
   * design.md §7 の自己ホスト用の制約。予算でもループでも出力の不正でもなく、
   * 「触ってはいけないものに触れた」なので、既存の3つとは別に立てる。
   */
  "protected_path_touched",
  /**
   * 保護パスの検査そのものができなかった。
   *
   * 「触っていない」と「確かめられなかった」を混ぜない（design.md §3.1）。
   * 関門が動いていない状態で先へ進めるのは、関門が無いのと同じになる。
   */
  "guard_unavailable",
  /**
   * Actor が書いた変更が commit されないまま worktree に残っている。
   *
   * push は commit 済みの差分しか送らないので、この状態で「機械側にやることは
   * 残っていない」と言い切ると、実装が1行も remote に出ないまま Goal が
   * COMPLETED か WAITING_HUMAN で止まる（design.md §10-11）。
   * 触ってはいけないものに触れたわけではないので protected_path_touched とは別に立てる。
   */
  "uncommitted_changes",
  /**
   * Port の応答は届いたが、こちらのスキーマで解釈できなかった。
   *
   * `port_failed`（届かなかった）と分けてあるのは、待っても直らないため。
   * GitHub がフィールドを変えたか、こちらのスキーマが厳しすぎるかのどちらかで、
   * 次のティックでも同じ応答が同じように落ちる。`WAIT(observation_failed)` に
   * 畳むと、Gap ゼロの WAIT はループ検知より手前で return するので、予算に
   * 当たるまで毎ティック再試行される。そのあいだ人間には「GitHub が不安定」に
   * 見えて、スキーマの不一致だと気づけない。
   *
   * 待っても直らないと分かっているなら、待つのではなく人間を呼ぶ。停止条件なので
   * LLM には決めさせない（design.md §7）。届かなかった失敗（`port_failed`）は
   * これまでどおり `WAIT(observation_failed)` のままにする。
   */
  "shape_mismatch",
  /**
   * `policies.publish.push_branch: manual` を宣言しているので push しなかった。
   *
   * `protected_path_touched` とは別に立てる。あちらは「触ってはいけないものに
   * 触れた」で、こちらは**人間がそう宣言したから止まった**になる。同じ WAITING_HUMAN に
   * 畳まれるので、reason を分けないと `ent list` からは見分けられない。
   *
   * **どちらも、人間が手を動かすだけでは解けない。** 前者は worktree を掃除するまで
   * 進まない。後者は `ensurePullRequest` が push の要否を決める前に返すので、人間が
   * 手で push しても publish はそれを一度も見ず、宣言を `auto` に戻すまで毎ティック
   * 同じところで止まる。`open_pull_request_declared_manual` とはここが違う。
   *
   * 宣言部のキー名をそのまま reason にしてある。読んだ人間が `.goals/<slug>.yaml` の
   * どの行を書き換えれば挙動が変わるのかを、翻訳表なしで辿れるようにする。
   */
  "push_branch_declared_manual",
  /**
   * `policies.publish.open_pull_request: manual` を宣言しているので PR を作らなかった。
   *
   * push は済んでいるので、人間が PR を立てれば次のティックがそれを見つけて進む
   * （`findPullRequest`）。宣言を書き換えなくても解ける側の停止になる。
   */
  "open_pull_request_declared_manual",
  /**
   * 実装が進まないまま、レビュー役だけを回そうとしている。
   *
   * 直近のレビューが現在の HEAD を既に読んでいるあいだ、DECIDE は選べる行動から
   * レビュー役を外す。それでも LLM がレビュー役を返し続け、再試行を使い切った
   * 状態がこれにあたる。
   *
   * `invalid_decision` に畳まない。出力の形が壊れているのではなく、
   * 同じ commit を2度レビューさせようとしている状態で、止めた理由を読む人間には
   * 別のものとして届く必要がある。
   *
   * **止まるのはこの形だけになる。** `changes_requested` → 修正 → 再レビューを
   * 繰り返す本来の非収束は、実装が毎回進むので `review.reviewed_sha` が変わり、
   * ここでは止まらない。そちらの天井は `max_actor_runs` が受け持つ。
   */
  "review_not_converging",
]);
export type EscalateReason = z.infer<typeof escalateReasonSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("COMPLETE") }),
  /** Actor に実装させる。intent はそのまま Claude Code へのプロンプトになる */
  z.object({
    type: z.literal("ACT"),
    intent: z.string().min(1),
    /**
     * どの役割の Actor を起動するか。書かなければ実装役として扱う
     * （`DEFAULT_ACTOR_ROLE`）。
     *
     * 任意にしてあるのは、既に走っている Goal の Decision に role が無いため。
     * 必須にすると、読み直した時点で既存の ACT が Zod に落ちる。
     */
    role: actorRoleSchema.optional(),
  }),
  /** criteria を検証しにいく。Fact が無くて判定できないときに選ぶ */
  z.object({ type: z.literal("VERIFY") }),
  z.object({
    type: z.literal("WAIT"),
    reason: waitReasonSchema,
    /**
     * 再開してよい時刻。分からなければ null にして指数バックオフに任せる。
     *
     * 省略も null と同じに扱う。LLM は `{"type":"WAIT","reason":"human_review_pending"}` を
     * 返してきたが、必須にしていたせいで弾かれ、再試行に3万トークン以上かかった。
     * 「キーが無い」と「分からない」を区別しても controller の分岐は変わらない。
     */
    resumeAfter: z.string().datetime().nullable().default(null),
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
