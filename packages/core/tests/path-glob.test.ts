import { describe, expect, it } from "vitest";
import { matchesGlob } from "../src/domain/path-glob.js";

/**
 * glob の照合。保護パスの関門と承認ルールの両方がこれを使うので、ここが緩むと
 * 2つの規則が同時に外れる。
 */

/** git がファイル名に許す文字のうち、正規表現の `.` が既定で当たらないもの */
const LINE_TERMINATORS = ["\n", "\r", " ", " "];

describe("matchesGlob", () => {
  it("`*` は区切りをまたがず、`**` はまたぐ", () => {
    expect(matchesGlob("tsconfig.build.json", "tsconfig*.json")).toBe(true);
    expect(matchesGlob("a/tsconfig.json", "tsconfig*.json")).toBe(false);
    expect(matchesGlob("a/b/tsconfig.json", "**/tsconfig*.json")).toBe(true);
    expect(matchesGlob("src/controller/a/b.ts", "src/controller/**")).toBe(true);
  });

  it("末尾が `/**` のパターンは、そのディレクトリ自身にも当たる", () => {
    expect(matchesGlob("src/controller", "src/controller/**")).toBe(true);
  });

  it("先頭が `**/` でも、そのディレクトリ自身に当たる", () => {
    expect(matchesGlob(".mise", "**/.mise/**")).toBe(true);
    expect(matchesGlob("apps/web/.mise", "**/.mise/**")).toBe(true);
    expect(matchesGlob("packages/ent/src", "packages/*/src/**")).toBe(true);
    // ディレクトリ名の一部だけが同じものには当たらない
    expect(matchesGlob(".mise-old", "**/.mise/**")).toBe(false);
  });

  it("大文字小文字と区切りの向きを揃えてから照合する", () => {
    expect(matchesGlob("SRC\\Controller\\index.ts", "src/controller/**")).toBe(true);
  });

  it.each(LINE_TERMINATORS)("改行類の文字 %j を名前に入れても `**` から外れない", (char) => {
    expect(matchesGlob(`.github/workflows/deploy${char}.yml`, ".github/**")).toBe(true);
    expect(matchesGlob(`a${char}b/package.json`, "**/package.json")).toBe(true);
    expect(matchesGlob(`.goals/x${char}.yaml`, ".goals/**")).toBe(true);
  });

  it("改行類の文字は `*` と `?` にも当たる", () => {
    for (const char of LINE_TERMINATORS) {
      expect(matchesGlob(`tsconfig${char}.json`, "tsconfig*.json")).toBe(true);
      expect(matchesGlob(`a${char}.ts`, "a?.ts")).toBe(true);
    }
  });

  it("`\\` を含む glob は、エスケープとして読まずにどのパスにも当てない", () => {
    expect(matchesGlob("src/a*b.ts", "src/a\\*b.ts")).toBe(false);
    expect(matchesGlob("src\\a.ts", "src\\a.ts")).toBe(false);
  });

  it("同じ glob を何度照合しても結果が変わらない", () => {
    // 組み立てた正規表現を使い回すので、状態を持つフラグ（`g`・`y`）が混ざると
    // 2回目から `lastIndex` がずれて外れる。
    for (let i = 0; i < 3; i += 1) {
      expect(matchesGlob("src/controller/index.ts", "src/controller/**")).toBe(true);
    }
  });
});
