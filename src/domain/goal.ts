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
 * CI の観測をどう絞るか。対象リポジトリの運用に合わせる口になる。
 *
 * `repository` の下に置く。どの check を数えるかは対象リポジトリの運用で決まるもので、
 * Goal の中身（`desired_state` や criteria）とは別の軸になる。
 */
export const ciOptionsSchema = z.strictObject({
  /**
   * `github.ci.failed_job_count` の数から外す workflow の名前。
   * `.github/workflows/*.yml` の `name:`（PR の checks 欄に出る名前）で書く。
   *
   * **リポジトリによっては、恒久的に赤いまま／保留のままにしてある gate がある。**
   * 「特定の人のレビューが通るまで mergeable にしない」種類のものがそれで、
   * 数に入れると `equals: 0` の criterion が永久に埋まらない。
   *
   * **除外の単位を job 名ではなく workflow にしてある。** 数が確定するのは
   * 「未確定の run が1本も無い」ときで、これは run の属性になる。承認待ちの gate は
   * `completed` にならないので、job 名で外しても run が pending であることは変わらず、
   * 数は永久に null のままになる。run ごと外せる粒度でないと、この要望は満たせない。
   *
   * **ここで外せるのは GitHub Actions の workflow run だけ。** `failed_job_count` は
   * もともと Actions の run の job しか数えていないので、third-party の check run や
   * branch protection の required review は最初から数に入っていない。そういう gate を
   * ここに書いても何も起きない（一致した run の数が 0 として観測に出る）。
   *
   * **全部の run を外すと数は 0 になる。** 数えた結果 1件も無かったのと同じ値が出る。
   * 「1本も見ていないのに緑」に見えるが、除外したことは `github.ci.excluded_workflows` に
   * 出るので外から読める。ここで数を出さない側に倒すと「除外したのに数が出ない」になり、
   * 宣言した通りに動いていないように見える。
   *
   * **外れるのは数だけではない。** 外した run の失敗ジョブは `github.ci.failed_jobs` からも
   * 消えるので、次の ACT に渡る材料が除外分だけ欠ける（`CiRunSnapshot.failedJobs`）。
   * 外した run が赤かったかは `github.ci.excluded_workflows` の `states` から読む。
   *
   * 一致しなかった名前を弾かない。宣言を読む時点ではリポジトリを見ないので解析では
   * 決まらず、対象リポジトリは手元の checkout とは限らないので doctor でも決まらない。
   * そもそも「一致しない」は typo と「今回は起動しなかった workflow」（path filter や
   * branch filter で走らないことがある）の両方を指すので、観測の側から区別できない。
   * 代わりに**一致した run の数を観測ごとに出す**（`github.ci.excluded_workflows`）。
   */
  exclude_workflows: z.array(z.string().min(1)).default([]),
});
export type CiOptions = z.infer<typeof ciOptionsSchema>;

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
/**
 * publish が立てる PR の作り方。対象リポジトリの運用に合わせる口になる。
 *
 * `repository` の下に置く。PR をどう立てるかは対象リポジトリの規約で決まるもので、
 * Goal の中身（`desired_state` や criteria）とは別の軸になる。
 *
 * **キーを1段挟むのは、ここに増えるものが分かっているため。** タイトル規約と
 * PR テンプレートに合わせる口（`title_template` / `body_path`）は同じ「PR の
 * 作り方」で、平らに置くと `repository` の直下に PR の話が散る。増える側を
 * 先に受けておけば、足すときに名前を変えずに済む。
 *
 * `draft` の既定は false で、書かなければ ready で立つ。**既定を変えない。**
 * 既存の Goal はどれもこれを書いていないので、既定を draft に倒すと
 * 「宣言を足していない Goal の挙動が変わる」形になる。
 */
export const pullRequestOptionsSchema = z.strictObject({
  /**
   * draft として立てるか。
   *
   * 効くのは PR を作るときだけで、既に立っている PR を draft に戻すことはしない。
   * publish は本文もタイトルも作成後は書き換えない（毎ティック書き換えると
   * レビューが差分を追えなくなる）ので、そこと揃える。
   */
  draft: z.boolean().default(false),
});
export type PullRequestOptions = z.infer<typeof pullRequestOptionsSchema>;

