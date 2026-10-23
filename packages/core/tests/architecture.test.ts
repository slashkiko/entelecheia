import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * core と、package どうしの境界を機械的に固定する。
 *
 * core は ent・check・governor のすべてが依存する一番下の package になる。ここが I/O を
 * 1つでも持つと、check と governor は「ent とは別のプロセスで、決定的に判断する」という
 * 前提を失う。Actor の出力を扱う ent が壊れても、検査と merge の判断が巻き込まれない
 * ようにするのが分けた理由なので、core に入れてよいものをここで絞る。
 *
 * 見るのは ent の `tests/architecture.test.ts` と同じく import 文の文字列だけで、型は見ない。
 * ent のものと違い、`from` の無い `import "x"` も拾い、動的な `import()` と `require()` は
 * 書いた時点で止める。どちらも `from` を含まないので、import 文だけを見る規則をすり抜ける。
 */

const PACKAGES = new URL("../../", import.meta.url).pathname;
const CORE_SRC = join(PACKAGES, "core", "src");
/** `import … from "x"`・`export … from "x"`・`import "x"` の `x` */
const SPECIFIER = /(?:\bfrom\s+|\bimport\s+)"([^"]+)"/g;

/**
 * core が import してよい、相対パス以外のもの。
 *
 * 外部の依存は zod だけにする（設計の「モジュールの境界」）。YAML の文字列を読むのは
 * 呼ぶ側の仕事で、core は読んだ後の値を zod で検める。Node 組み込みは、ent の
 * domain に許していたもののうち I/O でない2つだけを残す。`node:path` の文字列操作と
 * `node:crypto` のハッシュは計算で、外に出すと呼び出し側が実装を選べてしまう。
 */
const CORE_ALLOWED = ["zod", "node:path", "node:crypto"] as const;

/**
 * core のコードに現れてはいけない呼び出し。時計・乱数・環境・プロセス・ネットワーク・出力。
 *
 * 全部「引数で受ける」側に回す（設計の「モジュールの境界」）。`new Date(<値>)` は渡された
 * 時刻の読み替えなので許し、引数のない `new Date()` だけを止める。
 */
const IMPURE = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(\s*\)/,
  /\bMath\.random\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bprocess\./,
  /\brandomUUID\b/,
  /\brandomBytes\b/,
  /\bgetRandomValues\b/,
  /\brandomInt\b/,
  /\brandomFill(?:Sync)?\b/,
  /\bgenerateKey(?:Pair)?(?:Sync)?\b/,
  /\bgeneratePrime(?:Sync)?\b/,
  // 動的な読み込みは、import 文の規則に掛からずに何でも持ち込める
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bfetch\s*\(/,
  /\bconsole\./,
] as const;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function importsOf(file: string): string[] {
  return specifiersIn(readFileSync(file, "utf8"));
}

function specifiersIn(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((matched) => matched[1] ?? "");
}

/**
 * コメントを落とす。説明の中に `Date.now()` や `process.cwd()` と書いただけで落ちる形に
 * すると、なぜ使わないのかをコードの横に書けなくなる。
 *
 * 文字列と正規表現のリテラルは読み飛ばしてそのまま残す。`"packages/ent/src/controller/**"` の
 * ような文字列の中の `/*` をコメントの始まりと読むと、次の `*\/` までのコードが丸ごと検査から
 * 消える。リテラルの中身は呼び出しではないので、残しても誤って拾うことはない。
 */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  // `/` が割り算か正規表現の始まりかは、直前のトークンで決まる。値の後なら割り算。
  // `return` のような語の後は値ではないので、語は最後まで読んでから判断する。
  let afterValue = false;
  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`" || (char === "/" && !afterValue)) {
      const end = literalEnd(source, i);
      out += source.slice(i, end);
      i = end;
      afterValue = true;
      continue;
    }
    const word = /^[\w$]+/.exec(source.slice(i, i + 64))?.[0];
    if (word !== undefined) {
      out += word;
      i += word.length;
      afterValue = !REGEX_AFTER.has(word);
      continue;
    }
    out += char;
    i += 1;
    if (!/\s/.test(char)) {
      afterValue = char === ")" || char === "]";
    }
  }
  return out;
}

/** この語の後の `/` は、割り算ではなく正規表現の始まり */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "yield",
  "await",
  "else",
  "do",
]);

/** `start` にある引用符か `/` で始まるリテラルの、閉じた直後の位置 */
function literalEnd(source: string, start: number): number {
  const quote = source[start];
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (quote === "/") {
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        // フラグも同じリテラルに含める
        let end = i + 1;
        while (/[a-z]/.test(source[end] ?? "")) end += 1;
        return end;
      } else if (char === "\n") return i;
      continue;
    }
    if (char === quote) return i + 1;
    if (char === "\n" && quote !== "`") return i;
  }
  return source.length;
}

