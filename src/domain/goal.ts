import { z } from "zod";
import { observedFactKeySchema } from "./fact-keys.js";

/**
 * `.goals/<slug>.yaml` のスキーマ。
 *
 * Phase 0（人間による手動リコンサイル）を1周した結果を反映してある。
 * 残す・消すの基準は「その項目を誰が読むか」で、Phase 0 で読まれたかどうかではない。
 * budget と policies は Phase 0 で読まれなかったが、読み手は controller であって
 * ACT を担う側ではないので残している。
 *
 * design.md §4.6 のとおり、ここは人間が編集する宣言部だけを持つ。
 * status や lease のような実行時状態は SQLite 側が持ち、この YAML には現れない。
 *
 * フィールド名は YAML の snake_case をそのまま使う。camelCase に直す層を挟むと
 * YAML とスキーマの対応表が暗黙に生まれ、Phase 0 で `head_sha` と `headSha` の
 * 対応が読み取れずに詰まったのと同じ問題を再生産するため。
 *
 * すべて strictObject にしてある。既定の z.object は未知キーを黙って捨てるが、
 * 手書き YAML の未知キーは typo か旧スキーマの残骸で、捨てると人間の意図が
 * 無言で消える。Phase 0 で「観測失敗を黙って落とすのは危険」と分かったのと同じ理由。
 */

/** setup と verification.run が受け取るシェルコマンド */
const shellCommandSchema = z.string().min(1);

/**
 * 観測対象のリポジトリ。
 *
 * Phase 0 では evidence.source に `GET /repos/{owner}/{repo}/pulls/12` を書けなかった。
 * observe() が owner/repo を知らず、Port 呼び出し名で代用するしかなかったためで、
 * 「人間が追跡できる evidence」という §3.1 の要件を満たしきれていなかった。
 * リポジトリ識別子は Goal ごとに決まるので宣言部に置く。
 *
 * Phase 0 の adapters（code / review / communication / ci を個別指定）はここに畳んだ。
 * MVP では4つとも GitHub 固定（design.md §5）で、Goal ごとに変える理由が無い。
 */
export const repositorySchema = z.strictObject({
  provider: z.literal("github"),
  owner: z.string().min(1),
  name: z.string().min(1),
  default_branch: z.string().min(1),
});
export type Repository = z.infer<typeof repositorySchema>;

/**
 * 検証コマンドを実行できる状態にする手順。
 *
 * Phase 0 では AC の verification が `mise run test` を指す一方、それを実行可能にする
 * 手順が YAML になく、CI が落ちた時点で「その前提は誰の責任か」が決まっていないと分かった。
 * VERIFY は criteria を1件でも実行する前にここを1度だけ流す。冪等であることが前提。
 */
export const setupSchema = z.array(shellCommandSchema);

/**
 * criteria の検証手段。design.md §3.2 により、ここに落とせない criteria は登録できない。
 *
 * - command — コマンドを実行し、終了コードで判定する
 * - fact    — OBSERVE が返した Fact の値と比較する。CI の結果はこちら
 * - human   — 人間が明示的に承認する。VERIFY は判定せず pending を返す
 *
 * fact が参照できるのは OBSERVE 由来のキーだけで、他の criteria の結果は参照できない。
 * 循環する criteria を YAML の時点で書けなくするため。
 */
export const verificationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("command"),
    run: shellCommandSchema,
  }),
  z.strictObject({
    type: z.literal("fact"),
    key: observedFactKeySchema,
    equals: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.strictObject({
    type: z.literal("human"),
    /** 承認者に何を確認させるか。VERIFY はこれをそのまま提示する */
    prompt: z.string().min(1),
  }),
]);
export type Verification = z.infer<typeof verificationSchema>;

export const acceptanceCriterionSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  verification: verificationSchema,
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

/**
 * 人間の承認を必須にする操作。design.md §7 の列挙をそのまま型にする。
 * 自由文字列にすると controller 側で照合できないので閉じた集合にしてある。
 */
export const approvalGateSchema = z.enum([
  "merge",
  "force_push",
  "push_to_default_branch",
  "deploy",
  "secret_access",
  "external_send",
]);
export type ApprovalGate = z.infer<typeof approvalGateSchema>;

/** `30s` / `10m` / `6h` 形式。controller が待機と打ち切りの判定に使う */
const DURATION = /^(\d+)([smh])$/;
const durationSchema = z.string().regex(DURATION, "duration は 30s / 10m / 6h の形式で書く");

/**
 * `30s` / `10m` / `6h` を秒に直す。解釈できなければ null。
 *
 * 形式を決めているスキーマの隣に置く。読む側（DECIDE の予算判定）に
 * 別の正規表現があると、`d` を足すような変更が2箇所に散る。
 */
export function durationSeconds(duration: string): number | null {
  const matched = DURATION.exec(duration);
  if (matched === null) {
    return null;
  }

  const amount = Number(matched[1]);
  switch (matched[2]) {
    case "s":
      return amount;
    case "m":
      return amount * 60;
    default:
      return amount * 3600;
  }
}

