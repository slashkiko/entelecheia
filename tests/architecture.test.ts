import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 層の境界を機械的に固定する。
 *
 * 境界そのものはレビューで守られてきたが、守られていることを確かめる手段が
 * コメントしか無かった。import を1本足すだけで崩れる種類の性質なので、
 * 崩れた瞬間に落ちるものを置く。
 *
 * ここで見るのは import 文の文字列だけで、型は見ない。層の違反は必ず
 * 「別の層のファイルを名指しする」形で現れるので、それで足りる。
 */

const SRC = new URL("../src/", import.meta.url).pathname;
const FROM = /\bfrom\s+"([^"]+)"/g;

/**
 * どの Port にどの Adapter を挿すかを決める唯一の場所（`src/wiring/index.ts`）。
 *
 * ここを定数にしておくのは、合成ルートを動かすときに許可リストを1箇所だけ
 * 書き換えれば済むようにするため。テストの本文に文字列を散らすと、片方だけ
 * 直したときに「ルールはあるのに誰も守っていない」状態が作れる。
 */
const COMPOSITION_ROOT = "wiring/index.ts";

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(FROM)].map((matched) => matched[1] ?? "");
}

function relativeToSrc(file: string): string {
  return file.slice(SRC.length);
}

describe("層の境界", () => {
  it("src/domain/** は他の層を import しない", () => {
    // domain は他のどこからも参照される最下層で、逆向きの依存が1本でも入ると
    // 「Goal の語彙だけを持つ層」ではなくなる。相対で層の外へ出る import は
    // 定義上そのまま違反になるので、許可リストを持たずに済む。
    const offenders = tsFilesUnder(join(SRC, "domain")).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith("../"))
        .map((specifier) => `${relativeToSrc(file)} -> ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("src/adapters/** を import するのは合成ルートだけ", () => {
    // Port 注入が意味を持つのは、実装を選ぶ場所が1箇所しか無いときだけ。
    // ここが増えると、テストで差し替えたつもりの Port が本番では別経路から
    // 直接入ってくる状態を作れてしまう（design.md §3.3）。
    //
    // **その1箇所は `cli.ts` ではなく `wiring/index.ts` にする。** ルールが
    // 求めているのは「実装を選ぶ場所が1箇所」であって「その1箇所が CLI であること」
    // ではない。cli.ts に固定していたあいだ、引数の解釈もユースケースも出力の整形も
    // 同じファイルに集まり続け、1,779 行になっていた。合成ルートを別に持てば、
    // 同じ不変条件を保ったまま CLI は Adapter を知らずに済む。
    const offenders = tsFilesUnder(SRC)
      .filter((file) => relativeToSrc(file) !== COMPOSITION_ROOT)
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.includes("adapters/"))
          .map((specifier) => `${relativeToSrc(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });
});