function packageNames(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe("core の境界", () => {
  it("相対パスで core の外へ出ない", () => {
    // `../../ent/src/...` のように相対で他の package を名指しされると、package 名の
    // import を見る下の規則の網から外れる。
    const offenders = tsFilesUnder(CORE_SRC).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith("."))
        .filter((specifier) =>
          relative(CORE_SRC, resolve(dirname(file), specifier)).startsWith(".."),
        )
        .map((specifier) => `${relative(CORE_SRC, file)} -> ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("相対パス以外で import するのは zod と、許した Node 組み込みだけ", () => {
    const allowed = new Set<string>(CORE_ALLOWED);
    const offenders = tsFilesUnder(CORE_SRC).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => !specifier.startsWith("."))
        .filter((specifier) => !allowed.has(specifier))
        .map((specifier) => `${relative(CORE_SRC, file)} -> ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("時計・乱数・環境・プロセス・ネットワーク・出力に直に触らない", () => {
    const offenders = tsFilesUnder(CORE_SRC).flatMap((file) => {
      const source = withoutComments(readFileSync(file, "utf8"));
      return IMPURE.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${relative(CORE_SRC, file)} -> ${pattern.source}`,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("package.json の依存は zod だけ", () => {
    // import を見る規則だけだと、依存を足しておいて型だけ使う、といった形が残る。
    // 依存の宣言そのものも同じ集合に縛る。
    const pkg = JSON.parse(readFileSync(join(PACKAGES, "core", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
    expect(pkg.peerDependencies).toBeUndefined();
  });
});

describe("境界の検査そのもの", () => {
  // 検査が何も見ていなくても、違反が無ければ緑になる。違反を書いた断片を通して、
  // 実際に拾えることを確かめる。
  it("import の形を問わず、読み込む先を拾う", () => {
    expect(
      specifiersIn(
        [
          'import { z } from "zod";',
          'import type { A } from "./a.js";',
          'export { b } from "./b.js";',
          'import "node:fs";',
        ].join("\n"),
      ),
    ).toEqual(["zod", "./a.js", "./b.js", "node:fs"]);
  });

  it.each([
    'const fs = await import("node:fs");',
    "const fs = require('node:fs');",
    "const n = randomInt(10);",
    "randomFillSync(buffer);",
    "const now = Date.now();",
    "const at = new Date();",
  ])("I/O か非決定の呼び出し %s を拾う", (line) => {
    expect(IMPURE.some((pattern) => pattern.test(line))).toBe(true);
  });

  it("コメントは落とし、文字列と正規表現の中の `/*` はコメントと読まない", () => {
    const source = [
      'const floor = ["src/controller/**", ".goals/**"];',
      "const now = Date.now();",
      "const glob = /\\/\\*[^*]*/g;",
      "const at = new Date();",
      "/** 説明の中の Math.random() */",
      "// process.exit()",
      "const ratio = a / b; // console.log()",
      "if (x) return /[/*]/.test(s);",
      "const later = performance.now();",
      "/* 閉じ */",
    ].join("\n");
    const stripped = withoutComments(source);

    expect(stripped).toContain("Date.now()");
    expect(stripped).toContain("new Date()");
    expect(stripped).toContain("a / b;");
    expect(stripped).toContain("performance.now()");
    expect(stripped).not.toContain("Math.random");
    expect(stripped).not.toContain("process.exit");
    expect(stripped).not.toContain("console.log");
  });

  it("渡された時刻の読み替えは拾わない", () => {
    expect(IMPURE.some((pattern) => pattern.test("const at = new Date(input.now);"))).toBe(false);
  });
});

describe("package どうしの境界", () => {
  it("相対パスで別の package の中へ入らない", () => {
    // package の間は package 名（`@entelecheia/core/...`）で import する。相対パスで
    // 覗くと、`exports` で決めた入口を迂回し、依存の向きの検査にも掛からない。
    const offenders = packageNames().flatMap((name) => {
      const root = join(PACKAGES, name);
      return ["src", "tests"].flatMap((dir) => {
        const base = join(root, dir);
        let files: string[];
        try {
          files = tsFilesUnder(base);
        } catch {
          return [];
        }
        return files.flatMap((file) =>
          importsOf(file)
            .filter((specifier) => specifier.startsWith("."))
            .filter((specifier) =>
              relative(root, resolve(dirname(file), specifier)).startsWith(".."),
            )
            .map((specifier) => `${relative(PACKAGES, file)} -> ${specifier}`),
        );
      });
    });

    expect(offenders).toEqual([]);
  });

  it("ent を import してよいのは ent だけ", () => {
    // check と governor は ent に依存しない（設計の「モジュールの境界」）。Actor の出力を
    // 扱う ent が壊れても、検査と merge の判断が巻き込まれないようにするため。
    const offenders = packageNames()
      .filter((name) => name !== "ent")
      .flatMap((name) =>
        tsFilesUnder(join(PACKAGES, name, "src")).flatMap((file) =>
          importsOf(file)
            .filter(
              (specifier) => specifier === "entelecheia" || specifier.startsWith("entelecheia/"),
            )
            .map((specifier) => `${relative(PACKAGES, file)} -> ${specifier}`),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("governor の依存は core と zod だけ", () => {
    // governor は merge と push の書き込みトークンを持つ唯一の部品になる。Agent SDK を入れると、
    // LLM の出力が merge の判断と同じプロセスに入る。依存を足すたびに、その供給網も
    // 書き込みトークンに届く。足すときはここを直して理由を残す。
    const pkg = JSON.parse(readFileSync(join(PACKAGES, "governor", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@entelecheia/core", "zod"]);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it("governor のコードが import するのは core と zod と Node 組み込みだけ", () => {
    // package.json を見る規則だけだと、ルートの node_modules にある別の package（ent の
    // Agent SDK など）を宣言せずに import する形が残る。
    const offenders = tsFilesUnder(join(PACKAGES, "governor", "src")).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => !specifier.startsWith("."))
        .filter(
          (specifier) =>
            specifier !== "zod" &&
            !specifier.startsWith("node:") &&
            !specifier.startsWith("@entelecheia/core/"),
        )
        .map((specifier) => `${relative(PACKAGES, file)} -> ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });
});
