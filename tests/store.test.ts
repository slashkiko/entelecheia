import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
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

function verifiedFact(key: string, value: unknown): Fact {
  return {
    key,
    value,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "LocalRepoPort.snapshot()", detail: `${key}=${JSON.stringify(value)}` },
  };
}

const RUN_INTENT: RunIntent = {
  intent: "テストの失敗を直す",
  actor: "claude-code",
  worktree: "sample-goal",
  attempt: 1,
  startedAt: NOW.toISOString(),
};

const COMPLETED: RunOutcome = {
  status: "completed",
  finishedAt: NOW.toISOString(),
  exitCode: 0,
  logRef: ".goals/.state/runs/run-1/log.txt",
  tokens: 100,
  artifacts: ["src/foo.ts"],
  detail: null,
};

let store: Store;

beforeEach(() => {
  // :memory: なのでリポジトリにファイルを残さない。
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
});

afterEach(() => {
  store.close();
});

describe("store", () => {
  describe("Goal の登録", () => {
    it("登録した Goal は DRAFT で入る", () => {
      expect(store.getState("sample-goal")?.status).toBe("DRAFT");
    });

    it("未登録の Goal は null", () => {
      expect(store.getState("unknown-goal")).toBeNull();
    });

    it("upsert しても実行時状態を壊さない", () => {
      // 宣言部の編集で ACTIVE が DRAFT に戻ると、進捗が消える。
      store.setStatus("sample-goal", "ACTIVE", null);
      store.upsertGoal({ ...GOAL, goal: { ...GOAL.goal, name: "名前を変えた" } });

      expect(store.getState("sample-goal")?.status).toBe("ACTIVE");
    });

    it("状態と resume_after を書ける", () => {
      const resumeAfter = "2026-08-09T09:00:00.000Z";
      store.setStatus("sample-goal", "WAITING_EXTERNAL", resumeAfter);

      const state = store.getState("sample-goal");
      expect(state?.status).toBe("WAITING_EXTERNAL");
      expect(state?.resumeAfter).toBe(resumeAfter);
    });

    it("観測対象の PR / Issue 番号を持てる", () => {
      // Goal YAML は宣言部だけを持つので、ここが置き場になる。
      store.setObserveTarget("sample-goal", 12, 34);

      const state = store.getState("sample-goal");
      expect(state?.prNumber).toBe(12);
      expect(state?.issueNumber).toBe(34);
    });
  });

  describe("lease", () => {
    // 期限切れの判定に使う時刻も引数で受け取る。store は時刻を作らない。
    const until = new Date(NOW.getTime() + 5 * 60 * 1000);

    it("誰も持っていなければ取れる", () => {
      expect(store.acquireLease("sample-goal", "worker-a", until, NOW)).toBe(true);
      expect(store.getState("sample-goal")?.leaseOwner).toBe("worker-a");
    });

    it("他のワーカーが持っている間は取れない", () => {
      store.acquireLease("sample-goal", "worker-a", until, NOW);
      expect(store.acquireLease("sample-goal", "worker-b", until, NOW)).toBe(false);
    });

    it("同じワーカーは取り直せる", () => {
      store.acquireLease("sample-goal", "worker-a", until, NOW);
      expect(store.acquireLease("sample-goal", "worker-a", until, NOW)).toBe(true);
    });

    it("同じワーカーの取り直しは期限を延ばす", () => {
      // ACT は分単位で走る。延長しないと途中で期限が切れ、cron の次の起動が
      // 同じ Goal を奪って、同じ worktree で2つの ACT が並行する。
      store.acquireLease("sample-goal", "worker-a", until, NOW);
      const later = new Date(NOW.getTime() + 4 * 60 * 1000);
      const extended = new Date(later.getTime() + 5 * 60 * 1000);
      store.acquireLease("sample-goal", "worker-a", extended, later);

      // 元の期限を過ぎた時刻でも、他のワーカーは奪えない。
      const afterOriginal = new Date(NOW.getTime() + 6 * 60 * 1000);
      expect(store.acquireLease("sample-goal", "worker-b", until, afterOriginal)).toBe(false);
    });

    it("期限が切れた lease は奪える", () => {
      // 行ロックではなく期限付きの所有権にすることで、
      // プロセスがクラッシュしても自動で解放される。
      store.acquireLease("sample-goal", "worker-a", new Date(NOW.getTime() - 1000), NOW);
      expect(store.acquireLease("sample-goal", "worker-b", until, NOW)).toBe(true);
    });

    it("解放すれば別のワーカーが取れる", () => {
      store.acquireLease("sample-goal", "worker-a", until, NOW);
      store.releaseLease("sample-goal", "worker-a");

      expect(store.getState("sample-goal")?.leaseOwner).toBeNull();
      expect(store.acquireLease("sample-goal", "worker-b", until, NOW)).toBe(true);
    });

    it("他人の lease は解放できない", () => {
      store.acquireLease("sample-goal", "worker-a", until, NOW);
      store.releaseLease("sample-goal", "worker-b");

      expect(store.getState("sample-goal")?.leaseOwner).toBe("worker-a");
    });
  });

  describe("スナップショット", () => {
    it("Fact が往復する", () => {
      store.saveSnapshot("sample-goal", {
        observedAt: NOW.toISOString(),
        facts: [verifiedFact("local.branch", "main")],
        unresolved: [],
      });

      const snapshot = store.latestSnapshot("sample-goal");
      expect(snapshot?.facts).toEqual([verifiedFact("local.branch", "main")]);
    });

    it("真偽値と配列も型を保って往復する", () => {
      const facts = [
        verifiedFact("local.dirty", false),
        verifiedFact("github.pr.requested_reviewers", ["alice", "bob"]),
      ];
      store.saveSnapshot("sample-goal", {
        observedAt: NOW.toISOString(),
        facts,
        unresolved: [],
      });

      expect(store.latestSnapshot("sample-goal")?.facts).toEqual(facts);
    });

    it("INFERRED な Fact は evidence 無しでも往復する", () => {
      const inferred: Fact = {
        key: "local.branch",
        value: "main",
        observedAt: NOW.toISOString(),
        confidence: "INFERRED",
      };
      store.saveSnapshot("sample-goal", {
        observedAt: NOW.toISOString(),
        facts: [inferred],
        unresolved: [],
      });

      expect(store.latestSnapshot("sample-goal")?.facts).toEqual([inferred]);
    });

    it("結論が出なかった対象を落とさない", () => {
      // ここを落とすと、design.md §3.1 が避けたかった
      // 「Fact の不在に畳まれる」問題が DB 層で再発する。
      const unresolved: Unresolved[] = [
        { key: "github.pr", reason: "port_failed", detail: "502 Bad Gateway" },
      ];
      store.saveSnapshot("sample-goal", {
        observedAt: NOW.toISOString(),
        facts: [],
        unresolved,
      });

      expect(store.latestSnapshot("sample-goal")?.unresolved).toEqual(unresolved);
    });

    it("最新のスナップショットだけを返す", () => {
      store.saveSnapshot("sample-goal", {
        observedAt: "2026-08-09T05:00:00.000Z",
        facts: [verifiedFact("local.branch", "feat/old")],
        unresolved: [],
      });
      store.saveSnapshot("sample-goal", {
        observedAt: "2026-08-09T06:00:00.000Z",
        facts: [verifiedFact("local.branch", "main")],
        unresolved: [],
      });

      const snapshot = store.latestSnapshot("sample-goal");
      expect(snapshot?.facts.length).toBe(1);
      expect(snapshot?.facts[0]?.value).toBe("main");
    });

    it("スナップショットが無ければ null", () => {
      expect(store.latestSnapshot("sample-goal")).toBeNull();
    });

    it("保存するたびに reconcile 回数が進む", () => {
      // BudgetUsage.reconciles の出所になる。
      expect(store.getState("sample-goal")?.reconciles).toBe(0);
      store.saveSnapshot("sample-goal", {
        observedAt: NOW.toISOString(),
        facts: [],
        unresolved: [],
      });
      expect(store.getState("sample-goal")?.reconciles).toBe(1);
    });
  });

  describe("Decision", () => {
    const decision: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "WAIT", reason: "ci_running", resumeAfter: null },
      rationale: "CI の結果を待つ",
      decidedBy: "guard",
    };

    it("往復する", () => {
      store.saveDecision("sample-goal", "digest-1", decision);
      expect(store.listDecisions("sample-goal")).toEqual([decision]);
    });

    it("古い順に並ぶ", () => {
      // 収束したかを見るには並びが要る。
      const later: Decision = { ...decision, action: { type: "COMPLETE" }, rationale: "満たした" };
      store.saveDecision("sample-goal", "digest-1", decision);
      store.saveDecision("sample-goal", "digest-2", later);

      expect(store.listDecisions("sample-goal").map((d) => d.action.type)).toEqual([
        "WAIT",
        "COMPLETE",
      ]);
    });
  });

  describe("Run", () => {
    it("start した Run は starting で残る", () => {
      // 副作用の前に意図を書く（design.md §3.6）。
      const runId = store.startRun("sample-goal", RUN_INTENT);
      const runs = store.listRuns("sample-goal");

      expect(runId.length).toBeGreaterThan(0);
      expect(runs[0]?.status).toBe("starting");
      expect(runs[0]?.intent).toBe(RUN_INTENT.intent);
      expect(runs[0]?.finishedAt).toBeNull();
    });

    it("finish で確定する", () => {
      const runId = store.startRun("sample-goal", RUN_INTENT);
      store.finishRun(runId, COMPLETED);

      const run = store.listRuns("sample-goal")[0];
      expect(run?.status).toBe("completed");
      expect(run?.exitCode).toBe(0);
      expect(run?.tokens).toBe(100);
      expect(run?.artifacts).toEqual(["src/foo.ts"]);
    });

    it("starting のまま残った Run を interrupted で回収する", () => {
      // 任意の瞬間に kill されても、次ティックが orphan として回収する。
      store.startRun("sample-goal", RUN_INTENT);
      const reclaimed = store.reclaimOrphanRuns(
        "sample-goal",
        "前のティックが落ちた",
        NOW.toISOString(),
      );

      expect(reclaimed).toBe(1);
      const run = store.listRuns("sample-goal")[0];
      expect(run?.status).toBe("interrupted");
      expect(run?.detail).toContain("前のティックが落ちた");
    });

    it("確定済みの Run は回収しない", () => {
      const runId = store.startRun("sample-goal", RUN_INTENT);
      store.finishRun(runId, COMPLETED);

      expect(store.reclaimOrphanRuns("sample-goal", "回収", NOW.toISOString())).toBe(0);
      expect(store.listRuns("sample-goal")[0]?.status).toBe("completed");
    });
  });
});
