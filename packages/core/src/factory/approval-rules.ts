import { z } from "zod";
import { matchesGlob } from "../domain/path-glob.js";
import { type ChangedFile, type ChangeSet, sidesOf } from "./change.js";
import { type WorkKind, workKindSchema } from "./kind.js";
import { isPinOnlyPatch, isVersionOnlyPatch } from "./version-lines.js";

/**
 * 承認ルール。パスと種別で当て、当たった変更は必ず人がマージする。
 *
 * ent の保護パス（`protected_paths`）とは別の概念になる。保護パスは Agent が編集した
 * 時点でティックを止めるが、承認ルールは編集そのものは止めず、merge だけを人に回す。
 * ハーネスの整備の Goal は `verify/**` を書くので、保護パスに入れるとその Goal は
 * 毎ティック止まってしまう。
 */
export interface ApprovalRule {
  /** 下限の規則にだけ付ける。例外がどの規則を外してよいかを名指しするため */
  id?: ApprovalRuleId;
  paths?: readonly string[];
  kinds?: readonly WorkKind[];
  reason: string;
}

/**
 * `policy.yaml` と `profile.yaml` に書く承認ルールの形。
 *
 * `paths` と `kinds` の少なくとも一方が要る。両方を書いたときは両方を満たす変更にだけ
 * 当たる。どちらも無い規則は「すべてに当たる」とも「何にも当たらない」とも読めるので、
 * 書けないようにする。設定から `id` は書けない。下限の規則を名乗って例外の対象に
 * 紛れ込ませないため。
 */
export const approvalRuleSchema = z
  .strictObject({
    paths: z.array(z.string().min(1)).min(1).optional(),
    kinds: z.array(workKindSchema).min(1).optional(),
    reason: z.string().min(1),
  })
  .refine((rule) => rule.paths !== undefined || rule.kinds !== undefined, {
    message: "an approval rule needs paths, kinds, or both",
  });
export type ApprovalRuleInput = z.infer<typeof approvalRuleSchema>;

/** 設定に書いた規則を、判定に使う形にする。`exactOptionalPropertyTypes` のため空のキーは落とす */
export function toApprovalRule(input: ApprovalRuleInput): ApprovalRule {
  return {
    ...(input.paths === undefined ? {} : { paths: input.paths }),
    ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    reason: input.reason,
  };
}

export type ApprovalRuleId =
  | "checks-config"
  | "lockfile-and-manifest"
  | "agent-and-factory-config"
  | "check-answers"
  | "factory-parts";

/**
 * lockfile。依存更新の例外では、差分の行を読まない（生成物で、行を読んでも判断の材料に
 * ならない）。その代わり、呼ぶ側が lockfile から読んだ新しいパッケージ（`addedPackages`）と、
 * 間接の依存まで含めた新しいバージョンの公開日時（`releases`）を見る。
 */
export const LOCKFILES = [
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/go.sum",
  "**/Package.resolved",
  "**/uv.lock",
  "**/poetry.lock",
  "**/pdm.lock",
  "**/Pipfile.lock",
  "**/Gemfile.lock",
  "**/deno.lock",
] as const;

/**
 * manifest。依存更新の例外では、差分がバージョンの行だけであることを確かめる。
 *
 * バージョンの行と読めるのは `maskVersions` が知っている書き方だけで、pip（`==2.31.0`）や Deno の
 * 指定子（`npm:zod@^3.22.4`）はまだ読めない。そうした manifest のバージョンの更新は、例外が成り立たず、
 * 新しい依存（`new_dependency`）としても数えられて人に回る。読めない形は閉じる側に倒す
 */
export const MANIFESTS = [
  "**/package.json",
  "**/pnpm-workspace.yaml",
  "**/Cargo.toml",
  "**/go.mod",
  "**/Package.swift",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/requirements/*.txt",
  "**/constraints*.txt",
  "**/Pipfile",
  "**/Gemfile",
  "**/deno.json",
  "**/deno.jsonc",
] as const;

/** バージョンの付け替えだけなら依存更新の例外に入れてよい、ワークフローの置き場 */
export const WORKFLOW_FILES = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".github/actions/**/action.yml",
  ".github/actions/**/action.yaml",
] as const;