export const repositorySchema = z.strictObject({
  provider: z.literal("github"),
  owner: z.string().min(1),
  name: z.string().min(1),
  default_branch: z.string().min(1),
  /**
   * CI の観測の絞り方。省略できる。
   *
   * **`.default({})` にしない。** 既定を入れると、いま `.goals/` にある Goal 全部の
   * 解析結果に `ci` が生える。宣言部は `ent get` がそのまま出し、store も保存するので、
   * 1本も YAML を触っていないのに出力が変わることになる。
   * 「書かなければ何も起きない」を、値ではなくキーの有無で表す。
   */
  ci: ciOptionsSchema.optional(),
  /**
   * PR の作り方。省略できる。
   *
   * **`.default({})` にしない。** 既定を入れると、いま `.goals/` にある Goal 全部の
   * 解析結果に `pull_request` が生える。宣言部は `ent get` がそのまま出し、
   * store も保存するので、1本も YAML を触っていないのに出力が変わることになる。
   * 「書かなければ何も起きない」を、値ではなくキーの有無で表す。
   */
  pull_request: pullRequestOptionsSchema.optional(),
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

/**
 * どの Goal からも外せない承認ゲートの下限。
 *
 * `require_human_approval` に書いたゲートは `DENIED_TOOLS`（src/adapters/claude.ts）
 * の対応行だけを拒否パターンに変える。**書かなければ、その操作は Agent に許可
 * されたまま残る。** 既存の Goal YAML は全部が6ゲートを列挙しているので誰も
 * 気づかなかったが、`ent init` の雛形が `merge` だけを書いた時点で成立した。
 *
 * ここに置くのは `protected_paths` の下限と同じ基準——**書き換えられると関門
 * そのものが働かなくなるもの**——だけにする。その基準に当たるのは2つ。
 *
 * - `external_send`: `gh pr comment` を Agent に許すと、`type: human` の criteria が
 *   PR コメントの定型文で通る以上、Agent は自分で自分を承認できる。§7 の
 *   human approval が空文になる。関門を無くすのではなく、関門の入力を Agent が
 *   作れるようになる形なので、こちらの方が悪い
 * - `secret_access`: `gh auth token` が読むのは keyring と hosts.yml で、
 *   `WITHHELD_ENV` の env 除去では塞げない。controller が Agent に渡さないと
 *   決めた資格情報を、Agent が自分で取り直せる
 *
 * `merge` / `force_push` / `push_to_default_branch` / `deploy` は入れない。
 * どれも危ないが、**関門そのものは無効化しない**。Goal によっては正当に触る
 * 対象になりうるので、下限は最小に保つ（`PROTECTED_PATH_FLOOR` と同じ判断）。
 * 雛形は6つ全部を書くので、緩める側が意識的な操作になる。
 */
export const APPROVAL_GATE_FLOOR = ["secret_access", "external_send"] as const;

/**
 * Goal が宣言した承認ゲートに下限を混ぜる。並びは宣言順を先にし、重複は落とす。
 *
 * `withProtectedPathFloor` と同じ形にしてある。片方だけ transform を持つと、
 * 「下限がある」という規則をどちらに適用したのかが読む側から分からなくなる。
 */
export function withApprovalGateFloor(declared: readonly ApprovalGate[]): ApprovalGate[] {
  return [...new Set<ApprovalGate>([...declared, ...APPROVAL_GATE_FLOOR])];
}

/**
 * publish の各段を、誰が行うか。
 *
 * - `auto`   — これまでどおり controller が行う
 * - `manual` — controller は行わない。人間が行う
 *
 * **「承認」の語彙を使わない。** 承認を検知して先へ進む仕組み（`/ent approve`）は
 * criteria にしか無く、publish には無い。「承認待ち」と読める名前を付けると、
 * どこかに承認する口があるはずだと読み手に探させることになる。ここが宣言して
 * いるのは承認の要否ではなく**実行主体**で、`manual` なら人間が自分で push なり
 * PR 作成なりを済ませる。
 */
export const publishModeSchema = z.enum(["auto", "manual"]);
export type PublishMode = z.infer<typeof publishModeSchema>;

/**
 * controller 自身の publish（push と PR 作成）を宣言で止める口。
 *
 * `policies.require_human_approval` に書いたゲートは、Actor に渡す拒否ツール
 * （`DENIED_TOOLS`）にしかならない。push と PR 作成を行っているのは controller の
 * publish で、こちらはゲートを1つも通っていなかった。結果として「PR を勝手に
 * 立てるな」を宣言する口がどこにも無く、人間が確認しようとした時点では既に PR が
 * 立ち、レビュアーへの通知も飛んでいた。取り消しても通知は戻らない。
 *
 * **`require_human_approval` は広げない。別の宣言にする。** あちらの意味は
 * 「**Agent に**許さない操作」で、こちらは「**controller が**行わない段」になる。
 * 1つの列挙に混ぜると、同じ値が主体によって別の関門に効くことになり、しかも
 * 対応する `DENIED_TOOLS` の行が無い値だけが Agent 側で素通りする。読み手からは
 * どの値がどちらに効くのかが見分けられない。名前を分けて、効く先を名前で示す。
 *
 * **置き場所は `policies` の下にする。** `repository` は観測対象の識別子
 * （provider / owner / name / default_branch）だけを持つ場所で、振る舞いの宣言を
 * 混ぜると「どのリポジトリか」以外の役割が入る。`policies` は既に「対象」
 * （`protected_paths`）と「操作」（`require_human_approval`）を並べており、
 * 3つ目として controller の外向きの行動を置くのが読み味に近い。
 *
 * **段ごとに分ける。** push はブランチが remote に出るだけだが、PR 作成は
 * レビュアーへの通知を伴う。止めたいのが後者だけの Goal は多いので、
 * 「ブランチは出してよいが PR は人間が立てる」を書けるようにする。
 *
 * **既定は `auto`。** 宣言そのものを任意にしてあるので、既存の `.goals/*.yaml` は
 * 1本も挙動が変わらない。`protected_paths` や `require_human_approval` のような
 * 下限（floor）は置かない。あちらは書き換えられると関門そのものが働かなくなる
 * ものの下限で、こちらは**止めなければ従来どおり動く**だけになる。既定を
 * `manual` に倒すと、いま回っている Goal が全部止まる。
 */
export const publishPolicySchema = z.strictObject({
  /** feature ブランチへの push。`manual` なら remote には何も出ない */
  push_branch: publishModeSchema.default("auto"),
  /** PR の作成。`manual` なら controller は作らない。既にある PR への追記は止めない */
  open_pull_request: publishModeSchema.default("auto"),
});
export type PublishPolicy = z.infer<typeof publishPolicySchema>;

/**
 * 宣言で個別に止められる段の名前。
 *
 * キーから導く。文字列の列挙をもう1つ持つと、段を足したときに片方だけが古くなる。
 */
export type PublishStep = keyof PublishPolicy;

/** 宣言が無いときの既定。どちらも controller が行う（これまでの挙動） */
export const DEFAULT_PUBLISH_POLICY: PublishPolicy = {
  push_branch: "auto",
  open_pull_request: "auto",
};

/**
 * この Goal の publish の宣言。書いていなければ既定に落とす。
 *
 * 読む側（publish と controller）に `?? DEFAULT_PUBLISH_POLICY` を散らさない。
 * 散らすと、片方だけ既定を書き忘れたときに宣言が半分だけ効く。
 */
export function publishPolicyOf(goal: Goal): PublishPolicy {
  return goal.policies.publish ?? DEFAULT_PUBLISH_POLICY;
}

/**
 * 使える単位と、その秒数。
 *
 * 正規表現をここから組み立てる。以前は `/^(\d+)([smh])$/` を手で書き、
 * 変換側が `switch` の `default` で時間に落としていた。単位を1つ足す——
 * この関数のコメント自身が例に挙げている `d` の追加——をすると、
 * 正規表現は通るのに変換が `default` に落ちて `2d` が 7200 秒になる。
 * 24分の1で、しかもどこにもエラーが出ない。この値は `max_wall_clock` で、
 * 壁時計の停止条件が1日早く発火して Goal が `budget_exhausted` になる。
 *
 * 表を1つにして、未知の単位は `undefined` として `null` に倒す。
 * 単位を足すときはここだけを触ればよく、触り忘れる側が無くなる。
 */
const DURATION_UNITS = { s: 1, m: 60, h: 3600 } as const;

/** `30s` / `10m` / `6h` 形式。controller が待機と打ち切りの判定に使う */
const DURATION = new RegExp(`^(\\d+)([${Object.keys(DURATION_UNITS).join("")}])$`);
const durationSchema = z.string().regex(DURATION, "duration must be written as 30s / 10m / 6h");

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

  const unit = matched[2] as keyof typeof DURATION_UNITS | undefined;
  const factor = unit === undefined ? undefined : DURATION_UNITS[unit];
  if (factor === undefined) {
    return null;
  }

  return Number(matched[1]) * factor;
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
  // 関門と予算の停止条件が読む判断規則。関門が差分を取る相手（`guardBaseOf`）、
  // 未 commit の関門が見る述語（`claimsNothingLeft` / `observedValue`）、
  // 経過時間と連続失敗の数え方がここにある。もとは `src/controller/**` の中に
  // あって下限に覆われていた。**依存を持たない規則だからという理由でドメインへ
  // 出すと、出した先が下限の外になる。** 移設と一緒に下限も動かす。
  "src/domain/guard-rules.ts",
  // 関門の適用範囲を決めるスキーマ。この定数もここにある。
  "src/domain/goal.ts",
  // Agent の許可・拒否ツールを決める場所。
  "src/adapters/claude.ts",
  "src/adapters/codex.ts",
  // Provider 間で共有する役割と出力の指示。
  "src/adapters/agent-prompt.ts",
  // シェルを起動する唯一の場所。setup と verification.run が通る。
  "src/adapters/local.ts",
  // 資格情報の除去リスト。
  "src/domain/withheld-env.ts",
  // 合成ルート。どの Port にどの Adapter を挿すかを決める唯一の場所で、
  // 関門の入力を作る Adapter（`localRepo` / `commandRunner` / `gitWorktree`）の
  // 注入と、未 commit の関門が突き合わせる観測先（`verifyRoot`）がここに集まる。
  // 規則（`guard-rules.ts`）を1文字も触らずに、関門へ流れる観測そのものを
  // 差し替えられるので、規則と同じ扱いにする。
  "src/wiring/index.ts",
  // git が観測しないが、書き換えられると controller の権限でコードが走る場所。
  // `repoDirtyState` が指紋で見るので、ここに glob を置いて関門に繋ぐ。
  // hooks は linked worktree でも共通の .git を共有し、push のたびに走る。
  ".git/**",
  // 状態 DB。gitignore 済みで git status には出ないが、直接書けば状態を偽造できる。
  ".goals/.state/**",
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
  goal: z
    .strictObject({
      /** ファイル名の slug と一致させる。突き合わせはローダーの責務 */
      id: z.string().regex(SLUG, "id must be kebab-case"),
      name: z.string().min(1),
      desired_state: z.string().min(1),
      /**
       * この Goal より先に COMPLETED になっていなければならない Goal の id
       * （design.md §10-12）。
       *
       * 分解した1本ごとに Goal を立てる方針を採ったので、順序はここに宣言する。
       * Goal の下に Task 層は切らないため、依存を持つ層はここしかない。
       *
       * **宣言部に置く。** 実行時状態（`GoalState`）ではなく Goal YAML が正なのは、
       * 依存が人間の書いた設計であって観測結果ではないため（§4.6）。
       *
       * 既定は空。書いていない既存の Goal はこれまでどおり単独で回る。
       */
      depends_on: z
        .array(z.string().regex(SLUG, "depends_on entries must be kebab-case ids"))
        .default([]),
    })
    .superRefine((goal, ctx) => {
      // 自分自身への依存は、書けた時点で永久に進まない Goal になる。
      // 循環はファイル1本からは見えないので、ここで見るのは自己参照だけにする。
      if (goal.depends_on.includes(goal.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["depends_on"],
          message: "depends_on must not list the goal itself",
        });
      }
      const duplicated = goal.depends_on.filter(
        (id, index) => goal.depends_on.indexOf(id) !== index,
      );
      if (duplicated.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["depends_on"],
          message: `depends_on lists the same id twice: ${[...new Set(duplicated)].join(", ")}`,
        });
      }
    }),
  repository: repositorySchema,
  setup: setupSchema.default([]),
  acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
  context: goalContextSchema,
  policies: z.strictObject({
    /**
     * 人間の承認を必須にする操作。ここに書いたゲートだけが Agent の拒否ルールになる。
     *
     * `protected_paths` と同じく、`APPROVAL_GATE_FLOOR` をここで必ず混ぜる。
     * 書き忘れたゲートは「許可」として効くので、既定が空のまま出てくることは無い。
     */
    require_human_approval: z
      .array(approvalGateSchema)
      .default([])
      .transform(withApprovalGateFloor),
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
    /**
     * controller 自身の publish を、どの段まで自動で進めるか（`publishPolicySchema`）。
     *
     * `require_human_approval` とは主体が違う。あちらは Agent に許さない操作、
     * ここは controller が行わない段になる。
     *
     * **任意にしてある。** 上の2つと違って `.default()` を置かないのは、
     * 「書いていない」と「既定を書いた」を型の上でも区別したいためではなく、
     * 既存の Goal と `Goal` 型を組み立てている側（テストの fixture を含む）に
     * 1行も足させずに済ませるため。読むときは `publishPolicyOf(goal)` を通す。
     */
    publish: publishPolicySchema.optional(),
  }),
  budget: budgetSchema,
});
export type Goal = z.infer<typeof goalSchema>;

