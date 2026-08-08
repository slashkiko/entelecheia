import { z } from "zod";

/**
 * Actor を1回起動した記録。design.md §4.5 の Run テーブルに対応する。
 *
 * Task と Plan はここに入れていない。どちらも Plan の永続化が要る概念で、
 * 本 Goal（ACT）の範囲では作る側も読む側も居ないため。
 * `attempt` だけは Task.attempts の代わりに呼び出し側から受け取る。
 */

export const actorKindSchema = z.enum(["claude-code", "codex", "human"]);
export type ActorKind = z.infer<typeof actorKindSchema>;

/**
 * Run の状態。design.md §3.6 の write-ahead は starting → 確定 の2段で書く。
 *
 * starting のまま残った Run は、プロセスが途中で死んだことを意味する。
 * 次ティックが orphan として回収するので、この状態を消してはいけない。
 * interrupted は SIGTERM で意図的に止めた場合で、failed（Actor が失敗した）とは別。
 */
export const runStatusSchema = z.enum(["starting", "completed", "failed", "interrupted"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * 副作用を出す前に書く意図。これが書けていない状態で Actor を起動しない。
 *
 * worktree には解決済みのパスではなく名前を入れる。パスは WorktreePort が決めるので、
 * 起動前の時点では確定していない。名前は goal.id から決まるので先に書ける。
 */
export const runIntentSchema = z.object({
  /** DECIDE が決めた intent。そのまま Actor へのプロンプトになる */
  intent: z.string().min(1),
  actor: actorKindSchema,
  /** 隔離に使う worktree の名前 */
  worktree: z.string().min(1),
  /** 同じ intent の何回目の試行か */
  attempt: z.number().int().positive(),
  startedAt: z.string().datetime(),
});
export type RunIntent = z.infer<typeof runIntentSchema>;

/** 結果が出たあとに書く確定値。starting には戻さない */
export const runOutcomeSchema = z.object({
  status: z.enum(["completed", "failed", "interrupted"]),
  finishedAt: z.string().datetime(),
  /** Actor を起動できなかった場合は null */
  exitCode: z.number().int().nullable(),
  /** 生ログの置き場所。数十MBの文字列を DB に入れない（design.md §4.6） */
  logRef: z.string().nullable(),
  /**
   * 使ったトークン。Claude Max（OAuth）経由でも必ず記録する（design.md §7）。
   * あとから単価をかければ従量課金だった場合の額を出せる。
   */
  tokens: z.number().int().nonnegative().nullable(),
  /** 変更したファイル、作った PR など。次の OBSERVE の手がかりになる */
  artifacts: z.array(z.string()),
  /** なぜその status になったか。failed と interrupted のときだけ埋まる */
  detail: z.string().nullable(),
});
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const runSchema = runIntentSchema.extend({
  id: z.string().min(1),
  status: runStatusSchema,
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  logRef: z.string().nullable(),
  tokens: z.number().int().nonnegative().nullable(),
  artifacts: z.array(z.string()),
  detail: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;
