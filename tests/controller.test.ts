import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
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
  /** Actor が長引く状況を作る。解決するまで ACT が返らない */
  actorGate?: Promise<void>;
  leaseSeconds?: number;
}

function deps(options: Options = {}): ControllerDeps {
  const worktree: WorktreePort = {
    ensure: async (name) => {
      events.push("worktree.ensure");
      return { path: `/tmp/entelecheia/${name}`, branch: `entelecheia/${name}` };
    },
    changedPaths: async () => [],
    repoDirtyState: async () => new Map(),
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async () => {
      events.push("actor.run");
      if (options.actorFails === true) {
        throw new Error("claude が起動できない");
      }
      await options.actorGate;
      return { exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] };
    },
  };

  return {
    store: recorded(store),
    worktree,
    actor,
    owner: options.owner ?? "worker-a",
    leaseSeconds: options.leaseSeconds ?? 300,
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
    // PR の確保と通知（design.md §9）。既定は「差分が無い」ので何も起きない。
    // 通知そのものの仕様は tests/publish.test.ts が持つ。
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => {
        events.push("writer.createPullRequest");
        return 1;
      },
      addComment: async () => {
        events.push("writer.addComment");
      },
    },
    branch: {
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: false }),
    },
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
    acquireLease: (id, owner, until, now) => {
      const got = inner.acquireLease(id, owner, until, now);
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
      store.acquireLease("sample-goal", "worker-b", new Date(NOW.getTime() + 60_000), NOW);
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

    it("ティックが長引くあいだ lease を延長し続ける", async () => {
      // ACT は Claude Code の実行なので分単位。design.md §9 の実測では
      // 1ティック目が 1,341,349 tokens だった。延長しないと ACT の途中で
      // 期限が切れ、cron 構成では別プロセスが同じ worktree で ACT を始める。
      vi.useFakeTimers();
      try {
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const promise = tick(GOAL, deps({ exitCode: 1, actorGate: gate, leaseSeconds: 300 }));

        // leaseSeconds / 2 = 150 秒ごと。2回分進める。
        await vi.advanceTimersByTimeAsync(320_000);
        const during = events.filter((e) => e === "store.acquireLease:true").length;
        expect(during).toBeGreaterThanOrEqual(3);

        release();
        await promise;

        // ティックが終わればタイマーも止める。残すとプロセスが落ちない。
        const after = events.filter((e) => e === "store.acquireLease:true").length;
        await vi.advanceTimersByTimeAsync(320_000);
        expect(events.filter((e) => e === "store.acquireLease:true").length).toBe(after);
      } finally {
        vi.useRealTimers();
      }
    });

    it("延長が落ちてもティックを巻き込まない", async () => {
      // タイマーのコールバックから throw すると try/finally の外なので、
      // clearInterval も releaseLease も走らないままプロセスが落ちる。
      // lease は期限まで残り、どのワーカーもその Goal を進められなくなる。
      vi.useFakeTimers();
      try {
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const base = deps({ exitCode: 1, actorGate: gate, leaseSeconds: 300 });
        let first = true;
        const failing: ControllerDeps = {
          ...base,
          store: {
            ...base.store,
            acquireLease: (id, owner, until, now) => {
              if (first) {
                first = false;
                return base.store.acquireLease(id, owner, until, now);
              }
              throw new Error("DB が読めない");
            },
          },
        };

        const promise = tick(GOAL, failing);
        await vi.advanceTimersByTimeAsync(320_000);
        release();

        await expect(promise).resolves.toMatchObject({ ran: true });
        expect(events).toContain("store.releaseLease");
      } finally {
        vi.useRealTimers();
      }
    });

    it("LlmPort が落ちても解放する", async () => {
      // decide が握って ESCALATE に変えるので、tick 自体は例外にならない。
      const llm: LlmPort = {
        chooseAction: async () => {
          throw new Error("使用量上限");
        },
      };
      await tick(GOAL, deps({ exitCode: 1, llm }));

      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
    });

    it("tick が例外で抜けても解放する", async () => {
      // 解放されないと、以後どのワーカーも lease の期限切れまで動けない。
      // LlmPort の失敗は decide が吸収するので、この経路は tick に例外を
      // 伝播させないと通らない。releaseLease を finally から happy path へ
      // 移す変更が緑のまま通っていたのはそのため。
      const broken = deps();
      const store2 = broken.store;
      const failing: Store = {
        ...store2,
        saveSnapshot: () => {
          throw new Error("DB が落ちた");
        },
      };

      await expect(tick(GOAL, { ...broken, store: failing })).rejects.toThrow("DB が落ちた");
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
        role: "implement",
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
      // criteria が通ると1ティック目で COMPLETED になるので、Gap を残して2回回す。
      await tick(GOAL, deps({ exitCode: 1 }));
      await tick(GOAL, deps({ exitCode: 1 }));

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
    it("criteria が通っていれば Actor を起動しない", async () => {
      const result = await tick(GOAL, deps());

      expect(result.decision?.action.type).toBe("COMPLETE");
      expect(events).not.toContain("actor.run");
      expect(result.run).toBeNull();
    });

    it("Gap があれば Actor を起動する", async () => {
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
