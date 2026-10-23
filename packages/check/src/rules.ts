import type { EvidenceReport, EvidenceResult } from "@entelecheia/core/factory/evidence-report.js";
import { isCheckDefinition, isSnapshot } from "./definitions.js";
import type { TestCase } from "./junit.js";

/**
 * 検査の規則。I/O を持たず、観測した値から結果を決める。
 *
 * どれも E1（実装者のテスト）の層に属する。E1 は Actor が書いたテストなので、
 * テストが通ったことだけでは足りない。**テストを減らす・飛ばす・弱めることで通した**
 * 変更を、ここで落とす。
 */

/** verify のタスクがどう終わったか */
export type TaskOutcome = { type: "exited"; exitCode: number } | { type: "timed_out" };

export interface CheckObservation {
  /** base 側（PR の分岐点に、同じ検査の定義を差し込んだもの）で verify がどう終わったか */
  baselineOutcome: TaskOutcome;
  /** base 側のテスト。報告が無ければ null */
  baselineTests: readonly TestCase[] | null;
  head: { outcome: TaskOutcome; tests: readonly TestCase[] | null };
  /** 分岐点から head までに変わったテストのファイル。消したものは `after` が null */
  testFiles: readonly TestFileChange[];
  /** 分岐点から head までに変わったパス。rename は両側を入れる */
  changedPaths: readonly string[];
}

export interface TestFileChange {
  path: string;
  /** 分岐点での中身。足したファイルは null */
  before: string | null;
  /** head での中身。消したファイルは null */
  after: string | null;
}

export type CheckFindings = Pick<EvidenceReport, "results" | "tests" | "surface">;

export function evaluate(observation: CheckObservation): CheckFindings {
  const { baselineTests, head } = observation;
  const skips = newSkips(baselineTests, head.tests);
  const headPassed = head.outcome.type === "exited" && head.outcome.exitCode === 0;
  return {
    results: [
      verifyResult(observation.baselineOutcome, head.outcome),
      reportResult(baselineTests, head.tests, headPassed),
      countResult(baselineTests, head.tests, headPassed),
      skipResult(skips),
      weakenedResult(observation.testFiles),
      definitionsResult(observation.changedPaths),
    ],
    tests: {
      before: baselineTests?.length ?? null,
      after: head.tests?.length ?? null,
      new_skips: skips?.count ?? null,
    },
    surface: {
      // 型の置き場はリポジトリごとに違い、まだ設定から読まない。読めないので null にし、
      // 読む側（`summarizeEvidence`）が「差分あり」に倒す。
      types_changed: null,
      snapshots_changed: observation.changedPaths.some(isSnapshot),
    },
  };
}

function result(
  ruleId: string,
  status: EvidenceResult["status"],
  location: string | null = null,
  fixHint: string | null = null,
): EvidenceResult {
  return { layer: "E1", rule_id: ruleId, status, location, fix_hint: fixHint };
}

/**
 * verify が通ったか。分岐点でも落ちていたら、head が落ちても head のせいとは言えない。
 * PR を切った後で base に正解表とその実装が一緒に入ると、base の定義を差し込んだ分岐点と
 * head は、どちらもその実装を持たずに落ちる。不合格にすると、Actor は直せない赤を直しに
 * いく。skip は段階を上げないので、自動マージには届かない。
 */
function verifyResult(baseline: TaskOutcome, outcome: TaskOutcome): EvidenceResult {
  if (outcome.type === "exited" && outcome.exitCode === 0) {
    return result("verify", "pass");
  }
  if (baseline.type === "exited" && baseline.exitCode !== 0) {
    return result(
      "verify",
      "skip",
      null,
      "the merge base also fails with the base's check definitions; rebase onto the base and check again",
    );
  }
  return outcome.type === "timed_out"
    ? result("verify", "fail", null, "the verify task did not finish within the time limit")
    : result("verify", "fail", null, `the verify task exited with ${outcome.exitCode}`);
}

/**
 * head の verify が通らなかったときに、報告を読む規則の fix_hint に足す一文。
 *
 * 途中で落ちた verify の報告は欠けうるので、「報告が無い」「テストが減った」が verify と
 * 一緒に落ちることがある。それでも規則は当てる。外すと、実装を壊してそれで落ちるテストを
 * 消した変更（known-bad/delete-failing-test）で、消したことを verify を直すまで名指し
 * できない。かわりに、原因が verify の側にありうることを Actor に伝える。
 */
const UNFINISHED_NOTE =
  "the head's verify task also failed, so its report may be incomplete; make verify pass first";

