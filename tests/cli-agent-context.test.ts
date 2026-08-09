import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentContextPayload, parseCommand } from "../src/cli.js";

/**
 * エージェントが CLI を段階的に読み解くための3層（gist 3.2）。
 *
 *   Layer 1  `ent --help`         既にある。人が読む短い説明
 *   Layer 2  `ent agent-context`  CLI の構造を機械可読な JSON で出す
 *   Layer 3  `SKILL.md`           どの順で叩くか、どこで人の承認が要るか
 *
 * Layer 2 は「何が叩けるか」を --help の散文から推測させないためにある。
 * 文言そのものは実装が決めてよいので、ここで固定するのは構造だけにする。
 */

const REPO_ROOT = join(import.meta.dirname, "..");

describe("agent-context サブコマンド", () => {
  it("slug を取らない", () => {
    expect(parseCommand(["agent-context"])).toEqual({ kind: "agent-context" });
  });

  it("余分な引数は error", () => {
    expect(parseCommand(["agent-context", "sample-goal"]).kind).toBe("error");
  });
});

describe("agentContextPayload", () => {
  it("スキーマの版を持つ", () => {
    // 版が無いと、増えたのか壊れたのかを読む側が区別できない。
    expect(agentContextPayload().schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it("叩けるサブコマンドを全て並べる", () => {
    const names = agentContextPayload().commands.map((command) => command.name);

    expect(names).toContain("start");
    expect(names).toContain("run");
    expect(names).toContain("get");
    expect(names).toContain("list");
    expect(names).toContain("agent-context");
  });

  it("叩けない名前を並べない。show は別名としても載せない", () => {
    // agent-context だけを読んで組み立てたコマンドが通らないなら、Layer 2 は
    // --help より当てにならないものになる。show の打ち直し先は、
    // 不明なサブコマンドのエラーが有効値を並べることで伝わる。
    const names = agentContextPayload().commands.flatMap((command) => [
      command.name,
      ...(command.aliases ?? []),
    ]);

    expect(names).not.toContain("show");
  });

  it("データを出すサブコマンドは --json と --limit を申告する", () => {
    const context = agentContextPayload();
    const list = context.commands.find((command) => command.name === "list");
    const get = context.commands.find((command) => command.name === "get");

    for (const command of [list, get]) {
      const flags = command?.flags.map((flag) => flag.name) ?? [];
      expect(flags).toContain("--json");
      expect(flags).toContain("--limit");
    }
  });

  it("引数の型が読める", () => {
    const run = agentContextPayload().commands.find((command) => command.name === "run");
    const pr = run?.flags.find((flag) => flag.name === "--pr");

    expect(pr?.type).toBe("integer");
    expect(run?.args.some((arg) => arg.name === "slug" && arg.required)).toBe(true);
  });

  it("必要な環境変数を並べる", () => {
    const names = agentContextPayload().env.map((variable) => variable.name);

    expect(names).toContain("GITHUB_TOKEN");
    expect(names).toContain("ENT_MODEL");
    expect(names).toContain("ENT_EFFORT");
  });

  it("終了コードの意味を並べる", () => {
    const codes = agentContextPayload().exitCodes.map((exit) => exit.code);

    expect(codes).toContain(0);
    expect(codes).toContain(2);
  });

  it("JSON にできて、コンテキストを食い潰さない大きさに収まる", () => {
    // 説明文のトークン予算（gist 2.5）。読ませる前提のものが長すぎると本末転倒になる。
    const json = JSON.stringify(agentContextPayload());

    expect(json.length).toBeGreaterThan(0);
    expect(json.length).toBeLessThan(8000);
  });
});

describe("SKILL.md（Layer 3）", () => {
  const skill = readFileSync(join(REPO_ROOT, "SKILL.md"), "utf8");

  it("最初に叩くコマンドを書く", () => {
    expect(skill).toContain("ent agent-context");
  });

  it("出力を絞る手段を書く", () => {
    expect(skill).toContain("--json");
    expect(skill).toContain("--limit");
  });

  it("人の承認が要る操作を書く", () => {
    // どこで止まるかを知らないと、承認待ちを失敗と読んで無駄に回す。
    expect(skill).toContain("/ent approve");
  });

  it("常駐しないことを書く。ポーリングを自作させない", () => {
    expect(skill).toContain("ent run");
  });
});
