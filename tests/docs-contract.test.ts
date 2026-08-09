import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentContextPayload } from "../src/cli.js";

/**
 * `agent-context` が出す CLI の構造と、人間・エージェントが読む文書を突き合わせる。
 *
 * 既存の tests/cli-agent-context.test.ts は `toContain` で「載っていること」を
 * 見ている。あれはサブコマンドが**増えた**ときには決して落ちないので、
 * 実装に足したものが文書に載らないまま出荷される経路が空いていた。
 * 実際 `doctor` は、その経路で README にも SKILL.md にも載らないまま出ていた。
 *
 * ここは網羅集合として比べる。片側にしか無いものがあれば落ちる。
 */

const README = new URL("../README.md", import.meta.url).pathname;
const SKILL = new URL("../.claude/skills/ent/SKILL.md", import.meta.url).pathname;

/** 行頭が `ent <サブコマンド>` になっている箇所を拾う */
const INVOCATION = /^ent\s+([a-z][a-z-]*)/gm;
/** SKILL.md の終了コード表の行 */
const EXIT_ROW = /^\|\s*(\d+)\s*\|/gm;

function documentedCommands(file: string): string[] {
  const found = [...readFileSync(file, "utf8").matchAll(INVOCATION)].map(
    (matched) => matched[1] ?? "",
  );
  return [...new Set(found)].sort();
}

function implementedCommands(): string[] {
  return [...agentContextPayload().commands.map((command) => command.name)].sort();
}

describe("文書と CLI の突き合わせ", () => {
  it("README.md が全サブコマンドを漏れなく載せている", () => {
    expect(documentedCommands(README)).toEqual(implementedCommands());
  });

  it("SKILL.md が全サブコマンドを漏れなく載せている", () => {
    expect(documentedCommands(SKILL)).toEqual(implementedCommands());
  });

  it("SKILL.md の終了コード表が agent-context と一致する", () => {
    // 現状のテストは 0 と 2 しか見ておらず、実装と食い違っている 1 を
    // 誰も確かめていなかった。表の側も網羅で比べる。
    const documented = [...readFileSync(SKILL, "utf8").matchAll(EXIT_ROW)]
      .map((matched) => Number(matched[1]))
      .sort();
    const implemented = agentContextPayload()
      .exitCodes.map((entry) => entry.code)
      .sort();

    expect(documented).toEqual(implemented);
  });
});
