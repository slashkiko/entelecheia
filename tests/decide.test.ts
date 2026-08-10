import { describe, expect, it } from "vitest";
import {
  type BudgetUsage,
  type DecideDeps,
  type DecideTarget,
  decide,
  type LlmPort,
} from "../src/decide/index.js";
import { decisionSchema } from "../src/domain/action.js";
import type { Unresolved } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { Assessment, Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");

const BUDGET: Budget = {
  max_actor_runs: 10,
  max_reconciles: 20,
  max_wall_clock: "2h",
  max_consecutive_failures: 3,
  max_unchanged_reconciles: 3,
};

const FRESH: BudgetUsage = {
  actorRuns: 0,
  reconciles: 1,
  consecutiveFailures: 0,
  elapsedSeconds: 60,
  trailingDigest: { digest: null, count: 0 },
};

function commandCriterion(id: string): AcceptanceCriterion {
  return { id, description: id, verification: { type: "command", run: "mise run test" } };
}

function humanCriterion(id: string): AcceptanceCriterion {
  return { id, description: id, verification: { type: "human", prompt: "確認してください" } };
}

function factCriterion(id: string): AcceptanceCriterion {
  return {
    id,
    description: id,
    verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
  };
}

function assessment(gaps: Gap[]): Assessment {
  return { assessedAt: NOW.toISOString(), gaps, satisfied: gaps.length === 0 };
}

/** LLM が呼ばれたら記録する。guard で決まる分岐では呼ばれてはいけない */
function spyLlm(replies: unknown[] = []): LlmPort & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    chooseAction: async (prompt: string) => {
      calls.push(prompt);
      const reply = replies[index];
      index += 1;
      return reply;
    },
  };
}

function target(over: Partial<DecideTarget> = {}): DecideTarget {
  return {
    criteria: [commandCriterion("ac-1")],
    // レビュー役を起動してよいかを見る材料。この fixture では観測が無い。
    facts: [],
    assessment: assessment([]),
    unresolved: [],
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: FRESH,
    ...over,
  };
}

function deps(llm: LlmPort): DecideDeps {
  return { llm, now: () => NOW };
}

const UNMET: Gap = { criterionId: "ac-1", kind: "unmet", detail: "exit_code=1" };

