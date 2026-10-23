import { matchesGlob } from "@entelecheia/core/domain/path-glob.js";
import {
  APPROVAL_RULE_FLOOR,
  type ApprovalRuleId,
} from "@entelecheia/core/factory/approval-rules.js";

/**
 * 検査の定義。head を検査するときは、ここに当たるファイルを base のものに差し替える。
 *
 * **Actor は、同じ PR の中で検査そのものを弱められる。** verify のタスクを `exit 0` に
 * 書き換える、正解表を自分の実装に合わせる、テストの設定から落ちるファイルを外す。
 * 承認ルールはそれを merge のときに人へ回すが、検査の結果は head の定義で出たままになる。
 * 定義を base から取れば、どう書き換えても base の定義で測った結果しか出ない。
 *
 * 当てるのは、承認ルールの下限のうち「検査の定義」にあたる2つ（`checks-config` と
 * `check-answers`）になる。下限と別に一覧を持つと、下限に足した設定ファイルが
 * ここから漏れる。定義を変えた正当な変更（新しい package の tsconfig、正解表の追加）は
 * base の定義では測れずに落ちうるので、検査は定義に触れたこと自体を
 * `check-definitions-changed` として名指しする。下限に当たるので、どのみち人がマージする。
 *
 * 差し替えが届くのは、ここに当たるファイルだけになる。verify のタスクが package.json の
 * scripts を呼ぶような間接の経路は head のまま残る。そこを書き換えてテストを流さなく
 * した変更は、テストの報告と件数の規則が落とす。
 *
 * 下限のうち、次の2つは外す。
 *
 * - `check-answers` のうち Tauri の権限。あれは検査の正解ではなくアプリの振る舞いで、
 *   base に戻すと head のアプリを head の権限で動かせなくなる
 * - `checks-config` のうち、verify のタスクが読まないもの（ワークフロー、CODEOWNERS、
 *   REVIEW.md、Renovate の設定）。差し替えても検査の結果は変わらず、定義に触れたとして
 *   落とすだけになる。たとえば Renovate が action の sha を上げる PR は、依存更新の例外で
 *   自動マージしてよいのに、検査で必ず落ちる。merge を人に回すのは承認ルールの側が受ける
 */
const DEFINITION_RULES: readonly ApprovalRuleId[] = ["checks-config", "check-answers"];

const NOT_DEFINITIONS: readonly string[] = [
  ".github/**",
  "**/CODEOWNERS",
  "**/REVIEW.md",
  "**/renovate.json",
  "**/renovate.json5",
  "**/.renovaterc*",
  "**/src-tauri/capabilities/**",
  "**/src-tauri/permissions/**",
  "**/tauri.conf.json*",
  "**/tauri.*.conf.json*",
  "**/Tauri.toml",
  "**/Tauri.*.toml",
];

export const CHECK_DEFINITION_PATHS: readonly string[] = APPROVAL_RULE_FLOOR.filter(
  (rule) => rule.id !== undefined && DEFINITION_RULES.includes(rule.id),
)
  .flatMap((rule) => rule.paths ?? [])
  .filter((glob) => !NOT_DEFINITIONS.includes(glob));

/** スナップショットの置き場。差分があれば `surface.snapshots_changed` を立てる */
export const SNAPSHOT_PATHS: readonly string[] = ["**/snapshots/**", "**/__snapshots__/**"];

export function isCheckDefinition(path: string): boolean {
  return CHECK_DEFINITION_PATHS.some((glob) => matchesGlob(path, glob));
}

export function isSnapshot(path: string): boolean {
  return SNAPSHOT_PATHS.some((glob) => matchesGlob(path, glob));
}

/**
 * テストのファイル。アサーションを弱める変更を、差分から拾う範囲になる。
 *
 * 言語ごとの慣習の置き場を並べる。Rust のように実装と同じファイルにテストを書く形は
 * 拾えない。そちらはテストの件数（`test-count-dropped`）とミューテーションテストに任せる。
 */
const TEST_FILE_PATHS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "verify/**",
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATHS.some((glob) => matchesGlob(path, glob));
}