/**
 * 承認ルールの下限。**設定では外せない。** プロファイルとポリシーは承認ルールを
 * 足すことしかできない（`composePolicy`）。
 *
 * ここに置くのは、Actor が書き換えると検査や判定そのものを弱められるものだけになる。
 * 領域の重さ（重要な計算、永続データの形式）はリポジトリごとに違うので、ここではなく
 * プロファイルとポリシーから足す。
 *
 * パスは対象リポジトリのルートからの相対で書く。先頭が `**` の glob は入れ子の
 * ディレクトリにも当たる。
 * 広すぎて人を呼ぶほうが、狭すぎて素通りするより安全側になる（ent の保護パスと同じ判断）。
 */
export const APPROVAL_RULE_FLOOR: readonly ApprovalRule[] = [
  {
    id: "checks-config",
    // CI と verify と lint の設定。ここを動かせば、同じ PR の中で検査を弱められる。
    // 検査を回す側は base 側の検査定義を差し込むが、
    // それでも次の PR から効く。
    // Renovate の設定は minimumReleaseAge を持つので、依存更新の例外の前提ごと外せる。
    paths: [
      ".github/**",
      "**/CODEOWNERS",
      "**/REVIEW.md",
      // mise は mise.toml のほかに、それより強い mise.local.toml と mise.<env>.toml、
      // 設定のディレクトリ、ファイルで書くタスクを読む。どれでも verify と check の中身や
      // `locked`・`minimum_release_age` を書き換えられる。
      "**/mise.toml",
      "**/.mise.toml",
      "**/mise.*.toml",
      "**/.mise.*.toml",
      "**/mise.lock",
      "**/.mise/**",
      "**/mise/**",
      "**/.config/mise/**",
      "**/mise-tasks/**",
      "**/.mise-tasks/**",
      "**/.tool-versions",
      "**/.npmrc",
      "**/biome.json",
      "**/biome.jsonc",
      "**/tsconfig*.json",
      // Vitest は vitest.config が無ければ vite.config を読む。
      "**/vitest.config.*",
      "**/vitest.workspace.*",
      "**/vite.config.*",
      "**/playwright.config.*",
      "**/wdio.conf.*",
      "**/wdio.*.conf.*",
      // E2 の根拠になるミューテーションテストの設定（StrykerJS と cargo-mutants）。
      "**/stryker.config.*",
      "**/stryker.conf.*",
      "**/.stryker.conf.*",
      "**/.cargo/mutants.toml",
      "**/eslint.config.*",
      "**/.eslintrc*",
      "**/prettier.config.*",
      "**/.prettierrc*",
      "**/rustfmt.toml",
      "**/.rustfmt.toml",
      "**/clippy.toml",
      // Cargo は拡張子の無い `.cargo/config` も読み、両方あればそちらを優先する。
      "**/.cargo/config",
      "**/.cargo/config.toml",
      "**/.swiftlint.yml",
      // GNU make は GNUmakefile、makefile、Makefile の順に探す。just も `.justfile` を読む。
      // 大文字小文字は照合で畳むので、makefile は `**/Makefile` で、Justfile は `**/justfile` で当たる。
      "**/Makefile",
      "**/GNUmakefile",
      "**/justfile",
      "**/.justfile",
      "**/lefthook.yml",
      "**/.pre-commit-config.yaml",
      "**/renovate.json",
      "**/renovate.json5",
      "**/.renovaterc*",
      "**/.pinact.yaml",
      "**/betterleaks.toml",
    ],
    reason: "CI・verify・lint の設定",
  },
  {
    id: "lockfile-and-manifest",
    // Actor が lockfile を動かした変更は、種別を問わず人がマージする。依存更新だけは
    // 下の例外（`renovateException`）で外す。
    paths: [...LOCKFILES, ...MANIFESTS],
    reason: "lockfile と manifest",
  },
  {
    id: "agent-and-factory-config",
    // Agent の設定と factory の設定。`.factory/policy.yaml` を書き換えれば auto_merge も
    // 承認ルールも動かせる。`.goals/` は ent の Goal の宣言で、受け入れ条件の検査コマンドと
    // 保護パスがここにある。ent の関門も止めるが、PR の判定でも人に回す。
    paths: [".claude/**", ".factory/**", ".goals/**", "**/AGENTS.md", "**/CLAUDE.md"],
    reason: "Agent と factory の設定",
  },
  {
    id: "check-answers",
    // 検査の正解。正解を書き換えれば、テストは緑のまま中身だけが変わる。
    paths: [
      "verify/**",
      "fakes/**",
      "**/snapshots/**",
      "**/__snapshots__/**",
      "known-bad/**",
      "known-good/**",
      // Tauri の権限。capabilities のほか、設定ファイルの中に書いた capability と CSP、
      // capability が参照する permission の定義でも広げられる。
      "**/src-tauri/capabilities/**",
      "**/src-tauri/permissions/**",
      "**/tauri.conf.json*",
      "**/tauri.*.conf.json*",
      "**/Tauri.toml",
      "**/Tauri.*.toml",
    ],
    reason: "検査の正解と Tauri の権限",
  },
  {
    id: "factory-parts",
    // factory 自身の部品。壊れると全リポジトリに波及する。
    paths: [
      "packages/core/**",
      "packages/ent/**",
      "packages/check/**",
      "packages/governor/**",
      "presets/**",
    ],
    reason: "factory 自身の部品",
  },
];

