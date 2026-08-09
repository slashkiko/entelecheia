import { describe, expect, it } from "vitest";
import { decide, type LlmPort } from "../src/decide/index.js";
import type { Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * 1本目の Goal で決めた guard に4つ目を足す。
 *
 * design.md §4.4 には WAITING_EXTERNAL(usage_limit) があるのに、DECIDE から
 * そこへ到達する経路が実装に無かった（§10-3）。LlmPort が使用量上限を
 * 名指しで投げてきたときだけ、guard が WAIT(usage_limit) を返す。
 */

const NOW = new Date("2026-08-09T03:00:00.000Z");

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

function target() {
  return {
    criteria: CRITERIA,
    assessment: { assessedAt: NOW.toISOString(), gaps: [UNMET], satisfied: false },
    unresolved: [],
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: {
      actorRuns: 0,
      reconciles: 1,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: null, count: 0 },
    },
  };
}

function throwing(error: unknown): LlmPort {
  return {
    chooseAction: async () => {
      throw error;
    },
  };
}

describe("decide と使用量上限", () => {
  it("LlmPort が使用量上限を投げたら WAIT(usage_limit)", async () => {
    const resumeAfter = "2026-08-09T08:00:00.000Z";
    const decision = await decide(target(), {
      llm: throwing(new PortError("usage_limit", "5時間の上限", resumeAfter)),
      now: () => NOW,
    });

    expect(decision.action).toEqual({ type: "WAIT", reason: "usage_limit", resumeAfter });
    // 判断したのは LLM ではなく guard。暴走の停止条件と同じ扱いにする。
    expect(decision.decidedBy).toBe("guard");
  });

  it("リセット時刻が分からなければ resumeAfter は null", async () => {
    // 指数バックオフに任せる。分からない時刻を捏造しない。
    const decision = await decide(target(), {
      llm: throwing(new PortError("usage_limit", "上限に達した")),
      now: () => NOW,
    });

    expect(decision.action).toEqual({ type: "WAIT", reason: "usage_limit", resumeAfter: null });
  });

  it("上限以外の失敗はこれまでどおり ESCALATE", async () => {
    // 待っても直るとは限らないので、人間を呼ぶ側に倒す。
    const decision = await decide(target(), {
      llm: throwing(new PortError("unavailable", "502 Bad Gateway")),
      now: () => NOW,
    });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
  });

  it("使用量上限は再試行しない", async () => {
    // 上限に当たっている間は何度呼んでも同じなので、回数を消費しない。
    let calls = 0;
    const llm: LlmPort = {
      chooseAction: async () => {
        calls += 1;
        throw new PortError("usage_limit", "上限に達した");
      },
    };
    await decide(target(), { llm, now: () => NOW });

    expect(calls).toBe(1);
  });

  it("Gap が無ければ LlmPort を呼ばないので上限にも当たらない", async () => {
    const decision = await decide(
      {
        ...target(),
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true },
      },
      { llm: throwing(new PortError("usage_limit", "上限")), now: () => NOW },
    );

    expect(decision.action.type).toBe("COMPLETE");
  });
});