/** `ent init` が置く雛形の slug。ファイル名と `goal.id` はローダーが突き合わせる */
export const TEMPLATE_SLUG = "example-goal";

/**
 * `ent init` が置く、埋めるための Goal YAML。
 *
 * **ここに置くのは、中身が関門の一部だから。** `policies` は Agent の拒否ルールを
 * 決める（`DENIED_TOOLS`）ので、雛形が緩いゲートを配れば、そこから始めた
 * リポジトリはすべて緩いところから始まる。`PROTECTED_PATH_FLOOR` と
 * `APPROVAL_GATE_FLOOR` の隣に置いて、下限と同じ関門として扱う。
 * `src/usecase/init.ts` は文字列を受け取って書くだけにする。
 *
 * そのまま `ent start` に渡せる必要は無い（`desired_state` と criteria は人間が
 * 書くもの）が、**スキーマとしては妥当**にする。埋める前に「何が悪いのか」を
 * 調べることになるのを避けるため。項目は上の goalSchema だけで書く。
 *
 * 人間が埋める箇所には、例外なくコメントを置く。`repository` を埋め忘れても
 * `ent start` は通り、最初のティックで `your-org/your-repo` への 404 として
 * 初めて表面化する。「ent の話だと分かるところで止める」という doctor の
 * 方針と、雛形だけがずれることになる。
 */
