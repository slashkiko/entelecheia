import { describe, expect, it } from "vitest";
import type { LlmPort } from "../src/decide/index.js";
import type { Fact } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { Goal } from "../src/domain/goal.js";
import { type ReconcileDeps, type ReconcileTarget, reconcile } from "../src/reconcile/index.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプル",
    desired_state: "何かが完成している",
  },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [
    {
      id: "ac-1",
      description: "テストが通る",
      verification: { type: "command", run: "mise run test" },
    },
  ],
  context: { background: "背景", constraints: ["何かをしない"], references: [] },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const llm: LlmPort = { chooseAction: async () => ({ type: "VERIFY" }) };
  return {
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    llm,
    now: () => NOW,
    ...over,
  };
}

function target(over: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    goal: GOAL,
    observe: { prNumber: null, issueNumber: null },
    carriedFacts: [],
    usage: {
      actorRuns: 0,
      reconciles: 1,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: null, count: 0 },
    },
    ...over,
  };
}

describe("reconcile", () => {
  it("1ティックで観測・検証・評価・決定まで回して Decision を返す", async () => {
    const result = await reconcile(target(), deps());

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.assessment.assessedAt).toBe(NOW.toISOString());
    expect(result.decision.decidedAt).toBe(NOW.toISOString());
  });

  it("criteria が通れば satisfied になり COMPLETE を選ぶ", async () => {
    const result = await reconcile(target(), deps());

    expect(result.assessment.satisfied).toBe(true);
    expect(result.decision.action.type).toBe("COMPLETE");
  });

  it("criteria が落ちれば Gap が残り COMPLETE にはならない", async () => {
    const result = await reconcile(
      target(),
      deps({ command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "failed" }) } }),
    );

    expect(result.assessment.satisfied).toBe(false);
    expect(result.decision.action.type).not.toBe("COMPLETE");
  });

  it("Port が落ちてもティック全体は失敗せず、unresolved に残る", async () => {
    const result = await reconcile(
      target({ observe: { prNumber: 12, issueNumber: null } }),
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
      }),
    );

    expect(result.unresolved.some((u) => u.reason === "port_failed")).toBe(true);
    // ローカルの観測は残る
    expect(result.facts.some((f) => f.key === "local.branch")).toBe(true);
  });

  it("観測できなかったティックは COMPLETE にしない", async () => {
    // 観測できていない状態で完了と判定すると、捏造した完了になる。
    const result = await reconcile(
      target({ observe: { prNumber: 12, issueNumber: null } }),
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
      }),
    );

    expect(result.decision.action.type).not.toBe("COMPLETE");
  });

  it("前ティックの Fact を引き継ぎ、同じキーは新しい観測で上書きする", async () => {
    // 古い観測で ASSESS すると、直したはずの Gap が残り続ける。
    const stale: Fact = {
      key: "local.branch",
      value: "feat/old",
      observedAt: "2026-08-09T02:00:00.000Z",
      confidence: "VERIFIED",
      evidence: { source: "LocalRepoPort.snapshot()", detail: "branch=feat/old" },
    };

    const result = await reconcile(target({ carriedFacts: [stale] }), deps());

    const branch = result.facts.filter((f) => f.key === "local.branch");
    expect(branch.length).toBe(1);
    expect(branch[0]?.value).toBe("main");
  });

  it("前ティックにしか無いキーは残る", async () => {
    const carried: Fact = {
      key: criterionFactKey("ac-9"),
      value: true,
      observedAt: "2026-08-09T02:00:00.000Z",
      confidence: "VERIFIED",
      evidence: { source: "mise run test", detail: "exit_code=0" },
    };

    const result = await reconcile(target({ carriedFacts: [carried] }), deps());
    expect(result.facts.some((f) => f.key === criterionFactKey("ac-9"))).toBe(true);
  });

  it("同じ入力からは同じ Decision が出る", async () => {
    // これが崩れるとループが収束したかを判定できない。
    const first = await reconcile(target(), deps());
    const second = await reconcile(target(), deps());

    expect(second.decision).toEqual(first.decision);
  });

  it("待つときも sleep せず、WAIT を返して即座に return する", async () => {
    const started = Date.now();
    const result = await reconcile(
      target({ observe: { prNumber: 12, issueNumber: null } }),
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
      }),
    );

    expect(result.decision.action.type).toBe("WAIT");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("予算を使い切ったティックは ESCALATE で返る", async () => {
    const result = await reconcile(
      target({
        usage: {
          actorRuns: 10,
          reconciles: 1,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: null, count: 0 },
        },
      }),
      deps(),
    );

    expect(result.decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
  });
});