describe("decide", () => {
  describe("guard（LLM を呼ばずに決める）", () => {
    it("Gap も unresolved も無ければ COMPLETE", async () => {
      const llm = spyLlm();
      const decision = await decide(target(), deps(llm));

      expect(decision.action.type).toBe("COMPLETE");
      expect(decision.decidedBy).toBe("guard");
      expect(llm.calls).toEqual([]);
    });

    it("COMPLETE を LLM に決めさせない", async () => {
      // design.md §3.1「完了判定は VERIFIED のみで行う」を推論で迂回させないため。
      const llm = spyLlm([{ type: "ACT", intent: "まだやることがある" }]);
      const decision = await decide(target(), deps(llm));

      expect(decision.action.type).toBe("COMPLETE");
      expect(llm.calls).toEqual([]);
    });

    it("actor 実行回数の上限に達したら ESCALATE", async () => {
      const llm = spyLlm();
      const decision = await decide(
        target({ assessment: assessment([UNMET]), usage: { ...FRESH, actorRuns: 10 } }),
        deps(llm),
      );

      expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
      expect(decision.decidedBy).toBe("guard");
      expect(llm.calls).toEqual([]);
    });

    it("reconcile 回数の上限に達したら ESCALATE", async () => {
      const decision = await decide(
        target({ assessment: assessment([UNMET]), usage: { ...FRESH, reconciles: 20 } }),
        deps(spyLlm()),
      );
      expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
    });

    it("連続失敗の上限に達したら ESCALATE", async () => {
      const decision = await decide(
        target({ assessment: assessment([UNMET]), usage: { ...FRESH, consecutiveFailures: 3 } }),
        deps(spyLlm()),
      );
      expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
    });

    it("経過時間の上限を超えたら ESCALATE", async () => {
      // max_wall_clock: 2h = 7200 秒
      const decision = await decide(
        target({ assessment: assessment([UNMET]), usage: { ...FRESH, elapsedSeconds: 7201 } }),
        deps(spyLlm()),
      );
      expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
    });

    it("予算超過は COMPLETE より優先する", async () => {
      // 満たしていても上限に達していたら、暴走の停止を優先する。
      const decision = await decide(target({ usage: { ...FRESH, actorRuns: 10 } }), deps(spyLlm()));
      expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
    });

    it("Gap は無いが人間の承認待ちが残っていれば WAIT(review_pending)", async () => {
      const unresolved: Unresolved[] = [
        { key: criterionFactKey("ac-6"), reason: "pending", detail: "承認待ち" },
      ];
      const llm = spyLlm();
      const decision = await decide(
        target({ criteria: [humanCriterion("ac-6")], unresolved }),
        deps(llm),
      );

      expect(decision.action).toMatchObject({ type: "WAIT", reason: "review_pending" });
      expect(decision.decidedBy).toBe("guard");
      expect(llm.calls).toEqual([]);
    });

    it("Gap は無いが Fact 参照が未解決なら WAIT(ci_running)", async () => {
      const unresolved: Unresolved[] = [
        { key: criterionFactKey("ac-5"), reason: "pending", detail: "CI の結果がまだ無い" },
      ];
      const decision = await decide(
        target({ criteria: [factCriterion("ac-5")], unresolved }),
        deps(spyLlm()),
      );

      expect(decision.action).toMatchObject({ type: "WAIT", reason: "ci_running" });
    });

    it("観測に失敗していれば WAIT(observation_failed)", async () => {
      // 外部が落ちている可能性があるので、次ティックで再試行する。
      const unresolved: Unresolved[] = [
        { key: "github.pr", reason: "port_failed", detail: "502 Bad Gateway" },
      ];
      const decision = await decide(target({ unresolved }), deps(spyLlm()));

      expect(decision.action).toMatchObject({ type: "WAIT", reason: "observation_failed" });
    });

    it("観測失敗は承認待ちより優先する", async () => {
      // 観測できていない状態で「承認待ち」と決めつけると、状態を取り違える。
      const unresolved: Unresolved[] = [
        { key: criterionFactKey("ac-6"), reason: "pending", detail: "承認待ち" },
        { key: "github.pr", reason: "port_failed", detail: "502 Bad Gateway" },
      ];
      const decision = await decide(
        target({ criteria: [humanCriterion("ac-6")], unresolved }),
        deps(spyLlm()),
      );

      expect(decision.action).toMatchObject({ type: "WAIT", reason: "observation_failed" });
    });
  });

  describe("LLM に委ねる", () => {
    it("Gap があれば LlmPort を呼ぶ", async () => {
      const llm = spyLlm([{ type: "ACT", intent: "テストの失敗を直す" }]);
      const decision = await decide(target({ assessment: assessment([UNMET]) }), deps(llm));

      expect(llm.calls.length).toBe(1);
      expect(decision.action).toEqual({ type: "ACT", intent: "テストの失敗を直す" });
      expect(decision.decidedBy).toBe("llm");
    });

    it("Gap の内容が LLM に渡る", async () => {
      const llm = spyLlm([{ type: "VERIFY" }]);
      await decide(target({ assessment: assessment([UNMET]) }), deps(llm));

      expect(llm.calls[0]).toContain("ac-1");
    });

    it("Zod を通らない出力は受け取らず、再試行する", async () => {
      const llm = spyLlm([{ type: "TELEPORT" }, { type: "VERIFY" }]);
      const decision = await decide(target({ assessment: assessment([UNMET]) }), deps(llm));

      expect(llm.calls.length).toBe(2);
      expect(decision.action).toEqual({ type: "VERIFY" });
    });

    it("再試行しても通らなければ ESCALATE(invalid_decision)", async () => {
      const llm = spyLlm([{ type: "TELEPORT" }, null, "でたらめ"]);
      const decision = await decide(target({ assessment: assessment([UNMET]) }), deps(llm));

      expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
      expect(decision.decidedBy).toBe("guard");
    });

    it("LlmPort が throw しても ESCALATE で返る", async () => {
      const llm: LlmPort = {
        chooseAction: async () => {
          throw new Error("usage limit reached");
        },
      };
      const decision = await decide(target({ assessment: assessment([UNMET]) }), deps(llm));

      expect(decision.action.type).toBe("ESCALATE");
    });
  });

  it("どの経路でも rationale が埋まる", async () => {
    const complete = await decide(target(), deps(spyLlm()));
    expect(complete.rationale.length).toBeGreaterThan(0);

    const acted = await decide(
      target({ assessment: assessment([UNMET]) }),
      deps(spyLlm([{ type: "VERIFY" }])),
    );
    expect(acted.rationale.length).toBeGreaterThan(0);
  });

  it("戻り値が Decision スキーマを通る", async () => {
    const decision = await decide(target(), deps(spyLlm()));
    expect(() => decisionSchema.parse(decision)).not.toThrow();
    expect(decision.decidedAt).toBe(NOW.toISOString());
  });
});
