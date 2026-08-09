import { describe, expect, it } from "vitest";
import type { Action } from "../src/domain/action.js";
import { type GoalStatus, isTerminal, nextStatus } from "../src/domain/goal-state.js";

describe("goal-state", () => {
  describe("isTerminal", () => {
    it("COMPLETED / FAILED / ABANDONED は終端", () => {
      expect(isTerminal("COMPLETED")).toBe(true);
      expect(isTerminal("FAILED")).toBe(true);
      expect(isTerminal("ABANDONED")).toBe(true);
    });

    it("それ以外は終端ではない", () => {
      const running: GoalStatus[] = [
        "DRAFT",
        "AWAITING_CRITERIA_APPROVAL",
        "ACTIVE",
        "WAITING_HUMAN",
        "WAITING_EXTERNAL",
        "BLOCKED",
      ];
      for (const status of running) {
        expect(isTerminal(status), status).toBe(false);
      }
    });
  });

  describe("nextStatus", () => {
    it("COMPLETE なら COMPLETED", () => {
      expect(nextStatus("ACTIVE", { type: "COMPLETE" })).toBe("COMPLETED");
    });

    it("WAIT(review_pending) なら WAITING_HUMAN", () => {
      const action: Action = { type: "WAIT", reason: "review_pending", resumeAfter: null };
      expect(nextStatus("ACTIVE", action)).toBe("WAITING_HUMAN");
    });

    it("review_pending 以外の WAIT は WAITING_EXTERNAL", () => {
      // 待ちの相手が人間か外部かで、次に何を見に行くかが変わる。
      const reasons = ["ci_running", "usage_limit", "observation_failed"] as const;
      for (const reason of reasons) {
        const action: Action = { type: "WAIT", reason, resumeAfter: null };
        expect(nextStatus("ACTIVE", action), reason).toBe("WAITING_EXTERNAL");
      }
    });

    it("ESCALATE(budget_exhausted) なら BLOCKED", () => {
      expect(nextStatus("ACTIVE", { type: "ESCALATE", reason: "budget_exhausted" })).toBe(
        "BLOCKED",
      );
    });

    it("budget_exhausted 以外の ESCALATE は WAITING_HUMAN", () => {
      // 人間を呼ぶが、上限に達したわけではないので BLOCKED にはしない。
      const reasons = ["loop_detected", "invalid_decision"] as const;
      for (const reason of reasons) {
        expect(nextStatus("ACTIVE", { type: "ESCALATE", reason }), reason).toBe("WAITING_HUMAN");
      }
    });

    it("ACT / VERIFY / REPLAN は ACTIVE のまま", () => {
      const actions: Action[] = [
        { type: "ACT", intent: "直す" },
        { type: "VERIFY" },
        { type: "REPLAN" },
      ];
      for (const action of actions) {
        expect(nextStatus("ACTIVE", action), action.type).toBe("ACTIVE");
      }
    });

    it("待機状態からでも ACTIVE に戻れる", () => {
      // design.md §4.4 の ⇅。CI が終われば次のティックで動き出す。
      expect(nextStatus("WAITING_EXTERNAL", { type: "VERIFY" })).toBe("ACTIVE");
      expect(nextStatus("WAITING_HUMAN", { type: "ACT", intent: "直す" })).toBe("ACTIVE");
      expect(nextStatus("BLOCKED", { type: "VERIFY" })).toBe("ACTIVE");
    });

    it("終端状態からは遷移しない", () => {
      // 完了した Goal を次のティックが動かし続けると、完了判定が意味を失う。
      expect(nextStatus("COMPLETED", { type: "ACT", intent: "直す" })).toBe("COMPLETED");
      expect(nextStatus("FAILED", { type: "VERIFY" })).toBe("FAILED");
      expect(nextStatus("ABANDONED", { type: "COMPLETE" })).toBe("ABANDONED");
    });
  });
});
