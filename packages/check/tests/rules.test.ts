import { evidenceResultSchema, levelOf } from "@entelecheia/core/factory/evidence-report.js";
import { describe, expect, it } from "vitest";
import type { TestCase } from "../src/junit.js";
import { type CheckObservation, evaluate, weakenedTestFiles } from "../src/rules.js";

/** `~` を付けた名前は飛ばしたテスト */
function tests(...names: string[]): TestCase[] {
  return names.map((name) => ({ name: name.replace(/^~/, ""), skipped: name.startsWith("~") }));
}

function observation(overrides: Partial<CheckObservation> = {}): CheckObservation {
  return {
    baselineOutcome: { type: "exited", exitCode: 0 },
    baselineTests: tests("a", "b", "c"),
    head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "b", "c") },
    testFiles: [],
    changedPaths: ["src/app.ts"],
    ...overrides,
  };
}

function statusOf(ruleId: string, overrides: Partial<CheckObservation> = {}) {
  return evaluate(observation(overrides)).results.find((result) => result.rule_id === ruleId)
    ?.status;
}

describe("検査の規則", () => {
  it("揃った観測は全部通り、E1 に届く", () => {
    const findings = evaluate(observation());

    expect(findings.results.map((result) => [result.rule_id, result.status])).toEqual([
      ["verify", "pass"],
      ["test-report", "pass"],
      ["test-count-dropped", "pass"],
      ["test-newly-skipped", "pass"],
      ["test-weakened", "pass"],
      ["check-definitions-changed", "pass"],
    ]);
    expect(levelOf(findings.results)).toBe("E1");
    expect(findings.tests).toEqual({ before: 3, after: 3, new_skips: 0 });
  });

  it.each([
    [{ type: "exited", exitCode: 1 }, "fail"],
    [{ type: "timed_out" }, "fail"],
    [{ type: "exited", exitCode: 0 }, "pass"],
  ] as const)("verify が %o で終われば %s", (outcome, status) => {
    expect(statusOf("verify", { head: { outcome, tests: tests("a", "b", "c") } })).toBe(status);
  });

  it.each([
    [{ type: "exited", exitCode: 1 }, "skip"],
    [{ type: "timed_out" }, "skip"],
    [{ type: "exited", exitCode: 0 }, "pass"],
  ] as const)("分岐点でも verify が落ちていれば、head が %o で終わっても %s", (outcome, status) => {
    // base に遅れた PR。base の定義が、分岐点にも head にも無い実装を探して落ちる。
    expect(
      statusOf("verify", {
        baselineOutcome: { type: "exited", exitCode: 1 },
        head: { outcome, tests: tests("a", "b", "c") },
      }),
    ).toBe(status);
  });

  describe("テストの報告", () => {
    it("base にあって head に無ければ落とす", () => {
      expect(
        statusOf("test-report", {
          head: { outcome: { type: "exited", exitCode: 0 }, tests: null },
        }),
      ).toBe("fail");
    });

    it("どちらにも無ければ skip にし、E1 に届かない", () => {
      const findings = evaluate(
        observation({
          baselineTests: null,
          head: { outcome: { type: "exited", exitCode: 0 }, tests: null },
        }),
      );

      expect(findings.results.find((result) => result.rule_id === "test-report")?.status).toBe(
        "skip",
      );
      expect(levelOf(findings.results)).toBe("E0");
      // 0 と書くと「テストが0件だった」と読めてしまう。
      expect(findings.tests).toEqual({ before: null, after: null, new_skips: null });
    });
  });

  describe("テストの件数", () => {
    it("減ったら落とす", () => {
      expect(
        statusOf("test-count-dropped", {
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "b") },
        }),
      ).toBe("fail");
    });

    it("head の verify も落ちていれば、報告が欠けうることを fix_hint に足す", () => {
      const result = evaluate(
        observation({
          head: { outcome: { type: "exited", exitCode: 1 }, tests: tests("a", "b") },
        }),
      ).results.find((entry) => entry.rule_id === "test-count-dropped");

      expect(result?.status).toBe("fail");
      expect(result?.fix_hint).toContain("its report may be incomplete");
    });

    it("増えたら通す", () => {
      expect(
        statusOf("test-count-dropped", {
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "b", "c", "d") },
        }),
      ).toBe("pass");
    });
  });

  describe("新しく飛ばしたテスト", () => {
    it("通っていたテストを飛ばしたら落とす", () => {
      const findings = evaluate(
        observation({
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "~b", "c") },
        }),
      );

      expect(
        findings.results.find((result) => result.rule_id === "test-newly-skipped"),
      ).toMatchObject({ status: "fail", location: "b" });
      expect(findings.tests.new_skips).toBe(1);
    });

    it("名前の無いテストを飛ばしても、場所を空にしない", () => {
      // 空の location は schema が拒む。head の書いた報告で不合格を「検査できなかった」に
      // 変えられないようにする。
      const result = evaluate(
        observation({
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "b", "c", "~") },
        }),
      ).results.find((entry) => entry.rule_id === "test-newly-skipped");

      expect(result).toMatchObject({ status: "fail", location: "(unnamed test)" });
      expect(evidenceResultSchema.safeParse(result).success).toBe(true);
    });

    it("足したテストを飛ばしたものも数える", () => {
      // 件数を保ったまま、何も確かめないテストを足す形になる。
      expect(
        statusOf("test-newly-skipped", {
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "b", "c", "~d") },
        }),
      ).toBe("fail");
    });

    it("base でもう飛ばしていたテストは数えない", () => {
      expect(
        statusOf("test-newly-skipped", {
          baselineTests: tests("a", "~b"),
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("a", "~b") },
        }),
      ).toBe("pass");
    });

    it("同じ名前のテストは数で比べる", () => {
      expect(
        statusOf("test-newly-skipped", {
          baselineTests: tests("dup", "~dup"),
          head: { outcome: { type: "exited", exitCode: 0 }, tests: tests("~dup", "~dup") },
        }),
      ).toBe("fail");
    });
  });

  it("検査の定義に触れたら、場所を名指しして測れなかったにする", () => {
    // head の定義は base のものに差し替わるので、正当な変更でも head の定義では測れない。
    const findings = evaluate(
      observation({ changedPaths: ["src/app.ts", "verify/vectors.json", "mise.toml"] }),
    );

    expect(
      findings.results.find((result) => result.rule_id === "check-definitions-changed"),
    ).toMatchObject({ status: "skip", location: "mise.toml\nverify/vectors.json" });
    expect(levelOf(findings.results)).toBe("E0");
  });

  it("スナップショットの差分を面の差分として出す", () => {
    expect(evaluate(observation({ changedPaths: ["snapshots/home.png"] })).surface).toEqual({
      types_changed: null,
      snapshots_changed: true,
    });
    expect(evaluate(observation()).surface.snapshots_changed).toBe(false);
  });
});