export function goalTemplate(slug: string): string {
  return `version: 1

goal:
  # Must match the filename slug. Rename both together.
  # If they diverge, goal-parse rejects the file before ent start runs.
  id: ${slug}
  # A short name for what you want to achieve. Fill this in too.
  name: short name for what you want to achieve

  # Write the finished state, not the steps. Be concrete enough that a
  # reader pictures the same thing. This text is what reaches the Actor.
  desired_state: |
    Describe here what must hold for this Goal to be done.

  # ids of Goals that must reach COMPLETED first (design.md §10-12).
  # Declare the ordering here when you split coarse work across Goals.
  # Empty means this Goal runs on its own. Until the dependencies are
  # satisfied, ent run waits without even taking the lease.
  depends_on: []

# Fill this in for the target repository. ent start still passes if you
# forget, but the first tick surfaces it as a GitHub 404.
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
  # If the target repository opens pull requests as drafts first, uncomment
  # the next two lines. Left out, pull requests open ready (as before).
  # pull_request:
  #   draft: true

# Run once before VERIFY executes any criterion. Must be idempotent.
setup: []

# design.md §3.2: a Goal that cannot be reduced to criteria is not made ACTIVE.
# type is one of command / fact / human.
acceptance_criteria:
  - id: ac-1
    description: a condition whose satisfaction can be checked from outside
    verification:
      type: command
      run: "echo 'replace this with the real verification command' && exit 1"

context:
  background: |
    Why this is being done. The Actor reads this as written.
  constraints:
    - List anything you do not want touched here
  references: []

policies:
  # Only the gates you write become deny rules for the Agent.
  # **What you leave out is permitted.** All six are listed here. To relax
  # one, deleting it has to be a deliberate act. secret_access and
  # external_send are always merged in by APPROVAL_GATE_FLOOR, so they keep
  # applying even if you delete them.
  require_human_approval:
    - merge
    - force_push
    - push_to_default_branch
    - deploy
    - secret_access
    - external_send
  # Paths the Agent must not rewrite. PROTECTED_PATH_FLOOR always applies
  # even when this is empty.
  protected_paths: []
  # How far the controller carries its own publish automatically.
  # require_human_approval above covers operations the Agent is not allowed
  # to perform; this covers stages the controller does not perform. The
  # subject differs, so the declarations are kept separate.
  # The controller does not perform a stage set to manual, and that tick
  # stops at WAITING_HUMAN. Why it stopped and what to do next appear in
  # the decision shown by ent get.
  publish:
    push_branch: auto
    # Set this to manual for a repository shared with a team. Opening a pull
    # request notifies reviewers, and undoing it does not recall the notice.
    open_pull_request: auto

budget:
  max_actor_runs: 8
  max_reconciles: 20
  max_wall_clock: 3h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 4
`;
}
