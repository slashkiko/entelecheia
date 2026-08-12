import { describe, expect, it } from "vitest";
import { type DecideTarget, decide, type LlmPort } from "../src/decide/index.js";
import type { Unresolved } from "../src/domain/fact.js";
import type { Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";

/**
 * 空回りの検知。design.md §7 の「同じギャップが N 回連続で解消されなければ
 * ESCALATE」で、§10-2 が未決として残していた N を budget に足した。
 *
 * 材料は `Decision.observed_digest`。Phase 3 の1本目で2ティック続けて
 * 完全に一致することを実測したので、Gap を別に永続化しなくてよい。
 *
 * 停止条件なので guard が決める。LLM 側の口は1本目で閉じてある。
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

/** LLM が呼ばれたら記録する。guard で決まる分岐では呼ばれてはいけない */
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
    // レビュー役と WAIT を選択肢に載せてよいかを見る材料。この fixture では観測が無い。
    facts: [],
    // 今ティックの観測。`facts` と同じにしておく（この fixture では両方空）
    observedFacts: [],
    assessment: { assessedAt: NOW.toISOString(), gaps: [UNMET], satisfied: false },
    unresolved: [],
    observedDigest: "same",
    budget: BUDGET,
    usage: {
      actorRuns: 0,
      reconciles: 5,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: "same", count: 2 },
    },
    ...over,
  };
}

describe("ループ検知", () => {
  it("同じ観測が上限まで続いたら ESCALATE(loop_detected)", async () => {
    // 直近2回 + 今回で3回。max_unchanged_reconciles が 3 なので到達する。
    const llm = spyLlm();
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "loop_detected" });
    expect(decision.decidedBy).toBe("guard");
    // 停止条件を LLM に決めさせない（design.md §7）。
    expect(llm.calls).toBe(0);
  });

  it("上限に届かなければ LLM に委ねる", async () => {
    const llm = spyLlm();
    const decision = await decide(
      target({
        usage: {
          actorRuns: 0,
          reconciles: 5,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "same", count: 1 },
        },
      }),
      { llm, now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "VERIFY" });
    expect(llm.calls).toBe(1);
  });

  it("今回の観測が変わっていれば数え直す", async () => {
    // 「直近3回は同じだったが今回は変わった」を空回りと読むと、進んだ直後に止める。
    const llm = spyLlm();
    const decision = await decide(
      target({
        observedDigest: "changed",
        usage: {
          actorRuns: 0,
          reconciles: 9,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "same", count: 8 },
        },
      }),
      { llm, now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "VERIFY" });
  });

  it("初回のティックでは止まらない", async () => {
    const llm = spyLlm();
    const decision = await decide(
      target({
        usage: {
          actorRuns: 0,
          reconciles: 0,
          consecutiveFailures: 0,
          elapsedSeconds: 0,
          trailingDigest: { digest: null, count: 0 },
        },
      }),
      { llm, now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "VERIFY" });
  });

  it("予算超過はループ検知より優先する", async () => {
    // 予算超過は他のどの状態よりも優先する。
    const decision = await decide(
      target({
        usage: {
          actorRuns: 10,
          reconciles: 5,
          consecutiveFailures: 0,
          elapsedSeconds: 60,
          trailingDigest: { digest: "same", count: 8 },
        },
      }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
  });

  it("Gap が無ければ空回りしていても COMPLETE", async () => {
    // 満たしているなら完了でよい。同じ観測が続くのは当たり前になる。
    const decision = await decide(
      target({ assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true } }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toEqual({ type: "COMPLETE" });
  });

  it("Gap が無く unresolved がある場合も WAIT のまま", async () => {
    // 人間の承認を待っているあいだは観測が変わらない。ここで止めると承認できない。
    const unresolved: Unresolved[] = [
      { key: "criteria.ac-1.passed", reason: "pending", detail: "承認待ち" },
    ];
    const decision = await decide(
      target({
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: false },
        unresolved,
      }),
      { llm: spyLlm(), now: () => NOW },
    );

    expect(decision.action).toMatchObject({ type: "WAIT" });
  });

  it("rationale に何回続いたかを残す", async () => {
    const decision = await decide(target(), { llm: spyLlm(), now: () => NOW });

    expect(decision.rationale).toContain("3/3");
  });
});
