import { parse } from "yaml";
import { z } from "zod";
import {
  approvalGateSchema,
  ciOptionsSchema,
  progressPolicySchema,
  publishPolicySchema,
  pullRequestOptionsSchema,
  setupSchema,
} from "./goal.js";

/**
 * `.goals/config.yaml` のスキーマと、Goal YAML への混ぜ方。
 *
 * **ここに置けるのは repo スコープの宣言だけ。** 「この Goal で何を達成するか」では
 * なく「このリポジトリをどう扱うか」で決まる値、という基準になる。`.goals/*.yaml` が
 * 31本とも同じ値を書き写していたもの（`repository` / `setup` /
 * `policies.require_human_approval` / `policies.protected_paths`）がそれにあたる。
 *
 * **混ぜるのは zod に通す前の生の YAML になる。** パースした後では混ぜられない。
 * `require_human_approval` は `.default([]).transform(withApprovalGateFloor)` なので、
 * `Goal` になった時点では「Goal がこのキーを書かなかった」という事実が消えている。
 * 生のオブジェクトで重ねてから、マージ後の1枚を既存の `goalSchema` に通す。
 * こうすると `goalSchema` から下（controller / decide / act / verify / store）は
 * 1行も変わらず、下限（`PROTECTED_PATH_FLOOR` / `APPROVAL_GATE_FLOOR`）も
 * これまでどおり最後に効く。
 *
 * **config が無ければ何も起きない。** `mergeGoalConfig` は Goal の生オブジェクトを
 * そのまま返す。既存の31本は1文字も書き換えない。
 */

/**
 * Goal YAML と同じファイル名を持てないようにする予約 slug。
 *
 * `SLUG` は `config` に一致するので、`ent run config` はこのファイルを Goal として
 * 読みに行ける。読めば `goalSchema` が落とすが、出てくるのは「`goal` が無い」という
 * スキーマの文句で、打った人間には何が起きたのか分からない。CLI 側で名指しして断る。
 */
export const CONFIG_SLUG = "config";

/** `.goals/` に置くファイル名。init が書く先と、Adapter が読む先の両方がここを見る */
export const CONFIG_FILENAME = `${CONFIG_SLUG}.yaml`;

/**
 * config が上書きできる `repository`。**キーは1つずつ省略できる。**
 *
 * `repositorySchema` を `.partial()` で作らないのは、`ci` と `pull_request` の
 * 任意性がすでにあちらで決まっているため。ここで作り直すと、片方に足したキーが
 * もう片方から漏れる。並べ直すぶんは増えるが、漏れる側が無くなる。
 */
const configRepositorySchema = z.strictObject({
  provider: z.literal("github").optional(),
  owner: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  default_branch: z.string().min(1).optional(),
  ci: ciOptionsSchema.optional(),
  pull_request: pullRequestOptionsSchema.optional(),
});

/**
 * config が上書きできる `policies`。
 *
 * `require_human_approval` と `protected_paths` に `.default([])` を置かない。
 * 既定を入れると「config がこのキーを書かなかった」が消え、書いていない config が
 * Goal 側の宣言を空配列で上書きすることになる。
 */
const configPoliciesSchema = z.strictObject({
  require_human_approval: z.array(approvalGateSchema).optional(),
  protected_paths: z.array(z.string().min(1)).optional(),
  publish: publishPolicySchema.optional(),
  progress: progressPolicySchema.optional(),
});

/**
 * `.goals/config.yaml`。**すべて任意で、`version` だけが要る。**
 *
 * `strictObject` にしてあるので、Goal 固有のキー（`goal` / `desired_state` /
 * `acceptance_criteria` / `context` / `budget`）を書けばその場で落ちる。
 * とりわけ `budget` をここに置けないのは意図した制限になる。停止条件を
 * コード側やリポジトリ側の既定に逃がすと、Goal YAML を読んだだけでは
 * その Goal がいつ止まるのか分からなくなる（`budgetSchema` の判断と同じ）。
 */