function withNote(hint: string, headPassed: boolean): string {
  return headPassed ? hint : `${hint}; ${UNFINISHED_NOTE}`;
}

const REPORT_HINT = "write JUnit XML test reports under $ENT_CHECK_REPORT_DIR from the verify task";

/**
 * テストの報告があるか。base にあって head に無いのは、報告を書く口を head が外した形になる。
 * base にも無いリポジトリは、まだ報告を書いていないだけなので落とさず、skip にする。
 * skip は段階を上げない（`levelOf`）ので、報告の無いリポジトリは E1 に届かない。
 */
function reportResult(
  baseline: readonly TestCase[] | null,
  head: readonly TestCase[] | null,
  headPassed: boolean,
): EvidenceResult {
  if (head !== null) {
    return result("test-report", "pass");
  }
  return baseline === null
    ? result("test-report", "skip", null, REPORT_HINT)
    : result(
        "test-report",
        "fail",
        null,
        withNote(`the base wrote test reports and the head did not; ${REPORT_HINT}`, headPassed),
      );
}

function countResult(
  baseline: readonly TestCase[] | null,
  head: readonly TestCase[] | null,
  headPassed: boolean,
): EvidenceResult {
  if (baseline === null || head === null) {
    return result("test-count-dropped", "skip");
  }
  return head.length < baseline.length
    ? result(
        "test-count-dropped",
        "fail",
        null,
        withNote(
          `${baseline.length} tests at the base and ${head.length} at the head; keep or replace every removed test`,
          headPassed,
        ),
      )
    : result("test-count-dropped", "pass");
}

interface NewSkips {
  count: number;
  ids: string[];
}

/**
 * head で新しく飛ばしたテスト。同じ名前のテストが複数あるので、名前ごとの数で比べる。
 * 名前は `<testcase>` の name だけを使う。ファイルのパスを含めると、もとから飛ばしていた
 * テストのファイルを動かしただけで、新しく飛ばしたと読める。
 * base に無いテストを skip で足したものも数える。足したテストを飛ばせば、件数を
 * 保ったまま何も確かめない形になる。
 */
function newSkips(
  baseline: readonly TestCase[] | null,
  head: readonly TestCase[] | null,
): NewSkips | null {
  if (baseline === null || head === null) {
    return null;
  }
  const before = skippedCounts(baseline);
  const after = skippedCounts(head);
  const ids: string[] = [];
  let count = 0;
  for (const [name, skipped] of after) {
    const added = skipped - (before.get(name) ?? 0);
    if (added > 0) {
      count += added;
      ids.push(name);
    }
  }
  return { count, ids: ids.sort() };
}

function skippedCounts(tests: readonly TestCase[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const test of tests) {
    if (test.skipped) {
      counts.set(test.name, (counts.get(test.name) ?? 0) + 1);
    }
  }
  return counts;
}

function skipResult(skips: NewSkips | null): EvidenceResult {
  if (skips === null) {
    return result("test-newly-skipped", "skip");
  }
  return skips.count > 0
    ? result(
        "test-newly-skipped",
        "fail",
        // 名前の無い testcase も数える。空の名前を並べると location が空文字になり、schema が
        // 報告を拒んで「検査できなかった」に化ける。head が書いた報告で不合格を取り消せてしまう。
        skips.ids
          .slice(0, 10)
          .map((name) => (name === "" ? "(unnamed test)" : name))
          .join("\n"),
        "do not skip tests to get the check green; fix the code or the test",
      )
    : result("test-newly-skipped", "pass");
}

/**
 * アサーションの数え方。言語ごとの慣習を並べる。前後で同じ規則で数えるので、
 * 1行を2回数えても、減ったかどうかの判断は揺れない。
 */
