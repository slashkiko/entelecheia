import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * clone 直後に README のセットアップ手順をそのまま叩けるか。
 *
 * いまは1行目の `mise install --locked` が trust エラーで止まる。
 *
 * ```console
 * $ mise install --locked
 * mise ERROR Config files in /path/to/entelecheia/mise.toml are not trusted.
 * mise ERROR Trust them with `mise trust`.
 * ```
 *
 * mise を日常的に使っていれば「trust を求められた」で読める。ただしこのリポジトリは
 * mise を入口の前提に置いているので、手順どおりに叩いて止まったとき、**環境の不備なのか
 * 手順の欠落なのかが外からは区別が付かない。** README には「Acceptance Criteria を先に
 * 書く進め方なので typecheck と test は落ちる」と、想定内の赤を先に宣言する書き方が
 * 既にある。trust もそこと同じ扱いにできる。
 *
 * 踏むのは作る側だけになる。使う側は `pnpm link --global` の側を通るので、
 * mise には行き当たらない（`tests/package-contract.test.ts`）。
 *
 * ここで固定するのは順序と位置だけにする。**説明の文言は決めない。**
 */

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const LINES = README.split("\n").map((line) => line.trim());

/** 行頭がそのコマンドで始まる最初の行。末尾のコメントは許す */
function firstLineStartingWith(command: string): number {
  return LINES.findIndex((line) => line.startsWith(command));
}

describe("clone 直後に叩ける手順になっている", () => {
  it("mise trust が載っている", () => {
    expect(firstLineStartingWith("mise trust")).toBeGreaterThan(-1);
  });

  it("mise install より前に mise trust がある", () => {
    // 逆だと、README のとおりに上から叩いた人が1行目で止まる。
    const trust = firstLineStartingWith("mise trust");
    const install = firstLineStartingWith("mise install --locked");

    expect(trust).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(trust).toBeLessThan(install);
  });

  it("mise trust と mise install が同じコードブロックに入っている", () => {
    // 散文の中で「先に trust してください」と書くのではなく、**コピーして
    // そのまま流せる並び**にする。間に ``` が挟まると、読む側は2回に分けて
    // 拾うことになり、1つ目を飛ばす経路が残る。
    const trust = firstLineStartingWith("mise trust");
    const install = firstLineStartingWith("mise install --locked");

    expect(trust).toBeGreaterThan(-1);
    expect(LINES.slice(trust, install).some((line) => line.startsWith("```"))).toBe(false);
  });
});