export const goalConfigSchema = z.strictObject({
  version: z.literal(1),
  repository: configRepositorySchema.optional(),
  setup: setupSchema.optional(),
  policies: configPoliciesSchema.optional(),
});
export type GoalConfig = z.infer<typeof goalConfigSchema>;

/**
 * `.goals/config.yaml` の中身を検証する。**ファイルは読まない。**
 *
 * 読む側は `src/adapters/goal-file.ts` にある。`parseGoal` と同じ分け方になる。
 */
export function parseGoalConfig(source: string): GoalConfig {
  return goalConfigSchema.parse(parse(source));
}

/**
 * config を Goal の生オブジェクトの**下**に敷く。Goal が書いた値は必ず残る。
 *
 * 満たすべき性質:
 * - config が null なら、受け取ったものをそのまま返す。既存の Goal の挙動を変えない
 * - 粒度は**サブツリーではなくキー**にする。`repository.owner` を Goal が書いていても、
 *   `repository.ci` を書いていなければ config の `ci` が効く。サブツリー単位にすると、
 *   `repository` を全部書いている既存の31本には config の `ci` が永久に届かない
 * - `protected_paths` と `require_human_approval` は**足す**。上書きにすると、
 *   Goal が自分の1行を書いた瞬間に repo 全体の保護が消える。この2つは既に
 *   `transform(withFloor)` で「宣言 + 下限」の形なので、下限をもう1つ増やすだけになる
 * - `setup` は置き換える。足すと `pnpm install` が2回走る
 * - Goal 側の値が期待した形でなければ、混ぜずにそのまま残す。ここで直すと、
 *   `goalSchema` が出すはずだった型の文句が消える
 */
export function mergeGoalConfig(raw: unknown, config: GoalConfig | null): unknown {
  if (config === null || !isRecord(raw)) {
    return raw;
  }

  const merged: Record<string, unknown> = { ...raw };
  assign(merged, "repository", filledIn(raw.repository, config.repository));
  // `??` にしない。YAML に `setup:` とだけ書くと null になり、`??` はそれを
  // 「書いていない」と読んで config の setup を敷いてしまう。書いた側は空にした
  // つもりなのに、別のコマンドが黙って走ることになる。書いていないかどうかは
  // キーの有無で見て、null は書いたものとして `goalSchema` に渡す。
  assign(merged, "setup", raw.setup === undefined ? config.setup : raw.setup);
  assign(merged, "policies", mergedPolicies(raw.policies, config.policies));
  return merged;
}

/**
 * `policies` を混ぜる。**足すキーと置き換えるキーが混ざる唯一の場所**になる。
 *
 * 足す2つを先に決めてから、残りをキー単位で埋める。順番を逆にすると、
 * 埋める側が「Goal が書いていない」と見て config の配列をそのまま置き、
 * 足した結果を上書きしてしまう。
 */
function mergedPolicies(rawValue: unknown, config: GoalConfig["policies"]): unknown {
  if (config === undefined) {
    return rawValue;
  }
  if (rawValue !== undefined && !isRecord(rawValue)) {
    return rawValue;
  }

  const raw = rawValue ?? {};
  const merged: Record<string, unknown> = { ...raw };
  assign(
    merged,
    "require_human_approval",
    added(raw.require_human_approval, config.require_human_approval),
  );
  assign(merged, "protected_paths", added(raw.protected_paths, config.protected_paths));
  assign(merged, "publish", filledIn(raw.publish, config.publish));
  assign(merged, "progress", filledIn(raw.progress, config.progress));
  return merged;
}

/**
 * config の配列を下限として足す。重複は落とさない。
 *
 * 落とすのは `withProtectedPathFloor` と `withApprovalGateFloor` の仕事になる。
 * どちらも `new Set` を通すので、ここで先に畳むと同じことを2箇所でやることになる。
 */
