import { describe, expect, it } from "vitest";
import { type DecideTarget, decide, type LlmPort } from "../src/decide/index.js";
import type { Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * LLM に委ねる範囲の境界。
 *
 * 1本目の Goal では COMPLETE だけを弾いていたが、初めて ent run を全周させたとき、
 * reconcile の2回目で LLM が ESCALATE(loop_detected) を返してそのまま採用された。
 * ループしていないのに停止判断が通る。design.md §7 の「暴走の停止条件を
 * LLM の判断に依存させない」からすると、ESCALATE も guard 側に置く。
 *
 * guard から loop_detected を出す実装はまだ無い（§10-2）。ここで閉じるのは
 * LLM 側の口だけになる。
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

function target(): DecideTarget {
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

function spyLlm(replies: unknown[]): LlmPort & { calls: number } {
  let index = 0;
  const port = {
    calls: 0,
    chooseAction: async (): Promise<unknown> => {
      port.calls += 1;
      const reply = replies[index];
      index += 1;
      return reply;
    },
  };
  return port;
}

function throwingLlm(error: unknown): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    chooseAction: async (): Promise<unknown> => {
      port.calls += 1;
      throw error;
    },
  };
  return port;
}

describe("LLM が選べる行動", () => {
  it("ESCALATE(loop_detected) は受け取らない", async () => {
    const llm = spyLlm([{ type: "ESCALATE", reason: "loop_detected" }, { type: "VERIFY" }]);
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "VERIFY" });
    // 弾いたうえで再試行する。1回で諦めると LLM の言い直しの機会を奪う。
    expect(llm.calls).toBe(2);
  });

  it("ESCALATE(budget_exhausted) も受け取らない", async () => {
    // 予算判定は guard が持つ。推論で停止条件を作らせない。
    const llm = spyLlm([{ type: "ESCALATE", reason: "budget_exhausted" }, { type: "REPLAN" }]);
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "REPLAN" });
  });

  it("ESCALATE しか返さなければ ESCALATE(invalid_decision) になる", async () => {
    const llm = spyLlm([
      { type: "ESCALATE", reason: "loop_detected" },
      { type: "ESCALATE", reason: "loop_detected" },
      { type: "ESCALATE", reason: "loop_detected" },
    ]);
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    // 判断したのは LLM ではなく guard。
    expect(decision.decidedBy).toBe("guard");
  });

  it("ACT / VERIFY / WAIT / REPLAN は受け取る", async () => {
    const actions = [
      { type: "ACT", intent: "テストの失敗を直す" },
      { type: "VERIFY" },
      { type: "WAIT", reason: "review_pending", resumeAfter: null },
      { type: "REPLAN" },
    ];

    for (const action of actions) {
      const decision = await decide(target(), { llm: spyLlm([action]), now: () => NOW });
      expect(decision.action).toEqual(action);
      expect(decision.decidedBy).toBe("llm");
    }
  });

  it("WAIT の resumeAfter は省略できる", async () => {
    // LLM は {"type":"WAIT","reason":"review_pending"} を返してきた。必須にしていた
    // せいで弾かれ、再試行に3万トークン以上かかった。省略と null で分岐は変わらない。
    const llm = spyLlm([{ type: "WAIT", reason: "review_pending" }]);
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "WAIT", reason: "review_pending", resumeAfter: null });
    expect(llm.calls).toBe(1);
  });

  it("プロンプトに ESCALATE を選択肢として出さない", async () => {
    let prompt = "";
    const llm: LlmPort = {
      chooseAction: async (given: string) => {
        prompt = given;
        return { type: "VERIFY" };
      },
    };
    await decide(target(), { llm, now: () => NOW });

    // 選択肢として並べない。選べないことは明示する。
    expect(prompt).not.toContain('"type":"ESCALATE"');
    expect(prompt).toContain("ESCALATE は選べない");
    // 人間を待ちたいときの逃げ道は残す。
    expect(prompt).toContain("review_pending");
  });
});

describe("直らない失敗を繰り返さない", () => {
  it("PortError(unavailable) は再試行せずに ESCALATE", async () => {
    // 未ログイン・認証切れ・モデル名の誤りはここに来る。呼び直しても同じ結果になる。
    // 実際、初回の全周では「Not logged in」を3回とも呼び直した。
    const llm = throwingLlm(new PortError("unavailable", "Not logged in"));
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    expect(decision.decidedBy).toBe("guard");
    expect(llm.calls).toBe(1);
    expect(decision.rationale).toContain("Not logged in");
  });

  it("素の Error はこれまでどおり再試行する", () => {
    // Port が落ちたのか出力が壊れたのかを区別できない失敗は、回数制限に載せる。
    const llm = throwingLlm(new Error("socket hang up"));

    return decide(target(), { llm, now: () => NOW }).then((decision) => {
      expect(llm.calls).toBe(3);
      expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    });
  });

  it("usage_limit は再試行せず WAIT のまま", async () => {
    // 既存の guard を壊していないことを確かめる。
    const resumeAfter = "2026-08-09T08:00:00.000Z";
    const llm = throwingLlm(new PortError("usage_limit", "5時間の上限", resumeAfter));
    const decision = await decide(target(), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "WAIT", reason: "usage_limit", resumeAfter });
    expect(llm.calls).toBe(1);
  });
});
