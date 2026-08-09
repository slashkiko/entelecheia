import { describe, expect, it } from "vitest";
import { type Fact, verifiedOnly, verifyResultSchema } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";
import {
  type ApprovalPort,
  type CommandRunnerPort,
  type VerifyDeps,
  verify,
} from "../src/verify/index.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");

function deps(over: {
  command?: Partial<CommandRunnerPort>;
  approval?: Partial<ApprovalPort>;
}): VerifyDeps {
  return {
    command: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      ...over.command,
    },
    approval: {
      getApproval: async () => null,
      ...over.approval,
    },
    now: () => NOW,
  };
}

function commandCriterion(id: string, run: string): AcceptanceCriterion {
  return { id, description: `${run} が通る`, verification: { type: "command", run } };
}

function factOf(key: string, value: unknown): Fact {
  return {
    key,
    value,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "test", detail: "" },
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

describe("verify", () => {
  it("通った criteria を VERIFIED な Fact にする", async () => {
    const result = await verify(
      { setup: [], criteria: [commandCriterion("ac-1", "mise run test")], facts: [] },
      deps({}),
    );

    const fact = byKey(result.facts, criterionFactKey("ac-1"));
    expect(fact?.value).toBe(true);
    expect(fact?.confidence).toBe("VERIFIED");
    expect(result.unverified).toEqual([]);
  });

  it("落ちた criteria も Fact にする（検証できた結果であるため）", async () => {
    const result = await verify(
      { setup: [], criteria: [commandCriterion("ac-1", "mise run test")], facts: [] },
      deps({ command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "2 failed" }) } }),
    );

    expect(byKey(result.facts, criterionFactKey("ac-1"))?.value).toBe(false);
    expect(result.unverified).toEqual([]);
  });

  it("Fact の evidence に実行したコマンドと終了コードが残る", async () => {
    const result = await verify(
      { setup: [], criteria: [commandCriterion("ac-1", "mise run test")], facts: [] },
      deps({ command: { run: async () => ({ exitCode: 3, stdout: "", stderr: "" }) } }),
    );

    const [fact] = verifiedOnly(result.facts);
    expect(fact?.evidence.source).toContain("mise run test");
    expect(fact?.evidence.detail).toContain("3");
  });

  it("コマンドの起動自体に失敗したら Fact ではなく unverified に積む", async () => {
    // 起動できなかったことを「不合格」にすると、捏造した不合格になる。
    const result = await verify(
      { setup: [], criteria: [commandCriterion("ac-1", "mise run test")], facts: [] },
      deps({
        command: {
          run: async () => {
            throw new Error("ENOENT: mise not found");
          },
        },
      }),
    );

    expect(byKey(result.facts, criterionFactKey("ac-1"))).toBeUndefined();
    const gap = result.unverified.find((u) => u.key === criterionFactKey("ac-1"));
    expect(gap?.reason).toBe("port_failed");
    expect(gap?.detail).toContain("ENOENT");
  });

  it("setup を criteria の前に1度だけ実行する", async () => {
    const calls: string[] = [];
    await verify(
      {
        setup: ["pnpm install --frozen-lockfile"],
        criteria: [
          commandCriterion("ac-1", "mise run test"),
          commandCriterion("ac-2", "mise run lint"),
        ],
        facts: [],
      },
      deps({
        command: {
          run: async (command) => {
            calls.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      }),
    );

    expect(calls).toEqual(["pnpm install --frozen-lockfile", "mise run test", "mise run lint"]);
  });

  it("setup が失敗したら criteria を1件も実行しない", async () => {
    const calls: string[] = [];
    const result = await verify(
      {
        setup: ["pnpm install --frozen-lockfile"],
        criteria: [commandCriterion("ac-1", "mise run test")],
        facts: [],
      },
      deps({
        command: {
          run: async (command) => {
            calls.push(command);
            return { exitCode: 1, stdout: "", stderr: "lockfile mismatch" };
          },
        },
      }),
    );

    expect(calls).toEqual(["pnpm install --frozen-lockfile"]);
    expect(result.facts).toEqual([]);
    expect(result.unverified.find((u) => u.key === criterionFactKey("ac-1"))?.reason).toBe(
      "port_failed",
    );
  });

  it("fact 検証は OBSERVE の Fact と比較する", async () => {
    const criterion: AcceptanceCriterion = {
      id: "ac-5",
      description: "CI が成功している",
      verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
    };

    const passed = await verify(
      { setup: [], criteria: [criterion], facts: [factOf("github.ci.conclusion", "success")] },
      deps({}),
    );
    expect(byKey(passed.facts, criterionFactKey("ac-5"))?.value).toBe(true);

    const failed = await verify(
      { setup: [], criteria: [criterion], facts: [factOf("github.ci.conclusion", "failure")] },
      deps({}),
    );
    expect(byKey(failed.facts, criterionFactKey("ac-5"))?.value).toBe(false);
  });

  it("参照先の Fact が無ければ不合格ではなく pending", async () => {
    const result = await verify(
      {
        setup: [],
        criteria: [
          {
            id: "ac-5",
            description: "CI が成功している",
            verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
          },
        ],
        facts: [],
      },
      deps({}),
    );

    expect(byKey(result.facts, criterionFactKey("ac-5"))).toBeUndefined();
    expect(result.unverified.find((u) => u.key === criterionFactKey("ac-5"))?.reason).toBe(
      "pending",
    );
  });

  it("INFERRED な Fact しか無いキーは完了判定に使わない", async () => {
    // design.md §3.1「Goal を COMPLETED にする判定に INFERRED は使わない」
    const inferred: Fact = {
      key: "github.ci.conclusion",
      value: "success",
      observedAt: NOW.toISOString(),
      confidence: "INFERRED",
    };

    const result = await verify(
      {
        setup: [],
        criteria: [
          {
            id: "ac-5",
            description: "CI が成功している",
            verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
          },
        ],
        facts: [inferred],
      },
      deps({}),
    );

    expect(byKey(result.facts, criterionFactKey("ac-5"))).toBeUndefined();
    expect(result.unverified.find((u) => u.key === criterionFactKey("ac-5"))?.reason).toBe(
      "pending",
    );
  });

  it("human 検証は未承認なら pending", async () => {
    const result = await verify(
      {
        setup: [],
        criteria: [
          {
            id: "ac-6",
            description: "Port が癒着していない",
            verification: { type: "human", prompt: "Port 定義を読んで確認してください" },
          },
        ],
        facts: [],
      },
      deps({}),
    );

    expect(byKey(result.facts, criterionFactKey("ac-6"))).toBeUndefined();
    expect(result.unverified.find((u) => u.key === criterionFactKey("ac-6"))?.reason).toBe(
      "pending",
    );
  });

  it("human 検証は承認されたら承認者を evidence に残す", async () => {
    const result = await verify(
      {
        setup: [],
        criteria: [
          {
            id: "ac-6",
            description: "Port が癒着していない",
            verification: { type: "human", prompt: "Port 定義を読んで確認してください" },
          },
        ],
        facts: [],
      },
      deps({
        approval: {
          getApproval: async () => ({ approvedBy: "pr-author", approvedAt: NOW.toISOString() }),
        },
      }),
    );

    const fact = byKey(result.facts, criterionFactKey("ac-6"));
    expect(fact?.value).toBe(true);
    expect(fact?.confidence).toBe("VERIFIED");
    expect(verifiedOnly(result.facts)[0]?.evidence.detail).toContain("pr-author");
  });

  it("ApprovalPort が落ちたら port_failed。不合格を捏造しない", async () => {
    // GitHub の一時 500 を「検証済み不合格」にすると、assess が unmet を出し、
    // DECIDE が WAIT ではなく ACT を選ぶ。§3.1 が名指しで避けたかった読み違い。
    const result = await verify(
      {
        setup: [],
        criteria: [
          {
            id: "ac-6",
            description: "Port が癒着していない",
            verification: { type: "human", prompt: "確認してください" },
          },
        ],
        facts: [],
      },
      deps({
        approval: {
          getApproval: async () => {
            throw new Error("500 Internal Server Error");
          },
        },
      }),
    );

    expect(result.facts).toHaveLength(0);
    expect(result.unverified).toHaveLength(1);
    expect(result.unverified[0]?.reason).toBe("port_failed");
    expect(result.unverified[0]?.detail).toContain("500");
  });

  it("1件が検証できなくても他の criteria の結果は残る", async () => {
    const result = await verify(
      {
        setup: [],
        criteria: [
          commandCriterion("ac-1", "mise run test"),
          {
            id: "ac-6",
            description: "Port が癒着していない",
            verification: { type: "human", prompt: "確認してください" },
          },
        ],
        facts: [],
      },
      deps({}),
    );

    expect(byKey(result.facts, criterionFactKey("ac-1"))?.value).toBe(true);
    expect(result.unverified.map((u) => u.key)).toEqual([criterionFactKey("ac-6")]);
  });

  it("戻り値が VerifyResult スキーマを通る", async () => {
    const result = await verify(
      { setup: [], criteria: [commandCriterion("ac-1", "mise run test")], facts: [] },
      deps({}),
    );
    expect(() => verifyResultSchema.parse(result)).not.toThrow();
    expect(result.verifiedAt).toBe(NOW.toISOString());
  });
});