/** 規則が当たった記録。`files` は当たったパス（種別だけの規則なら空） */
export interface ApprovalHit {
  rule: ApprovalRule;
  files: string[];
}

/**
 * 変更に当たる承認ルールを全部返す。
 *
 * - パスは rename の両側に当てる。古い側だけが規則に当たる rename（規則の外へ出す
 *   移動）も、人がマージする
 * - 削除にも当てる。検査の正解を消す変更は、書き換える変更と同じ重さになる
 * - `paths` と `kinds` の両方がある規則は、両方を満たしたときだけ当たる
 */
export function approvalHits(change: ChangeSet, rules: readonly ApprovalRule[]): ApprovalHit[] {
  return rules.flatMap((rule) => {
    if (rule.kinds !== undefined && !rule.kinds.includes(change.kind)) {
      return [];
    }
    if (rule.paths === undefined) {
      return [{ rule, files: [] }];
    }
    const patterns = rule.paths;
    const files = change.files.flatMap((file) =>
      sidesOf(file).filter((side) => patterns.some((glob) => matchesGlob(side, glob))),
    );
    return files.length === 0 ? [] : [{ rule, files: [...new Set(files)] }];
  });
}

/** 依存更新の例外の前提。governor が持つ値を渡す */
export interface RenovateContext {
  /** 依存更新用の GitHub App の ID。プロファイルに無ければ例外は成り立たない */
  renovateAppId: number | null;
  /** 判定の時刻（ISO 8601）。core は時計を読まない */
  now: string;
}

/**
 * 依存更新の例外が求める、公開からの最低日数。設定では短くできない。
 *
 * このリポジトリの Renovate と mise の設定（7日）に揃えてある。悪意のあるバージョンが公開
 * されてから取り下げられるまでの時間を待つためのもので、Renovate 側の設定は
 * 承認ルールの下限（`checks-config`）で守られている。
 */
export const MINIMUM_RELEASE_AGE_DAYS = 7;

export type RenovateCondition = "author" | "kind" | "version_lines_only" | "release_age";

export interface RenovateExceptionResult {
  holds: boolean;
  /** 満たしていない条件。`holds` なら空 */
  unmet: RenovateCondition[];
}

/**
 * 依存更新の例外。次の4つを**すべて**満たす PR だけが、lockfile・manifest・ワークフローの
 * `uses:` 行に触れても、下限の `lockfile-and-manifest` と `checks-config` から外れる。
 *
 * 1. 作成者が依存更新用の GitHub App（Renovate）で、Actor ではない。名前ではなく App の ID で見る
 * 2. 差分が manifest と lockfile のバージョンの行と、ワークフローの固定した `uses:` 行だけに閉じている。
 *    lockfile は、新しいパッケージが1つも入らないことを呼ぶ側が確かめた場合だけバージョンの行とみなす
 * 3. 新しいバージョンがすべて `MINIMUM_RELEASE_AGE_DAYS` を過ぎている。間接の依存のバージョンも含む
 * 4. 種別が deps である
 *
 * lockfile を下限に入れたままだと依存更新の自動マージが起きない。ポリシーは承認ルールを
 * 足すことしかできないので、例外は設定ではなくここに置く。
 */
export function renovateException(
  change: ChangeSet,
  context: RenovateContext,
): RenovateExceptionResult {
  const unmet: RenovateCondition[] = [];

  if (
    context.renovateAppId === null ||
    change.author.type !== "app" ||
    change.author.appId !== context.renovateAppId
  ) {
    unmet.push("author");
  }
  if (change.kind !== "deps") {
    unmet.push("kind");
  }
  if (
    change.files.length === 0 ||
    !change.files.every((file) => isVersionUpdateFile(change, file))
  ) {
    unmet.push("version_lines_only");
  }
  if (!releasesAreOldEnough(change, context.now)) {
    unmet.push("release_age");
  }

  return { holds: unmet.length === 0, unmet };
}

