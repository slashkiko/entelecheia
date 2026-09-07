import { describe, expect, it } from "vitest";
import { type DecideTarget, decide, type LlmPort } from "../src/decide/index.js";
import type { Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";

/**
 * もう1系統のループ検知。
 *
 * `loop_detected` の材料は観測ダイジェストで、Fact をすべて含む。`github.ci.*` や
 * `local.dirty` が揺れるだけで数え直すので、出力が全く同じでも詰まっている Goal を
 * 見逃す。こちらの材料は試行の結果だけで、Fact は1つも入らない。
 *
 * 材料が違うので、どちらか片方が外れてももう片方が残る。停止条件なので、
 * どちらも guard が決める（design.md §7）。
 */

const NOW = new Date("2026-08-09T07:00:00.000Z");

const BUDGET: Budget = {
  max_actor_runs: 10,
  max_reconciles: 20,
  max_wall_clock: "2h",
  max_consecutive_failures: 3,
  max_unchanged_reconciles: 3,
};

const CRITERIA: AcceptanceCriterion[] = [
  { id: "ac-1", description: "ac-1", verification: { type: "command", run: "mise run test" } },
];

const UNMET: Gap = { criterionId: "ac-1", kind: "unmet", detail: "exit_code=1" };

function spyLlm(): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    chooseAction: async (): Promise<unknown> => {
      port.calls += 1;
      return { type: "VERIFY" };
    },
  };
  return port;
}

function target(over: Partial<DecideTarget> = {}): DecideTarget {
  return {
    criteria: CRITERIA,
    facts: [],
    observedFacts: [],
    assessment: { assessedAt: NOW.toISOString(), gaps: [UNMET], satisfied: false },
    unresolved: [],
    // 観測は毎ティック動いている。こちらの系統だけが見る状態にしてある。
    observedDigest: "moving",
    repeatedAttempts: { signature: "same-failure", count: 3 },
    budget: BUDGET,
    usage: {
      actorRuns: 3,
      reconciles: 5,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: "previous", count: 0 },
    },
    ...over,
  };
}

describe("試行の反復", () => {
  it("同じ結果の試行が上限まで続いたら ESCALATE(repeated_attempt)", async () => {
    const llm = spyLlm();
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "repeated_attempt" });
    expect(decision.decidedBy).toBe("guard");
    // 停止条件を LLM に決めさせない（design.md §7）。
    expect(llm.calls).toBe(0);
  });

  it("観測ダイジェストが毎ティック動いていても止まる", async () => {
    // これが `loop_detected` との差そのものになる。`github.ci.*` の揺れで
    // ダイジェストが動いているあいだ、あちらは一度も数え上がらない。
    const decision = await decide(
      target({
        usage: {
          actorRuns: 3,
          reconciles: 5,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "totally-different", count: 0 },
        },
      }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "repeated_attempt" });
  });

  it("上限に届かなければ LLM に委ねる", async () => {
    const llm = spyLlm();
    const decision = await decide(
      target({ repeatedAttempts: { signature: "same-failure", count: 2 } }),
      { llm, now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "VERIFY" });
    expect(llm.calls).toBe(1);
  });

  it("数えられる試行が1件も無ければ止まらない", async () => {
    // 台帳を読む口が無いティックがこれにあたる。数えられないことを
    // 「停滞していない」とも「停滞している」とも読まない。
    const decision = await decide(target({ repeatedAttempts: { signature: null, count: 99 } }), {
      llm: spyLlm(),
      now: () => NOW,
    });

    expect(decision.action).toEqual({ type: "VERIFY" });
  });

  it("Gap が無ければ、試行が同じでも COMPLETE", async () => {
    // 満たしているなら完了でよい。判定の順序は `loop_detected` と揃える。
    const decision = await decide(
      target({ assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true } }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "COMPLETE" });
  });

  it("予算超過のほうが先に止める", async () => {
    const decision = await decide(
      target({
        usage: {
          actorRuns: 10,
          reconciles: 5,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "previous", count: 0 },
        },
      }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
  });

  it("観測が止まっているティックでは loop_detected が先に出る", async () => {
    // 既存の hard budget は動かさない。両方の条件を満たすティックでは、
    // 先に置いてある `loop_detected` の側が出る。
    const decision = await decide(
      target({
        observedDigest: "same",
        usage: {
          actorRuns: 3,
          reconciles: 5,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "same", count: 2 },
        },
      }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "loop_detected" });
  });

  it("rationale に何回続いたかと、残っている Gap を残す", async () => {
    const decision = await decide(target(), { llm: spyLlm(), now: () => NOW });

    expect(decision.rationale).toContain("3/3");
    expect(decision.rationale).toContain("ac-1");
    expect(decision.rationale).toContain("exit_code=1");
  });
});
