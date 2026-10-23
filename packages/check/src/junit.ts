/**
 * JUnit XML のテストの報告を読む。依存を増やさないので自前で書く。
 *
 * 検査がテストの件数と skip を数えるのは、言語ごとのテストの道具を知らずに済ませるため。
 * Vitest・node:test・cargo-nextest・go-junit-report のどれも JUnit XML を書ける。
 * リポジトリの verify は、`ENT_CHECK_REPORT_DIR` の下に報告を書けばよい。
 *
 * 読むのは `<testcase>` と、その中の `<skipped>` だけになる。
 * XML として正しいかは検めない。JUnit のタグが1つも無いファイルは、報告として数えない
 * （`readReports`）。
 */

export interface TestCase {
  /**
   * `<testcase>` の name。suite と classname は入れない。Vitest はそこにファイルのパスを
   * 書くので、ファイルを動かしただけで別のテストに見える
   */
  name: string;
  skipped: boolean;
}

/** 開きタグ・閉じタグ・空要素タグ。属性の値の中の `>` でタグを切らない */
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseJUnit(xml: string): TestCase[] {
  // コメントと CDATA の中身はタグとして読まない。失敗の本文に `<testcase` と
  // 書かれていても、テストの件数は増えない。
  const source = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const cases: TestCase[] = [];
  let open: TestCase | null = null;

  for (const match of source.matchAll(TAG)) {
    const [, closing, name, attributes = "", selfClosing] = match;
    if (name === "testcase") {
      if (closing === "/") {
        if (open !== null) cases.push(open);
        open = null;
        continue;
      }
      if (open !== null) cases.push(open);
      const testCase: TestCase = {
        name: attributesOf(attributes).get("name") ?? "",
        skipped: false,
      };
      if (selfClosing === "/") {
        cases.push(testCase);
        open = null;
      } else {
        open = testCase;
      }
      continue;
    }
    if (name === "skipped" && closing !== "/" && open !== null) {
      open.skipped = true;
    }
  }
  if (open !== null) cases.push(open);
  return cases;
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, key, doubleQuoted, singleQuoted] of source.matchAll(ATTRIBUTE)) {
    if (key !== undefined) {
      attributes.set(key, decodeEntities(doubleQuoted ?? singleQuoted ?? ""));
    }
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (raw, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
        // 範囲外の文字参照で例外を投げると、報告1つで検査全体が止まる。そのまま残す。
        return code <= 0x10ffff ? String.fromCodePoint(code) : raw;
      }
    }
  });
}
