import { z } from "zod";
import { portErrorKindSchema } from "./port-error.js";

/**
 * Actor を1回起動した記録。design.md §4.5 の Run テーブルに対応する。
 *
 * Task と Plan はここに入れていない。どちらも Plan の永続化が要る概念で、
 * 本 Goal（ACT）の範囲では作る側も読む側も居ないため。
 * `attempt` だけは Task.attempts の代わりに呼び出し側から受け取る。
 */

export const actorKindSchema = z.enum(["claude-code", "codex", "human"]);
export type ActorKind = z.infer<typeof actorKindSchema>;

/** controller から起動できる provider。`human` を除いたもの */
export const launchableActorKindSchema = actorKindSchema.exclude(["human"]);
export type LaunchableActorKind = z.infer<typeof launchableActorKindSchema>;

/**
 * provider ごとの effort の語彙。**片方だけの値をもう片方へ黙って渡さない**
 * （design.md §3.5）。
 *
 * ここに置くのは、読む側が2つに分かれたため。選択の時点で検証する
 * `agentSelectionFrom`（`src/wiring/index.ts`）と、DECIDE が返した
 * `ACT.agent` を採用してよいか見る `askLlm`（`src/decide/index.ts`）になる。
 * decide は合成ルートを import できない（wiring が reconcile 経由で decide を
 * import する）ので、語彙をあちらに置いたままでは受け取り側で検証できない。
 *
 * **SDK の型との突き合わせは wiring に残す。** ここは文字列の集合しか持たず、
 * `@anthropic-ai/claude-agent-sdk` の `EffortLevel` に増減があったときに
 * ビルドで落とす検査は、SDK を import している側（`src/wiring/index.ts`）が
 * 引き続き持つ。ドメインが SDK の型に依存すると、Adapter を差し替えるたびに
 * ドメインが動くことになる。
 */
export const EFFORT_VOCABULARY = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh"],
} as const satisfies Record<LaunchableActorKind, readonly string[]>;

/**
 * その provider がその effort を持つか。
 *
 * 幅を広げる型注釈をここ1箇所に閉じ込める。`EFFORT_VOCABULARY` の各値は
 * リテラルの組（SDK の型との突き合わせに要る）なので、任意の文字列を
 * `includes` に渡すと呼び出し側ごとに cast が要る。
 */
export function supportsEffort(actor: LaunchableActorKind, effort: string): boolean {
  return (EFFORT_VOCABULARY[actor] as readonly string[]).includes(effort);
}

/**
 * Actor の役割。design.md §4.2 の `ActorRole` に対応する。
 *
 * 作業ツリーを分けるかどうかは役割ごとに決まる（`worktreeNameFor`）。分かれるのは
 * `investigate` だけで、**レビュー役は実装役と同じ作業ツリーを読む。**
 * 読む対象が実装役の書いたものである以上、別の木に分けると base のままの
 * コードをレビューすることになる。
 *
 * **その共有は、いまや正しさの前提になっている。** 同じ commit を2度
 * レビューさせない判定（`reviewedHeadOf`・`src/decide/index.ts`）も、古い commit への
 * レビューを未達にする判定（`src/verify/index.ts`）も、`review.reviewed_sha` と
 * 実装役の `local.head_sha` が一致しうることに依存している。レビュー役を別の木へ
 * 移すと、レビュー役の HEAD は base から動かないので二度と一致せず、同じ commit を
 * 延々レビューし続ける形に静かに変わる。移すなら、その2つの判定も一緒に直す。
 *
 * `investigate` は §4.2 が宣言している3つ目で、いまは起動する側が居ない。
 * 型に残しておくのは、あとで足すときに列挙の変更が要らないようにするため。
 */
export const actorRoleSchema = z.enum(["implement", "review", "investigate"]);
export type ActorRole = z.infer<typeof actorRoleSchema>;

/**
 * role を書いていない入力をどう読むか。
 *
 * 既に走っている Goal の Decision には role が無く、DB に残っている Run にも
 * 無い。読み直したときに別の作業ツリーへ移らないよう、実装役として扱う。
 * `worktreeNameFor` の第2引数には既定値を置かない（呼び出し側に「どちらの
 * 作業ツリーの話か」を毎回書かせる）ので、既定はここ1箇所に集める。
 */
export const DEFAULT_ACTOR_ROLE: ActorRole = "implement";

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
  /**
   * どの役割として走ったか。誰がどの作業ツリーで何をしたかを、あとから
   * `ent get` で読めるようにする。
   *
   * 副作用の前に書く側（starting）に置く。確定側に回すと、途中で kill された
   * Run の role が空のまま残り、どの作業ツリーの Run だったのかが読めなくなる。
   */
  role: actorRoleSchema,
  /** 隔離に使う worktree の名前。`investigate` だけが分かれる（`worktreeNameFor`） */
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
  /** Port 境界で分類できた失敗。古い Run との互換のため省略可 */
  errorKind: portErrorKindSchema.optional(),
  /** usage_limit から再開してよい時刻。分からなければ null */
  resumeAfter: z.string().datetime().nullable().optional(),
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
  errorKind: portErrorKindSchema.optional(),
  resumeAfter: z.string().datetime().nullable().optional(),
});
export type Run = z.infer<typeof runSchema>;
