import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorPort, WorktreePort } from "../src/act/index.js";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { LlmPort } from "../src/decide/index.js";
import type { Goal } from "../src/domain/goal.js";
import { openStore, type Store } from "../src/store/index.js";

const NOW = new Date("2026-08-09T05:00:00.000Z");

const GOAL: Goal = {
  version: 1,
  goal: { id: "sample-goal", name: "サンプル", desired_state: "何かが完成している" },
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
  context: { background: "背景", constraints: [], references: [] },
  policies: { require_human_approval: ["merge"] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
  },
};

let store: Store;
/** store と Port の呼ばれた順。write-ahead と回収の順序はここで見る */
let events: string[];

interface Options {
  /** 検証コマンドの終了コード。0 以外なら Gap が残って LLM 経路に入る */
  exitCode?: number;
  prFails?: boolean;
  llm?: LlmPort;
  actorFails?: boolean;
  signal?: AbortSignal;
  owner?: string;
}

function deps(options: Options = {}): ControllerDeps {
  const worktree: WorktreePort = {
    ensure: async (name) => {
      events.push("worktree.ensure");
      return { path: `/tmp/entelecheia/${name}`, branch: `entelecheia/${name}` };
    },
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async () => {
      events.push("actor.run");
      if (options.actorFails === true) {
        throw new Error("claude が起動できない");
      }
      return { exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] };
    },
  };

  return {
    store: recorded(store),
    worktree,
    actor,
    owner: options.owner ?? "worker-a",
    leaseSeconds: 300,
    signal: options.signal,
    code: {
      getPullRequest: async () => {
        events.push("code.getPullRequest");
        if (options.prFails === true) {
          throw new Error("502 Bad Gateway");
        }
        return null;
      },
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => {
        events.push("local.snapshot");
        return { branch: "main", headSha: "a".repeat(40), dirty: false };
      },
    },
    command: {
      run: async () => ({ exitCode: options.exitCode ?? 0, stdout: "", stderr: "" }),
    },
    approval: { getApproval: async () => null },
    llm: options.llm ?? { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

/** 呼び出し順だけを記録する薄い包み。振る舞いは本物のまま */
function recorded(inner: Store): Store {
  return {
    ...inner,
    upsertGoal: (goal) => inner.upsertGoal(goal),
    getState: (id) => inner.getState(id),
    setStatus: (id, status, resumeAfter) => {
      events.push(`store.setStatus:${status}`);
      inner.setStatus(id, status, resumeAfter);
    },
    setObserveTarget: (id, pr, issue) => inner.setObserveTarget(id, pr, issue),
    acquireLease: (id, owner, until) => {
      const got = inner.acquireLease(id, owner, until);
      events.push(`store.acquireLease:${got}`);
      return got;
    },
    releaseLease: (id, owner) => {
      events.push("store.releaseLease");
      inner.releaseLease(id, owner);
    },
    saveSnapshot: (id, snapshot) => {
      events.push("store.saveSnapshot");
      inner.saveSnapshot(id, snapshot);
    },
    latestSnapshot: (id) => inner.latestSnapshot(id),
    saveDecision: (id, digest, decision) => {
      events.push("store.saveDecision");
      inner.saveDecision(id, digest, decision);
    },
    listDecisions: (id) => inner.listDecisions(id),
    startRun: (id, intent) => {
      events.push("store.startRun");
      return inner.startRun(id, intent);
    },
    finishRun: (runId, outcome) => {
      events.push(`store.finishRun:${outcome.status}`);
      inner.finishRun(runId, outcome);
    },
    reclaimOrphanRuns: (id, detail, finishedAt) => {
      const count = inner.reclaimOrphanRuns(id, detail, finishedAt);
      events.push(`store.reclaimOrphanRuns:${count}`);
      return count;
    },
    listRuns: (id) => inner.listRuns(id),
    close: () => inner.close(),
  };
}

beforeEach(() => {
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
  store.setStatus("sample-goal", "ACTIVE", null);
  events = [];
});

afterEach(() => {
  store.close();
});

describe("tick", () => {
  describe("lease", () => {
    it("取れなければ何もせずに return する", async () => {
      // 1 Goal につき reconcile は同時に1つ（design.md §4.5）。
      store.acquireLease("sample-goal", "worker-b", new Date(NOW.getTime() + 60_000));
      const result = await tick(GOAL, deps());

      expect(result.ran).toBe(false);
      expect(events).toEqual(["store.acquireLease:false"]);
    });

    it("取ったら最後に解放する", async () => {
      const result = await tick(GOAL, deps());

      expect(result.ran).toBe(true);
      expect(events.at(-1)).toBe("store.releaseLease");
      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
    });

    it("途中で例外が出ても解放する", async () => {
      // 解放されないと、以後どのワーカーも lease の期限切れまで動けない。
      const llm: LlmPort = {
        chooseAction: async () => {
          throw new Error("使用量上限");
        },
      };
      await tick(GOAL, deps({ exitCode: 1, llm }));

      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
    });
  });

  describe("orphan の回収", () => {
    it("回収を reconcile より先に置く", async () => {
      // 前のプロセスが死んだまま残った Run を新しい観測より先に確定させないと、
      // 同じ Run が二重に数えられる。
      await tick(GOAL, deps());

      const reclaim = events.findIndex((e) => e.startsWith("store.reclaimOrphanRuns"));
      const observe = events.indexOf("local.snapshot");
      expect(reclaim).toBeGreaterThanOrEqual(0);
      expect(reclaim).toBeLessThan(observe);
    });

    it("starting のまま残った Run を interrupted にする", async () => {
      store.startRun("sample-goal", {
        intent: "前のティックの実行",
        actor: "claude-code",
        worktree: "sample-goal",
        attempt: 1,
        startedAt: "2026-08-09T04:00:00.000Z",
      });

      const result = await tick(GOAL, deps());

      expect(result.reclaimed).toBe(1);
      expect(store.listRuns("sample-goal")[0]?.status).toBe("interrupted");
    });
  });

  describe("永続化", () => {
    it("Fact と Decision を書く", async () => {
      const result = await tick(GOAL, deps());

      expect(store.latestSnapshot("sample-goal")?.facts.length).toBeGreaterThan(0);
      expect(store.listDecisions("sample-goal")).toEqual([result.decision]);
    });

    it("結論が出なかった対象も書く", async () => {
      store.setObserveTarget("sample-goal", 12, null);
      await tick(GOAL, deps({ prFails: true }));

      const unresolved = store.latestSnapshot("sample-goal")?.unresolved ?? [];
      expect(unresolved.some((u) => u.reason === "port_failed")).toBe(true);
    });

    it("前ティックの Fact を引き継ぐ", async () => {
      // 古い観測で ASSESS すると、直したはずの Gap が残り続ける。
      await tick(GOAL, deps());
      await tick(GOAL, deps());

      const branch = (store.latestSnapshot("sample-goal")?.facts ?? []).filter(
        (f) => f.key === "local.branch",
      );
      expect(branch.length).toBe(1);
      expect(store.getState("sample-goal")?.reconciles).toBe(2);
    });
  });

  describe("状態遷移", () => {
    it("criteria が通れば COMPLETED になる", async () => {
      const result = await tick(GOAL, deps());

      expect(result.decision?.action.type).toBe("COMPLETE");
      expect(result.status).toBe("COMPLETED");
      expect(store.getState("sample-goal")?.status).toBe("COMPLETED");
    });

    it("観測に失敗したティックは WAITING_EXTERNAL になる", async () => {
      store.setObserveTarget("sample-goal", 12, null);
      const result = await tick(GOAL, deps({ prFails: true }));

      expect(result.decision?.action).toMatchObject({ type: "WAIT" });
      expect(result.status).toBe("WAITING_EXTERNAL");
    });

    it("終端状態の Goal は回さない", async () => {
      // 完了した Goal を動かし続けると、完了判定が意味を失う。
      store.setStatus("sample-goal", "COMPLETED", null);
      const result = await tick(GOAL, deps());

      expect(result.ran).toBe(false);
      expect(events).toEqual([]);
    });
  });

  describe("ACT の実行", () => {
    it("action が ACT のときだけ Actor を起動する", async () => {
      await tick(GOAL, deps());
      expect(events).not.toContain("actor.run");

      events = [];
      const result = await tick(GOAL, deps({ exitCode: 1 }));

      expect(result.decision?.action.type).toBe("ACT");
      expect(events).toContain("actor.run");
      expect(result.run?.status).toBe("completed");
    });

    it("Actor が失敗してもティック全体は失敗しない", async () => {
      const result = await tick(GOAL, deps({ exitCode: 1, actorFails: true }));

      expect(result.ran).toBe(true);
      expect(result.run?.status).toBe("failed");
      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
    });
  });

  describe("中断", () => {
    it("中断されていたら Actor を起動せず lease を解放する", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await tick(GOAL, deps({ exitCode: 1, signal: controller.signal }));

      expect(events).not.toContain("actor.run");
      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
      expect(result.run).toBeNull();
    });
  });
});
