import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyEntrypoint } from "../src/cli.js";

/**
 * シンボリックリンク越しに叩かれた CLI が main() へ入ることを確かめる。
 *
 * 判定に失敗しても例外は出ない。main() が呼ばれないだけで、終了コード 0・出力なしに
 * なる。呼び出し側からは「登録された Goal が0件」と区別が付かないので、他のテストが
 * 落ちる形にはならない。ここで縛らないと、誰も気づかないまま壊れる。
 *
 * 実物のシンボリックリンクを temp に張って `classifyEntrypoint()` へ渡す。dist を
 * 作らずに済むので、`mise run test` 単体で回る。
 */

let root: string;

/** `import.meta.url` の代わり。Node が渡すのは realpath 済みの実体パスになる */
function moduleUrlOf(realPath: string): string {
  return pathToFileURL(realPath).href;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ent-entrypoint-"));
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "cli.js"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("classifyEntrypoint", () => {
  it("dist がディレクトリのシンボリックリンクでも main と判定する", () => {
    // 報告された再現形。`.goals/` を持つディレクトリに dist を張って叩く。
    symlinkSync(join(root, "real"), join(root, "dist"));

    expect(
      classifyEntrypoint(join(root, "dist", "cli.js"), moduleUrlOf(join(root, "real", "cli.js"))),
    ).toEqual({ kind: "main" });
  });

  it("bin がファイルのシンボリックリンクでも main と判定する", () => {
    // `pnpm link --global` が package.json の bin（dist/cli.js）を張る形。
    mkdirSync(join(root, "bin"));
    symlinkSync(join(root, "real", "cli.js"), join(root, "bin", "cli.js"));

    expect(
      classifyEntrypoint(join(root, "bin", "cli.js"), moduleUrlOf(join(root, "real", "cli.js"))),
    ).toEqual({ kind: "main" });
  });

  it("実体のパスで叩いても main と判定する", () => {
    expect(
      classifyEntrypoint(join(root, "real", "cli.js"), moduleUrlOf(join(root, "real", "cli.js"))),
    ).toEqual({ kind: "main" });
  });

  it("他所から import されただけなら何もしない", () => {
    // vitest から `main` を import する経路。argv[1] はテストランナーの実体になる。
    writeFileSync(join(root, "real", "vitest.mjs"), "");

    expect(
      classifyEntrypoint(
        join(root, "real", "vitest.mjs"),
        moduleUrlOf(join(root, "real", "cli.js")),
      ),
    ).toEqual({ kind: "imported" });
  });

  it("argv[1] が無ければ何もしない（node -e など）", () => {
    expect(classifyEntrypoint(undefined, moduleUrlOf(join(root, "real", "cli.js")))).toEqual({
      kind: "imported",
    });
  });

  it("同名の別ファイルから叩かれたら、黙って終わらせず理由を残す", () => {
    // 突き合わせに失敗したまま終了コード 0 で出力を空にすると、呼び出し側には
    // 「Goal が0件」と同じ形で届く。判定が付かないことは出力に残す。
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "cli.js"), "");

    expect(
      classifyEntrypoint(join(root, "other", "cli.js"), moduleUrlOf(join(root, "real", "cli.js"))),
    ).toMatchObject({ kind: "unresolved" });
  });

  it("argv[1] の実体を辿れなくても、黙って終わらせず理由を残す", () => {
    expect(
      classifyEntrypoint(join(root, "gone", "cli.js"), moduleUrlOf(join(root, "real", "cli.js"))),
    ).toMatchObject({ kind: "unresolved" });
  });
});
