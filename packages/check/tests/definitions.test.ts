import { APPROVAL_RULE_FLOOR } from "@entelecheia/core/factory/approval-rules.js";
import { describe, expect, it } from "vitest";
import {
  CHECK_DEFINITION_PATHS,
  isCheckDefinition,
  isSnapshot,
  isTestFile,
  SNAPSHOT_PATHS,
} from "../src/definitions.js";

describe("検査の定義", () => {
  it.each([
    "mise.toml",
    "mise.local.toml",
    "packages/app/mise.toml",
    "mise-tasks/verify",
    ".config/mise/config.toml",
    "vitest.config.ts",
    "packages/app/vitest.config.mts",
    "biome.json",
    "tsconfig.json",
    ".cargo/config.toml",
    "verify/vectors.json",
    "fakes/http/report.json",
    "snapshots/home.png",
    "src/__snapshots__/a.test.ts.snap",
  ])("%s は base のものに差し替える", (path) => {
    expect(isCheckDefinition(path)).toBe(true);
  });

  it.each([
    "src/app.ts",
    "tests/app.test.ts",
    "package.json",
    "pnpm-lock.yaml",
    "src-tauri/capabilities/default.json",
    "src-tauri/tauri.conf.json",
    ".github/workflows/ci.yml",
    "CODEOWNERS",
    "renovate.json",
  ])("%s は差し替えない", (path) => {
    expect(isCheckDefinition(path)).toBe(false);
  });

  it("承認ルールの下限の検査の設定と正解を全部含む", () => {
    // 下限に足した設定ファイルが、差し込みから漏れないようにする。
    const floor = APPROVAL_RULE_FLOOR.filter(
      (rule) => rule.id === "checks-config" || rule.id === "check-answers",
    ).flatMap((rule) => rule.paths ?? []);
    // 外すのは Tauri の権限と、verify が読まない設定（.github、CODEOWNERS、REVIEW.md、Renovate）だけ
    const outside = floor.filter((glob) =>
      /tauri|^\.github\/|CODEOWNERS|REVIEW\.md|renovate/i.test(glob),
    );

    expect([...CHECK_DEFINITION_PATHS].sort()).toEqual(
      floor.filter((glob) => !outside.includes(glob)).sort(),
    );
    expect(outside).toHaveLength(12);
  });
});

describe("テストのファイルとスナップショット", () => {
  it.each([
    "tests/a.test.ts",
    "src/a.spec.tsx",
    "pkg/a_test.go",
    "test/a.mjs",
    "src/__tests__/a.ts",
    "verify/vectors.test.mjs",
  ])("%s はテストのファイル", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each(["src/app.ts", "README.md"])("%s はテストのファイルではない", (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  it.each(["snapshots/home.png", "src/__snapshots__/a.test.ts.snap"])(
    "%s はスナップショット",
    (path) => {
      expect(isSnapshot(path)).toBe(true);
    },
  );

  it("スナップショットの置き場は、承認ルールの下限の正解にもある", () => {
    // 片方だけ直すと、下限で人に回るのに surface.snapshots_changed が立たない。
    const answers = APPROVAL_RULE_FLOOR.find((rule) => rule.id === "check-answers")?.paths ?? [];

    expect(answers).toEqual(expect.arrayContaining([...SNAPSHOT_PATHS]));
  });
});
