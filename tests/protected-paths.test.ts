import { describe, expect, it } from "vitest";
import { describeViolations, findViolations } from "../src/domain/protected-paths.js";

/**
 * 制御ループ自体を Agent に書き換えさせない（design.md §7）。
 *
 * Agent 側の disallowedTools は Agent の設定にすぎず、SDK の外から同じ操作を
 * されれば素通りする（§10-6）。controller 側でも、Actor が編集したファイルを
 * 実行後に検査する。
 */

const ROOT = "/tmp/entelecheia/worktrees/sample-goal";
const PROTECTED = ["src/controller/**", ".goals/**"];

describe("findViolations", () => {
  it("保護パスの編集を見つける", () => {
    const violations = findViolations([`${ROOT}/src/controller/index.ts`], ROOT, PROTECTED);

    expect(violations).toEqual([
      {
        kind: "protected_path",
        path: `${ROOT}/src/controller/index.ts`,
        pattern: "src/controller/**",
      },
    ]);
  });

  it("保護されていないパスは通す", () => {
    expect(findViolations([`${ROOT}/src/cli.ts`], ROOT, PROTECTED)).toEqual([]);
  });

  it("worktree の外に出た編集を見つける", () => {
    // 隔離が破れたことを意味する。Agent の cwd は worktree だが、
    // Bash 経由なら外にも書ける。
    const violations = findViolations(["/repo/entelecheia/src/cli.ts"], ROOT, []);

    expect(violations[0]?.kind).toBe("escaped_worktree");
    expect(violations[0]?.pattern).toBeNull();
  });

  it("worktree の外は保護パスの指定が無くても違反にする", () => {
    // 保護パスの一致より先に見る。隔離が破れた方が重い。
    expect(findViolations([`${ROOT}/../other/src/cli.ts`], ROOT, [])).toHaveLength(1);
  });

  it("相対パスは worktree からの相対として読む", () => {
    const violations = findViolations(["src/controller/index.ts"], ROOT, PROTECTED);

    expect(violations[0]?.kind).toBe("protected_path");
  });

  it("ディレクトリ自身にも一致する", () => {
    // `src/controller/**` が `src/controller` に一致しないと、
    // ディレクトリごと置き換えられたときに素通りする。
    expect(findViolations([`${ROOT}/src/controller`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it("* は区切りをまたがない", () => {
    const violations = findViolations([`${ROOT}/src/domain/goal.ts`, `${ROOT}/src/goal.ts`], ROOT, [
      "src/*.ts",
    ]);

    expect(violations.map((v) => v.path)).toEqual([`${ROOT}/src/goal.ts`]);
  });

  it("** は区切りをまたぐ", () => {
    expect(findViolations([`${ROOT}/a/b/c/d.ts`], ROOT, ["a/**/d.ts"])).toHaveLength(1);
    expect(findViolations([`${ROOT}/a/d.ts`], ROOT, ["a/**/d.ts"])).toHaveLength(1);
  });

  it("パターンのドットを正規表現として解釈しない", () => {
    // `.goals/**` が `xgoals/foo` に一致してはいけない。
    expect(findViolations([`${ROOT}/xgoals/foo.yaml`], ROOT, [".goals/**"])).toEqual([]);
    expect(findViolations([`${ROOT}/.goals/foo.yaml`], ROOT, [".goals/**"])).toHaveLength(1);
  });

  it("保護パスが空なら worktree 内は何も違反にならない", () => {
    expect(findViolations([`${ROOT}/src/controller/index.ts`], ROOT, [])).toEqual([]);
  });

  it("編集が無ければ違反も無い", () => {
    expect(findViolations([], ROOT, PROTECTED)).toEqual([]);
  });

  it("複数の違反をすべて返す", () => {
    const violations = findViolations(
      [`${ROOT}/src/controller/index.ts`, `${ROOT}/.goals/x.yaml`, `${ROOT}/src/cli.ts`],
      ROOT,
      PROTECTED,
    );

    expect(violations).toHaveLength(2);
  });
});

describe("describeViolations", () => {
  it("何に引っかかったかを読める形にする", () => {
    const text = describeViolations([
      { kind: "protected_path", path: "src/controller/index.ts", pattern: "src/controller/**" },
      { kind: "escaped_worktree", path: "/etc/hosts", pattern: null },
    ]);

    expect(text).toContain("protected path");
    expect(text).toContain("src/controller/**");
    expect(text).toContain("outside the worktree");
    expect(text).toContain("/etc/hosts");
  });
});
