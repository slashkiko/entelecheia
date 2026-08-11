import { describe, expect, it, vi } from "vitest";
import { act, type ActorPort } from "../src/act/index.js";
import { actionSchema } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import { openStore } from "../src/store/sqlite.js";
import { agentSelectionFrom, type AgentFactories, tickPorts } from "../src/wiring/index.js";

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "routing",
    name: "配線",
    desired_state: "phase ごとに provider が選ばれる",
    depends_on: [],
  },
  repository: { provider: "github", owner: "o", name: "r", default_branch: "main" },
  setup: [],
  acceptance_criteria: [],
  context: { background: "", constraints: [], references: [] },
  policies: { require_human_approval: [], protected_paths: [] },
  budget: {
    max_actor_runs: 2,
    max_reconciles: 2,
    max_wall_clock: "1h",
    max_consecutive_failures: 2,
    max_unchanged_reconciles: 2,
  },
};

describe("phase ごとの Agent 選択", () => {
  it("phase 指定が無ければ既存の共通指定へ落ちる", () => {
    const env = { ENT_ACTOR: "codex", ENT_MODEL: "global-model", ENT_EFFORT: "high" };

    expect(agentSelectionFrom(env, "decide")).toEqual({
      actor: "codex",
      model: "global-model",
      effort: "high",
    });
    expect(agentSelectionFrom(env, "review")).toEqual({
      actor: "codex",
      model: "global-model",
      effort: "high",
    });
  });

  it("provider・model・effortをphaseごとに独立して上書きする", () => {
    const env = {
      ENT_ACTOR: "claude-code",
      ENT_MODEL: "global-model",
      ENT_EFFORT: "medium",
      ENT_DECIDE_ACTOR: "codex",
      ENT_DECIDE_MODEL: "decide-model",
      ENT_REVIEW_MODEL: "review-model",
      ENT_REVIEW_EFFORT: "xhigh",
    };

    expect(agentSelectionFrom(env, "decide")).toEqual({
      actor: "codex",
      model: "decide-model",
      effort: "medium",
    });
    expect(agentSelectionFrom(env, "implement")).toEqual({
      actor: "claude-code",
      model: "global-model",
      effort: "medium",
    });
    expect(agentSelectionFrom(env, "review")).toEqual({
      actor: "claude-code",
      model: "review-model",
      effort: "xhigh",
    });
  });

  it("phase固有の不正値を、その環境変数名付きで拒否する", () => {
    expect(() => agentSelectionFrom({ ENT_REVIEW_ACTOR: "unknown" }, "review")).toThrow(
      /ENT_REVIEW_ACTOR/,
    );
    expect(() => agentSelectionFrom({ ENT_DECIDE_EFFORT: "infinite" }, "decide")).toThrow(
      /ENT_DECIDE_EFFORT/,
    );
  });

  it("共通指定の不正値は共通の環境変数名で報告する", () => {
    expect(() => agentSelectionFrom({ ENT_ACTOR: "unknown" }, "review")).toThrow(/ENT_ACTOR/);
    expect(() => agentSelectionFrom({ ENT_EFFORT: "infinite" }, "decide")).toThrow(/ENT_EFFORT/);
  });

  it("Codex の none / minimal を受け付け、未定義の max を拒否する", () => {
    expect(agentSelectionFrom({ ENT_ACTOR: "codex", ENT_EFFORT: "none" }, "decide").effort).toBe(
      "none",
    );
    expect(
      agentSelectionFrom({ ENT_ACTOR: "codex", ENT_EFFORT: "minimal" }, "implement").effort,
    ).toBe("minimal");
    expect(() => agentSelectionFrom({ ENT_ACTOR: "codex", ENT_EFFORT: "max" }, "decide")).toThrow(
      /ENT_EFFORT/,
    );
    expect(
      agentSelectionFrom({ ENT_ACTOR: "claude-code", ENT_EFFORT: "max" }, "decide").effort,
    ).toBe("max");
  });

  it("tickPorts の router が DECIDE と実際の Run を phase 指定へ送る", async () => {
    const store = openStore(":memory:");
    store.upsertGoal(GOAL);
    const actorCalls: { kind: string; role: string }[] = [];
    const actor = (kind: "claude-code" | "codex"): ActorPort => ({
      kind,
      run: async (invocation) => {
        actorCalls.push({ kind, role: invocation.role });
        return { exitCode: 0, logRef: `${kind}.jsonl`, tokens: 1, artifacts: [] };
      },
    });
    const factories: AgentFactories = {
      claudeActor: vi.fn(() => actor("claude-code")),
      codexActor: vi.fn(() => actor("codex")),
      claudeLlm: vi.fn(() => ({ chooseAction: async () => ({ type: "REPLAN" }) })),
      codexLlm: vi.fn((options) => ({
        chooseAction: async () => {
          options.onCall?.({
            purpose: "decide",
            tokens: 7,
            logRef: "decide.jsonl",
            ok: true,
            calledAt: "2026-08-11T00:00:00.000Z",
          });
          return { type: "ACT", intent: "レビューする", role: "review" };
        },
      })),
    };

    try {
      const ports = tickPorts(GOAL, store, "/repo", "/state", {
        env: {
          GITHUB_TOKEN: "",
          ENT_DECIDE_ACTOR: "codex",
          ENT_IMPLEMENT_ACTOR: "claude-code",
          ENT_REVIEW_ACTOR: "codex",
        },
        agentFactories: factories,
      });
      const action = actionSchema.parse(await ports.llm.chooseAction("次を決める"));
      const result = await act(
        {
          goal: GOAL,
          decision: {
            decidedAt: "2026-08-11T00:00:00.000Z",
            action,
            rationale: "レビューが必要",
            decidedBy: "llm",
          },
          attempt: 1,
        },
        {
          actor: ports.actor,
          worktree: {
            ensure: async () => ({ path: "/worktree", branch: "entelecheia/routing" }),
            commit: async () => true,
            changedPaths: async () => [],
            repoDirtyState: async () => new Map(),
          },
          runs: {
            start: async (intent) => store.startRun(GOAL.goal.id, intent),
            finish: async (id, outcome) => store.finishRun(id, outcome),
          },
          now: () => new Date("2026-08-11T00:00:00.000Z"),
        },
      );

      expect(factories.codexLlm).toHaveBeenCalledTimes(1);
      expect(actorCalls).toEqual([{ kind: "codex", role: "review" }]);
      expect(result.acted && result.run.actor).toBe("codex");
      expect(store.listLlmCalls(GOAL.goal.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