const ASSERTIONS: readonly RegExp[] = [
  // `.expect(` は Rust の `Result::expect` などのメソッドで、アサーションではない
  /(?<!\.\s*)\bexpect\s*\(/g,
  /\bassert(?:\.[A-Za-z]+)?\s*\(/g,
  // unittest の `self.assertEqual(`、JUnit の `assertEquals(`
  /\bassert[A-Z]\w*\s*\(/g,
  // Go の標準の書き方（`if got != want { t.Errorf(...) }`）
  /\b(?:t|tb)\.(?:Errorf|Error|Fatalf|Fatal|FailNow|Fail)\s*\(/g,
  /\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne)!\s*\(/g,
  /\brequire\.[A-Z]\w*\s*\(/g,
  /^\s*assert\s+/gm,
];

/** 定数の値。これを確かめても、実装の何も確かめていない */
const LITERAL = String.raw`(?:true|false|null|undefined|None|True|False|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')`;

/**
 * 足した行のうち、何も確かめないアサーション。
 *
 * `expect(<定数>)` は、比べる相手も定数か、相手を取らない matcher のときだけ拾う。
 * `expect(320).toBe(total(items))` のように引数を逆に書いた正当な確かめは拾わない。
 */
const TAUTOLOGIES: readonly RegExp[] = [
  new RegExp(
    String.raw`\bexpect\s*\(\s*${LITERAL}\s*\)\s*(?:;|$|\.(?:not\s*\.)?\w+\s*\(\s*(?:${LITERAL}\s*)?\))`,
  ),
  /\bassert(?:\.ok)?\s*\(\s*(?:true|1)\s*[,)]/,
  new RegExp(
    String.raw`\bassert\.(?:strictEqual|equal|deepStrictEqual|deepEqual)\s*\(\s*(${LITERAL})\s*,\s*\1\s*[,)]`,
  ),
  /\bassert!\s*\(\s*true\s*[,)]/,
  new RegExp(String.raw`\bassert_eq!\s*\(\s*(${LITERAL})\s*,\s*\1\s*[,)]`),
  /^\s*assert\s+(?:True|1)\s*(?:$|,|#)/,
];

/**
 * 値の中身を確かめない形。`assert.ok(total(items))` は total が 0 でなければ何でも通る。
 * `assert.strictEqual(total(items), 320)` をこれに書き換えると、アサーションの数は
 * 変わらないまま、確かめる中身だけが消える。
 */
const WEAK_ASSERTIONS: readonly RegExp[] = [
  /\bassert(?:\.ok)?\s*\(/g,
  /\.\s*(?:toBeTruthy|toBeFalsy|toBeDefined)\s*\(/g,
  /\.\s*not\s*\.\s*(?:toBeNull|toBeUndefined)\s*\(/g,
  // chai
  /\.\s*to\s*\.\s*(?:not\s*\.\s*)?(?:be\s*\.\s*)?(?:ok|exist)\b/g,
];

/**
 * `expect(...)` に続く matcher（`.toBe(` や chai の `.to.`）。`expect(x);` のように matcher の
 * 無い行は何も確かめない。`expect(x.toString())` の `.toString(` を matcher と読むと、
 * 何も確かめない行を確かめる行に数えるので、JavaScript の組み込みの `to` で始まる
 * メソッドは除く。
 */
const MATCHER =
  /\)\s*\.\s*(?:(?:not|resolves|rejects)\s*\.\s*)*to(?:\s*\.|(?!(?:String|Fixed|Precision|Exponential|ISOString|JSON|LowerCase|UpperCase|LocaleString|LocaleLowerCase|LocaleUpperCase|LocaleDateString|LocaleTimeString|DateString|TimeString|UTCString|GMTString|Sorted|Reversed|Spliced|Array)\s*\()[A-Z]\w*\s*\()/g;
const EXPECT = /(?<!\.\s*)\bexpect\s*\(/g;

interface AssertionCount {
  /** アサーションの数 */
  all: number;
  /** そのうち、値の中身を確かめるもの */
  strong: number;
}

/**
 * アサーションの数。コメントと文字列の中は数えない。コメントを数えると、アサーションを
 * コメントアウトしても数が減らず、唯一の確かめを外した変更が通る。文字列を数えると、
 * `"expect("` を含む文字列を足して数を水増しできる。
 */
function countAssertions(source: string): AssertionCount {
  const code = stripCommentsAndStrings(source)
    .split("\n")
    .filter((line) => !isCommentLine(line))
    .join("\n");
  const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  const all = ASSERTIONS.reduce((total, pattern) => total + count(pattern), 0);
  const weak = WEAK_ASSERTIONS.reduce((total, pattern) => total + count(pattern), 0);
  const bare = Math.max(count(EXPECT) - count(MATCHER), 0);
  return { all, strong: Math.max(all - weak - bare, 0) };
}

/**
 * `/* *\/`・行末までの `//`・空白の後の `#`・文字列（`"`・`'`・`` ` ``・`"""`・`'''`）を落とす。
 * 行の数は変えない。
 * 正規表現のリテラルは見分けない。`/\/\//` の後ろは `//` として落ちるが、行末までなので
 * 数え漏らすのはその行の残りだけになる。
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else if ((char === "/" && next === "/") || (char === "#" && /\s/.test(source[i - 1] ?? ""))) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if ((char === '"' || char === "'") && source.startsWith(char.repeat(3), i)) {
      // Python の三重引用符。中で改行してよく、docstring でアサーションを囲って外す書き方になる
      const end = source.indexOf(char.repeat(3), i + 3);
      const stop = end === -1 ? source.length : end + 3;
      out += `""${source.slice(i, stop).replace(/[^\n]/g, "")}`;
      i = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) {
        if (source[j] === "\n" && char !== "`") break;
        j += source[j] === "\\" ? 2 : 1;
      }
      out += `""${source.slice(i, j).replace(/[^\n]/g, "")}`;
      i = source[j] === char ? j + 1 : j;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** `after` にあって `before` に無い行。同じ行が増えた分も数える */
function addedLines(before: string, after: string): string[] {
  const remaining = new Map<string, number>();
  for (const line of before.split("\n")) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
    } else {
      added.push(line);
    }
  }
  return added;
}

function isCommentLine(line: string): boolean {
  // `#[test]` のような Rust の属性はコメントではないが、アサーションも含まないので畳んでよい。
  return /^\s*(?:\/\/|#|\*|\/\*)/.test(line);
}

/**
 * テストを弱めた変更。次のどちらかに当たるファイルを拾う。
 *
 * - 変えたテストのファイル全体で、アサーションの数か、そのうち値の中身を確かめるものの
 *   数が、分岐点より減った。拾うのは数が減ったファイル（消したものを含む）。ファイルごと
 *   ではなく全体で比べるのは、テストを別のファイルへ移しただけの変更を落とさないため
 * - 足した行に、定数を確かめるだけのアサーションがある（`expect(true)` など）
 *
 * テストの件数は変わらないので、件数の規則では拾えない。差分を読む規則なので、
 * テストを `it.each` にまとめるような正当な書き換えでも、数が減れば落ちる。
 * 落ちたら人がマージする側に倒れるだけで、弱めたテストが通るよりは安全になる。
 */
export function weakenedTestFiles(files: readonly TestFileChange[]): string[] {
  const counted = files.map((file) => ({
    file,
    before: countAssertions(file.before ?? ""),
    after: countAssertions(file.after ?? ""),
  }));
  const decreased = (["all", "strong"] as const).flatMap((kind) => {
    const total = (side: "before" | "after") =>
      counted.reduce((sum, entry) => sum + entry[side][kind], 0);
    return total("after") < total("before")
      ? counted
          .filter((entry) => entry.after[kind] < entry.before[kind])
          .map((entry) => entry.file.path)
      : [];
  });
  const tautological = files
    .filter((file) =>
      addedLines(file.before ?? "", file.after ?? "")
        .filter((line) => !isCommentLine(line))
        .some((line) => TAUTOLOGIES.some((pattern) => pattern.test(line))),
    )
    .map((file) => file.path);
  return [...new Set([...decreased, ...tautological])].sort();
}

function weakenedResult(files: readonly TestFileChange[]): EvidenceResult {
  const weakened = weakenedTestFiles(files);
  return weakened.length > 0
    ? result(
        "test-weakened",
        "fail",
        weakened.join("\n"),
        "an assertion was removed or replaced with one that checks a constant; restore it",
      )
    : result("test-weakened", "pass");
}

/**
 * 検査の定義を変えた変更。検査は head の定義を base のものに差し替えて回すので、定義を変えた
 * 変更は、正当なもの（新しい package の tsconfig、正解表の追加、スナップショットの更新）でも
 * head の定義では測られない。
 *
 * 落とさずに skip にし、場所を名指しする。不合格にすると、正当な変更でも job が必ず赤になり、
 * 赤が「head が失敗した」だけを意味しなくなる。skip は段階を上げないので、自動マージには
 * 届かない。定義は承認ルールの下限（`checks-config` と `check-answers`）でもあるので、
 * この変更はどのみち人がマージする。base の定義で verify が落ちれば、それは verify の規則が
 * 落とす。
 */
function definitionsResult(changedPaths: readonly string[]): EvidenceResult {
  const touched = [...new Set(changedPaths.filter(isCheckDefinition))].sort();
  return touched.length > 0
    ? result(
        "check-definitions-changed",
        "skip",
        touched.join("\n"),
        "this change edits check definitions, which the check replaces with the base's, so the head's definitions were not measured; a human reviews and merges it",
      )
    : result("check-definitions-changed", "pass");
}
