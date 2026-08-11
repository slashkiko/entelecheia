import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR } from "../src/usecase/doctor.js";

/**
 * 配布物の輪郭を固定する。**ent を「使うだけ」の人が通る入口の話になる。**
 *
 * README は「この repo の外のリポジトリで使う」を正式な使い方として書いている。
 * ent 本体は1つビルドしておき、対象リポジトリのルートで叩けばよい。ところが
 * その「使うだけ」の人も、いまは contributor と同じ入口（mise / pnpm / tsc）を
 * 通ることになっている。**ent の実行にそれらは1つも要らない。**
 *
 * - `src/` に mise への参照が1つも無い
 * - `ent doctor` が見るものに mise は入っていない
 *
 * ビルド済みの `dist/cli.js` があれば、使う側に残るのは Node 24 以上と gh と
 * Actor のログインの3つだけになる。`package.json` の `bin` に `ent` は既に
 * 登録してあり、`dist/cli.js` には shebang もある。**PATH に `ent` を通すだけなら
 * npm への公開は要らない**（`pnpm link --global` はローカルの checkout から
 * global の bin を張るので、`"private": true` のままで効く）。
 *
 * ここで固定するのは、その `pnpm link --global` が素で通るための輪郭になる。
 * `npx entelecheia` まで通す判断——npm への公開——はこの Goal の外に置く。
 * 公開は外向きの操作で、ループの中で決めるものではない。
 */

const ROOT = new URL("../", import.meta.url);

interface PackageJson {
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
}

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", ROOT)), "utf8"),
) as PackageJson;

/** `files` の要素が、そのパスを配布物に含めるか */
function covers(entry: string, path: string): boolean {
  const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

describe("PATH に ent を通す入口", () => {
  it("bin に ent が登録してある", () => {
    expect(pkg.bin?.ent).toBeTypeOf("string");
  });

  it("bin の実体に shebang がある", () => {
    // shebang が無いと、`node <path>` と書かない起動の仕方——symlink や
    // PATH に置くラッパー——が作れない。`pnpm link --global` が張るのは
    // まさにその symlink になる。
    const source = readFileSync(fileURLToPath(new URL("src/cli.ts", ROOT)), "utf8");

    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("bin の指す先が files に含まれている", () => {
    // `files` から漏れると、`pnpm pack` にも `npm publish` にも入口が入らない。
    // 張った symlink の先に何も無い、という壊れ方になる。
    const target = (pkg.bin?.ent ?? "").replace(/^\.\//, "");
    const files = pkg.files ?? [];

    expect(files.length).toBeGreaterThan(0);
    expect(files.some((entry) => covers(entry, target))).toBe(true);
  });

  it("files がソースとテストを配らない", () => {
    // 使う側に要るのはビルド済みの成果物だけになる。`src/` や `tests/` を
    // 配ると、使う側の入口に contributor の持ち物が混ざる。
    const files = pkg.files ?? [];

    expect(files.some((entry) => covers(entry, "src/cli.ts"))).toBe(false);
    expect(files.some((entry) => covers(entry, "tests/cli-main.test.ts"))).toBe(false);
  });
});

describe("使う側に要る Node のバージョン", () => {
  it("engines.node が doctor の下限と一致する", () => {
    // 2箇所に別々の数字を書くと、片方だけ動いたときに
    // 「入るのに動かない」か「動くのに入らない」のどちらかになる。
    // doctor が出す detail は `node:sqlite` を根拠にしていて、そちらが正になる。
    expect(pkg.engines?.node).toBe(`>=${String(MIN_NODE_MAJOR)}`);
  });

  it("doctor の下限が読める形で公開されている", () => {
    // package.json と突き合わせられないと、この検査自体が書けない。
    expect(MIN_NODE_MAJOR).toBeTypeOf("number");
  });
});

describe("README が使う側と作る側を分けている", () => {
  // issue が挙げる直し方の1つ目にあたる。README は「この repo の外のリポジトリで
  // 使う」を正式な使い方として書いているのに、その「使うだけ」の人も contributor と
  // 同じ入口（mise / pnpm install / tsc）を通ることになっている。
  const readme = readFileSync(fileURLToPath(new URL("README.md", ROOT)), "utf8");

  it("使う側が PATH に通す手順が載っている", () => {
    expect(readme).toContain("pnpm link --global");
  });

  it("使う側の入口が、作る側の入口より先に出てくる", () => {
    // 順序だけを固定して、見出しの文言は決めない。**使うだけの人が
    // `pnpm install --frozen-lockfile` に行き当たる前に、自分の入口を読み終えて
    // いること**が満たしたい性質になる。
    const use = readme.indexOf("pnpm link --global");
    const build = readme.indexOf("pnpm install --frozen-lockfile");

    expect(use).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(use).toBeLessThan(build);
  });
});

describe("npm への公開は別の判断として残す", () => {
  it("private のままになっている", () => {
    // `pnpm link --global` は `"private": true` のままで効く。公開は外向きの
    // 操作で、ループの中で決めるものではない。**この検査は「まだ公開しない」を
    // 固定するもので、公開したくなったらここを人間が外す。**
    expect(pkg.private).toBe(true);
  });
});