/**
 * 1ファイルが「バージョンの更新」として説明できるか。
 *
 * rename・追加・削除はバージョンの更新ではない。lockfile は行を読まず、新しいパッケージが無いと
 * 分かっているときだけ認める。manifest とワークフローは patch が要る（patch が無いことは、
 * バージョンの行だけである証拠にならない）。
 */
function isVersionUpdateFile(change: ChangeSet, file: ChangedFile): boolean {
  if (file.status !== "modified" || file.previousPath !== undefined) {
    return false;
  }
  if (isLockfile(file.path)) {
    return change.addedPackages !== undefined && change.addedPackages.length === 0;
  }
  if (file.patch === undefined) {
    return false;
  }
  if (isManifest(file.path)) {
    return isVersionOnlyPatch(file.patch);
  }
  if (WORKFLOW_FILES.some((glob) => matchesGlob(file.path, glob))) {
    return isPinOnlyPatch(file.patch);
  }
  return false;
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.some((glob) => matchesGlob(path, glob));
}

export function isManifest(path: string): boolean {
  return MANIFESTS.some((glob) => matchesGlob(path, glob));
}

function releasesAreOldEnough(change: ChangeSet, now: string): boolean {
  const releases = change.releases ?? [];
  const at = Date.parse(now);
  if (releases.length === 0 || Number.isNaN(at)) {
    return false;
  }
  const limit = at - MINIMUM_RELEASE_AGE_DAYS * 24 * 60 * 60 * 1000;
  return releases.every((release) => {
    const released = Date.parse(release.releasedAt);
    return !Number.isNaN(released) && released <= limit;
  });
}

/**
 * 依存更新の例外が外してよい、下限の規則そのもの。id ではなく値（このオブジェクト）で持つ。
 * id は型の上では誰でも付けられるので、id を名乗っただけの規則は外さない
 */
const EXEMPTABLE_BY_RENOVATE: ReadonlySet<ApprovalRule> = new Set(
  APPROVAL_RULE_FLOOR.filter(
    (rule) => rule.id === "lockfile-and-manifest" || rule.id === "checks-config",
  ),
);

/**
 * 判定に使う承認ルールの当たりを返す。`decideAutoMerge` もこれを通す。
 *
 * 渡された規則に下限を足し直し（`withApprovalRuleFloor`）、依存更新の例外が成り立てば
 * 外れる分を除く。外すのは下限のうち `lockfile-and-manifest` と `checks-config` だけで、
 * プロファイルやポリシーが足した規則は外さない。`factory-parts` も外さない。factory の部品の
 * 依存は、Renovate の更新でも人がマージする。
 */
export function effectiveApprovalHits(
  change: ChangeSet,
  rules: readonly ApprovalRule[],
  exception: RenovateExceptionResult,
): ApprovalHit[] {
  const hits = approvalHits(change, withApprovalRuleFloor(rules));
  if (!exception.holds) {
    return hits;
  }
  // `withApprovalRuleFloor` は下限と値の同じ規則を落とし、下限そのものを先頭に置く。
  // なので、下限に当たった規則は `APPROVAL_RULE_FLOOR` のオブジェクトそのものになる。
  return hits.filter((hit) => !EXEMPTABLE_BY_RENOVATE.has(hit.rule));
}

/**
 * 判定に使う承認ルールに、下限が必ず入っているようにする。
 *
 * 下限を外せないことは `composePolicy` が守るが、`EffectivePolicy` はただの値なので、
 * 別の経路で作った値（キャッシュから読み戻した、テストで組み立てた）からは抜けうる。
 * 判定する側でも足し直し、抜けた値を渡されても人に回る側に倒す。
 */
export function withApprovalRuleFloor(rules: readonly ApprovalRule[]): ApprovalRule[] {
  // id ではなく値そのもので見る。同じ id を名乗って中身を空にした規則があっても、
  // 本物の下限は消えない。参照でも比べない。複製した値（structuredClone、JSON から
  // 読み戻したもの）で下限が2つ並ぶと、同じ当たりが2回返る。
  return [
    ...APPROVAL_RULE_FLOOR,
    ...rules.filter((rule) => !APPROVAL_RULE_FLOOR.some((floor) => sameRule(floor, rule))),
  ];
}

function sameRule(a: ApprovalRule, b: ApprovalRule): boolean {
  return (
    a.id === b.id &&
    a.reason === b.reason &&
    sameList(a.paths, b.paths) &&
    sameList(a.kinds, b.kinds)
  );
}

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