function added(rawValue: unknown, config: readonly string[] | undefined): unknown {
  if (config === undefined) {
    return rawValue;
  }
  if (rawValue === undefined) {
    return [...config];
  }
  // 配列でないものは混ぜずに残す。`goalSchema` に型の文句を言わせる。
  return Array.isArray(rawValue) ? [...rawValue, ...config] : rawValue;
}

/**
 * Goal が書いていないキーだけを config で埋める。サブツリーごとの置き換えはしない。
 *
 * `undefined` のキーは「書いていない」として扱う。YAML に `ci:` とだけ書いた場合は
 * `null` になるので、そちらは書いたものとして残る——空で上書きしたい意図と、
 * 書き忘れを区別する手段がキーの有無しか無い。
 */
function filledIn(rawValue: unknown, config: Record<string, unknown> | undefined): unknown {
  if (config === undefined) {
    return rawValue;
  }
  if (rawValue === undefined) {
    return { ...config };
  }
  if (!isRecord(rawValue)) {
    return rawValue;
  }

  const merged: Record<string, unknown> = { ...rawValue };
  for (const [key, value] of Object.entries(config)) {
    if (merged[key] === undefined && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 値があるときだけキーを置く。
 *
 * `undefined` を代入すると、キーそのものは生える。`strictObject` は既知のキーなので
 * 落ちないが、「書かなければ何も起きない」をキーの有無で表している側（`ent get` が
 * そのまま出す宣言部）から見ると、書いていないものが書いてあるように見える。
 */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/** 素のオブジェクトか。配列と null は除く */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `ent init` が置く `.goals/config.yaml`。
 *
 * **中身が関門の一部になるのは `goalTemplate` と同じ。** ここに書いた
 * `require_human_approval` と `protected_paths` は、この repo で立てる Goal 全部の
 * 下限として効く。緩いものを配れば、そこから始めたリポジトリはすべて緩いところから
 * 始まる。だから `src/usecase/init.ts` ではなくドメイン側に置く。
 *
 * `repository` は git から引ける分を埋めて渡す。引けなければ雛形と同じ
 * `your-org/your-repo` を書く。埋め忘れても `ent start` は通り、最初のティックで
 * GitHub の 404 として出る——それは今までと同じで、ここで悪くはならない。
 */
export function configTemplate(repository: {
  owner: string;
  name: string;
  defaultBranch: string;
}): string {
  return `version: 1

# Fill this in for the target repository. Every Goal under .goals/ inherits
# it, so you do not write it again in each Goal YAML; a Goal may still
# override any key by writing that key itself. ent start passes even when
# this is wrong, but the first tick surfaces it as a GitHub 404.
repository:
  provider: github
  owner: ${repository.owner}
  name: ${repository.name}
  default_branch: ${repository.defaultBranch}

  # Workflow names to leave out of github.ci.failed_job_count. Write the
  # name: in .github/workflows/*.yml, the one the PR checks tab shows.
  # ci:
  #   exclude_workflows: []

  # How the controller opens a PR.
  # pull_request:
  #   draft: false

# Commands that make the verification commands runnable. VERIFY runs these
# once before it evaluates any criterion, so they must be idempotent.
setup: []

policies:
  # Operations the Agent is denied. These are added to whatever each Goal
  # declares, never subtracted, so this list is a repository-wide floor.
  require_human_approval:
    - merge
    - force_push
    - push_to_default_branch
    - deploy
    - secret_access
    - external_send

  # Paths the Agent must not rewrite, as globs. Added to each Goal's own
  # list the same way. PROTECTED_PATH_FLOOR still applies underneath.
  protected_paths: []

  # Which publish steps the controller performs. manual means a human does
  # it instead; the controller stops and says so. Written out rather than
  # left implicit so that ent init and ent plan hand you the same shape.
  publish:
    push_branch: auto
    # Set this to manual for a repository shared with a team. Opening a pull
    # request notifies reviewers, and undoing it does not recall the notice.
    open_pull_request: auto

  # Where progress goes: pr, stdout, or a file path. ent run --report wins
  # over this for the tick it is passed on.
  # progress:
  #   report: pr
`;
}