describe("テストを弱めた変更", () => {
  const before = [
    'test("a", () => {',
    "  expect(add(1, 2)).toBe(3);",
    "  expect(add(0, 0)).toBe(0);",
    "});",
  ].join("\n");

  const tautologies = [
    ["expect(true).toBe(true);"],
    ["expect(true);"],
    ["expect(1).toBeTruthy();"],
    ["expect(null).not.toBeUndefined();"],
    ['expect("x").toBe("x");'],
    ["assert.ok(true);"],
    ["assert(true, 'always');"],
    ["assert.strictEqual(1, 1);"],
    ["assert!(true);"],
    ["assert_eq!(1, 1);"],
    ["assert True"],
  ] as const;

  it.each(tautologies)("足した行の %s を拾う", (line) => {
    const after = before.replace("expect(add(0, 0)).toBe(0);", line);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it.each(tautologies)("確かめを残したまま %s を足しただけでも拾う", (line) => {
    // 置き換えると数が減るので、数の規則だけで拾えてしまう。足すだけなら数は減らず、
    // 定数を確かめる行の規則だけが拾う。
    const after = before.replace("});", `  ${line}\n});`);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it.each([
    ["node:assert", "tests/a.test.ts", "assert.strictEqual(add(1, 2), 3);"],
    ["Rust の assert_eq!", "tests/a.rs", "assert_eq!(add(1, 2), 3);"],
    ["Go の testify", "a_test.go", "require.Equal(t, 3, add(1, 2))"],
    ["pytest の assert", "tests/test_a.py", "assert add(1, 2) == 3"],
    ["unittest", "tests/test_a.py", "self.assertEqual(add(1, 2), 3)"],
    ["JUnit", "src/test/AddTest.java", "assertEquals(3, add(1, 2));"],
    ["Go の標準の書き方", "a_test.go", 't.Errorf("add(1, 2) = %d", got)'],
  ])("%s の行を消したら拾う", (_label, path, line) => {
    const file = `keep_going()\n    ${line}\n    ${line}\n`;
    const after = `keep_going()\n    ${line}\n`;

    expect(weakenedTestFiles([{ path, before: file, after }])).toEqual([path]);
  });

  it("アサーションを消したら拾う", () => {
    const after = before.replace("  expect(add(0, 0)).toBe(0);\n", "");

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it("テストのファイルを消したら拾う", () => {
    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after: null }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it("別のファイルへ移しただけなら拾わない", () => {
    // 全体で数えるので、移した先で数が戻れば減っていない。
    expect(
      weakenedTestFiles([
        { path: "tests/a.test.ts", before, after: "" },
        { path: "tests/b.test.ts", before: null, after: before },
      ]),
    ).toEqual([]);
  });

  it("アサーションを足すだけなら拾わない", () => {
    const after = before.replace("});", "  expect(add(2, 2)).toBe(4);\n});");

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([]);
  });

  it.each([
    ["//", "  // expect(add(0, 0)).toBe(0);"],
    ["/* */", "  /* expect(add(0, 0)).toBe(0); */"],
    ["複数行の /* */", "  /*\n  expect(add(0, 0)).toBe(0);\n  */"],
    ["#", "  # expect(add(0, 0)).toBe(0);"],
  ])("アサーションを %s でコメントアウトしたら拾う", (_label, line) => {
    const after = before.replace("  expect(add(0, 0)).toBe(0);", line);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it.each([["expect(320).toBe(total(items));"], ["expect(true).toBe(isValid(input));"]])(
    "引数を逆に書いた正当な確かめ %s は拾わない",
    (line) => {
      const after = before.replace("});", `  ${line}\n});`);

      expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([]);
    },
  );

  it.each([
    ["中身を確かめない matcher", "  expect(add(0, 0)).toBeDefined();"],
    ["matcher の無い expect", "  expect(add(0, 0));"],
    ["assert.ok", "  assert.ok(add(0, 0));"],
  ])("値の比較を「%s」に書き換えたら拾う", (_label, line) => {
    // アサーションの数は変わらない。確かめる中身だけが消える。
    const after = before.replace("  expect(add(0, 0)).toBe(0);", line);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it.each([
    ["文字列", '  const note = "expect(add(0, 0)).toBe(0)";'],
    ["テンプレートリテラル", "  const note = `expect(add(0, 0)).toBe(0)`;"],
    ["行末のコメント", "  const sum = add(0, 0); // expect(sum).toBe(0);"],
  ])("%sの中の expect( でアサーションの数を水増しできない", (_label, line) => {
    const after = before.replace("  expect(add(0, 0)).toBe(0);", line);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it.each([
    ["toString", "  expect(add(0, 0).toString());"],
    ["chai の ok", "  expect(add(0, 0)).to.be.ok;"],
  ])("比較を matcher でない %s に書き換えたら拾う", (_label, line) => {
    const after = before.replace("  expect(add(0, 0)).toBe(0);", line);

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([
      "tests/a.test.ts",
    ]);
  });

  it("chai の比較はアサーションとして数える", () => {
    const chai = "test('a', () => {\n  expect(add(1, 2)).to.equal(3);\n});";

    expect(
      weakenedTestFiles([
        { path: "tests/a.test.ts", before: chai, after: chai.replace(".to.equal(3)", ".to.exist") },
      ]),
    ).toEqual(["tests/a.test.ts"]);
  });

  it("Python の三重引用符で囲ったアサーションは数えない", () => {
    const python = "def test_add():\n    assert add(1, 2) == 3\n";
    const after = 'def test_add():\n    """\n    assert add(1, 2) == 3\n    """\n';

    expect(weakenedTestFiles([{ path: "tests/test_a.py", before: python, after }])).toEqual([
      "tests/test_a.py",
    ]);
  });

  it("メソッドの .expect( はアサーションに数えない", () => {
    // Rust の `Result::expect` を `?` に変えても、確かめは減っていない。
    const rust = 'let sum = add(1, 2).expect("adds");\nassert_eq!(sum, 3);\n';

    expect(
      weakenedTestFiles([
        { path: "tests/add.rs", before: rust, after: rust.replace('.expect("adds")', "?") },
      ]),
    ).toEqual([]);
  });

  it("matcher を次の行へ折り返しただけなら拾わない", () => {
    const after = before.replace(
      "  expect(add(0, 0)).toBe(0);",
      "  expect(add(0, 0))\n    .toBe(0);",
    );

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([]);
  });

  it("コメントに書いた定数のアサーションは拾わない", () => {
    const after = before.replace("});", "  // expect(true) では何も確かめない\n});");

    expect(weakenedTestFiles([{ path: "tests/a.test.ts", before, after }])).toEqual([]);
  });

  it("もとからあった行は拾わない", () => {
    const withTautology = `${before}\nexpect(true).toBe(true);`;

    expect(
      weakenedTestFiles([
        { path: "tests/a.test.ts", before: withTautology, after: `${withTautology}\n// more` },
      ]),
    ).toEqual([]);
  });
});
