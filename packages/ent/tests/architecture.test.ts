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

/** 許可リストの「どのファイルでもよい」を表す印。ファイル名には現れない文字を使う */
const ANY_FILE = "*";

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

  it("src/domain/** が使う Node 組み込みは、許可した分だけ", () => {
    // 上の「相対 import で層の外へ出ない」だけでは、ドメインが I/O を持つことを
    // 止められない。`node:fs` は相対 import ではないので網に掛からず、実際に
    // `goal-loader.ts` が `readFileSync` でファイルを読んでいた。層の依存は無くても、
    // ファイルシステムに触る時点でテストから差し替えられない部品になる。
    //
    // 全面禁止にはしない。`node:path` の文字列操作と `node:crypto` のハッシュは
    // 計算であって I/O ではなく、外に出すと呼び出し側が実装を選べてしまう。
    // `node:fs` は1箇所だけ例外にする——`protected-paths.ts` の `realpathSync` は
    // シンボリックリンクを実体へ解決するもので、**関門の要件そのもの**にあたる。
    // 外に出すと「解決し忘れた入力」を作れる。意図した例外であることを、
    // コメントではなくここに残す。
    const allowed = new Map<string, readonly string[]>([
      ["node:path", [ANY_FILE]],
      ["node:crypto", [ANY_FILE]],
      ["node:fs", ["protected-paths.ts"]],
    ]);

    const offenders = tsFilesUnder(join(SRC, "domain")).flatMap((file) => {
      const name = relativeToSrc(file).slice("domain/".length);
      return importsOf(file)
        .filter((specifier) => specifier.startsWith("node:"))
        .filter((specifier) => {
          const files = allowed.get(specifier);
          return files === undefined || !(files.includes(ANY_FILE) || files.includes(name));
        })
        .map((specifier) => `domain/${name} -> ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  it("src/usecase/** と src/cli/** は合成ルートを import しない", () => {
    // 依存の向きは外→内で、合成ルートはいちばん外側にある。ユースケースが
    // そこを見に行くと、`initRepository` が「git に聞く実装」を自分で選ぶことになり、
    // Port で受け取る形（`InitProbes` / `DoctorProbes`）が骨抜きになる。
    // 合成ルート側は cli.ts と usecase の型を import するので、循環にもなる。
    //
    // 呼ぶのは `src/cli.ts` だけ。あそこがサブコマンドごとの手順を書く場所で、
    // 「どの実装を挿すか」を合成ルートから受け取って usecase に渡す。
    const inner = tsFilesUnder(SRC).filter((file) => {
      const path = relativeToSrc(file);
      return path.startsWith("usecase/") || path.startsWith("cli/");
    });

    const offenders = inner.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.includes("wiring/"))
        .map((specifier) => `${relativeToSrc(file)} -> ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("src/store/sqlite.ts を import するのは合成ルートだけ", () => {
    // 永続化も Adapter と同じ扱いにする。`Store` は使う側が所有する Port
    // （`src/store/port.ts`）で、SQLite であることは口からは見えない。
    //
    // このルールが無かったあいだ、`src/store/` は `src/adapters/` の下に無いために
    // 上のルールの網から外れていた。`Store` と `GoalState` の宣言そのものが
    // SQLite 実装のファイルにあり、`src/controller/index.ts` がそこを名指しで
    // import していた——内側が外側を参照する唯一の経路になっていた。
    const offenders = tsFilesUnder(SRC)
      .filter((file) => relativeToSrc(file) !== COMPOSITION_ROOT)
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.includes("store/sqlite"))
          .map((specifier) => `${relativeToSrc(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });
});