export const budgetSchema = z.strictObject({
  max_actor_runs: z.number().int().positive(),
  max_reconciles: z.number().int().positive(),
  max_wall_clock: durationSchema,
  max_consecutive_failures: z.number().int().positive(),
  /**
   * 観測が変わらないまま回した回数の上限。到達したら ESCALATE(loop_detected)。
   *
   * design.md §7 の「観測が N 回連続で変わらなければ ESCALATE」がこれで、
   * §10-2 が未決として残していた N にあたる。判定の材料は Gap ではなく
   * `Decision.observed_digest` になっている。ここが無いと、Gap を埋められない
   * まま同じ判断を繰り返す Goal を止める手段が予算の総量しか無くなる。
   *
   * 他の4項目と同じく必須にしてある。任意にして既定値をコード側に置くと、
   * YAML を読んだだけでは停止条件が分からなくなる。
   */
  max_unchanged_reconciles: z.number().int().positive(),
  /** 任意。API キー経由の実行にのみ適用され、Claude Max の OAuth 実行は対象外 */
  usd: z.number().positive().optional(),
});
export type Budget = z.infer<typeof budgetSchema>;

export const goalContextSchema = z.strictObject({
  background: z.string().min(1),
  /**
   * ACT にそのまま渡る自由記述。Phase 0 では「tests は仕様なので変更しない」が
   * 最も効いた制約で、機械可読にする動機は無かったため文字列のまま残す。
   */
  constraints: z.array(z.string().min(1)),
  /**
   * 参照先。Phase 0 では URL が閲覧権限の都合で開けず、repo 内のパスだけが機能した。
   * 開けない参照を宣言できると ACT が黙って読み飛ばすので path のみ許す。
   */
  references: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        path: z.string().min(1),
      }),
    )
    .default([]),
});
export type GoalContext = z.infer<typeof goalContextSchema>;

/**
 * Goal の id と、CLI が受け取る slug の形。
 *
 * slug はそのまま `.goals/<slug>.yaml` のパスになるので、ここを緩めると
 * `../` でツリーの外を指せる。読めた Goal の `setup` と `verification.run` は
 * そのままシェルで走るため、パスの形はスキーマと同じ厳しさで縛る。
 * CLI 側と2つの正規表現を持たない。
 */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * どの Goal からも外せない保護パスの下限。
 *
 * `protected_paths` は既定が空で、Goal ごとに人間が書く。実際に
 * `agent-friendly-cli` は `.goals/**` だけを、`commit-what-the-actor-wrote` は
 * `src/controller/**` を外した残りだけを保護した状態でマージされている。
 * その間 Actor は、自分の拒否ツール一覧も関門のマッチャも検知されずに
 * 編集できた。「関門の適用範囲を Goal が決める」設計のままだと、
 * 関門を外したい Goal がいつでも外せる。
 *
 * ここに置くのは、書き換えられると**関門そのものが働かなくなる**ものだけ。
 * 検証系（mise.toml / biome.json など）や依存（package.json）は入れない。
 * あちらは「Agent が自分の criteria を通せる」問題で重要度は高いが、
 * Goal によっては正当に触る対象になりうる。下限は最小に保つ。
 */
export const PROTECTED_PATH_FLOOR = [
  // 制御ループ本体。
  "src/controller/**",
  // Goal の宣言部。ここを書けば自分の criteria も保護範囲も書き換えられる。
  ".goals/**",
  // 関門のマッチャ本体。
  "src/domain/protected-paths.ts",
  // 関門の適用範囲を決めるスキーマ。この定数もここにある。
  "src/domain/goal.ts",
  // Agent の許可・拒否ツールを決める場所。
  "src/adapters/claude.ts",
  // シェルを起動する唯一の場所。setup と verification.run が通る。
  "src/adapters/local.ts",
  // 資格情報の除去リスト。
  "src/domain/withheld-env.ts",
] as const;

/**
 * Goal が宣言した保護パスに下限を混ぜる。並びは宣言順を先にし、重複は落とす。
 *
 * Goal 側が下限と同じものを書いていても構わない。既存の Goal YAML は
 * ほとんどが下限と重なるものを明示的に書いており、そちらは残す方が読みやすい。
 */
export function withProtectedPathFloor(declared: readonly string[]): string[] {
  return [...new Set([...declared, ...PROTECTED_PATH_FLOOR])];
}

export const goalSchema = z.strictObject({
  version: z.literal(1),
  goal: z.strictObject({
    /** ファイル名の slug と一致させる。突き合わせはローダーの責務 */
    id: z.string().regex(SLUG, "id は kebab-case で書く"),
    name: z.string().min(1),
    desired_state: z.string().min(1),
  }),
  repository: repositorySchema,
  setup: setupSchema.default([]),
  acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
  context: goalContextSchema,
  policies: z.strictObject({
    require_human_approval: z.array(approvalGateSchema),
    /**
     * Agent に書き換えさせないパス。glob で書く（design.md §7 の自己ホスト用）。
     *
     * `require_human_approval` の enum には載せない。あちらは「操作の種類」で、
     * ここは「対象」にあたる。軸が違うものを1つの enum に混ぜると、
     * controller 側の照合が分岐だらけになる。§10-8 の未決はこの形で埋めた。
     *
     * 既定は空だが、空のまま出てくることは無い。`PROTECTED_PATH_FLOOR` を
     * ここで必ず混ぜるので、Goal がキーごと省いても関門は下限まで働く。
     * 「保護を外したい Goal が外せる」状態を作らないため、除去はできない。
     */
    protected_paths: z.array(z.string().min(1)).default([]).transform(withProtectedPathFloor),
  }),
  budget: budgetSchema,
});
export type Goal = z.infer<typeof goalSchema>;
