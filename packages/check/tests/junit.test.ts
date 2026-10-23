import { describe, expect, it } from "vitest";
import { parseJUnit } from "../src/junit.js";

describe("JUnit XML の読み取り", () => {
  it("node:test の報告から、入れ子の suite の中の testcase と skip を読む", () => {
    // node:test の junit reporter が実際に書く形。名前の `>` はエスケープされない。
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<testsuites>",
      '  <testsuite name="group" tests="3" skipped="2">',
      '    <testcase name="one" time="0.1" classname="test"/>',
      '    <testcase name="two" time="0.1" classname="test">',
      '      <skipped type="skipped" message="true"/>',
      "    </testcase>",
      '    <testcase name="three &amp; &lt;x>" time="0.1" classname="test">',
      '      <skipped type="todo" message="true"/>',
      "    </testcase>",
      "  </testsuite>",
      '  <testcase name="top" classname="test" failure="boom">',
      '    <failure type="testCodeFailure" message="boom">at &lt;anonymous></failure>',
      "  </testcase>",
      "  <!-- tests 4 -->",
      "</testsuites>",
    ].join("\n");

    expect(parseJUnit(xml)).toEqual([
      { name: "one", skipped: false },
      { name: "two", skipped: true },
      { name: "three & <x>", skipped: true },
      { name: "top", skipped: false },
    ]);
  });

  it("Vitest の報告を読む", () => {
    const xml = [
      '<testsuites name="vitest tests" tests="2" failures="0" errors="0">',
      '  <testsuite name="tests/a.test.ts" tests="2" skipped="1">',
      '    <testcase classname="tests/a.test.ts" name="a &gt; works" time="0.01"></testcase>',
      '    <testcase classname="tests/a.test.ts" name="a &gt; later" time="0">',
      "      <skipped/>",
      "    </testcase>",
      "  </testsuite>",
      "</testsuites>",
    ].join("\n");

    expect(parseJUnit(xml)).toEqual([
      { name: "a > works", skipped: false },
      { name: "a > later", skipped: true },
    ]);
  });

  it("コメントと CDATA の中のタグは数えない", () => {
    // 失敗の本文にテストのコードが載ることがある。その中の `<testcase` で件数を増やさない。
    const xml = [
      "<testsuites>",
      '  <testcase name="real" classname="c">',
      '    <system-out><![CDATA[<testcase name="fake"/>]]></system-out>',
      "  </testcase>",
      '  <!-- <testcase name="commented"/> -->',
      "</testsuites>",
    ].join("\n");

    expect(parseJUnit(xml).map((test) => test.name)).toEqual(["real"]);
  });

  it("壊れた報告からは読めた分だけを返す", () => {
    expect(parseJUnit('<testsuites><testcase name="a" classname="c">')).toEqual([
      { name: "a", skipped: false },
    ]);
    expect(parseJUnit("not xml at all")).toEqual([]);
  });

  it("範囲外の文字参照で止まらない", () => {
    expect(parseJUnit('<testcase name="x&#x110000;" classname="c"/>')).toEqual([
      { name: "x&#x110000;", skipped: false },
    ]);
  });
});
