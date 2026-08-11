import { describe, expect, it } from "vitest";
import {
  type ActDeps,
  type ActorInvocation,
  type ActorPort,
  type ActorResult,
  type ActTarget,
  act,
  type RunRecorderPort,
  type WorktreePort,
} from "../src/act/index.js";
import type { Action, Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import { type RunIntent, type RunOutcome, runSchema } from "../src/domain/run.js";

const NOW = new Date("2026-08-09T04:00:00.000Z");

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプル",
    desired_state: "何かが完成している",
    depends_on: [],
  },
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
  policies: { require_human_approval: ["merge", "force_push"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

const SUCCESS: ActorResult = {
  exitCode: 0,
  logRef: ".goals/.state/runs/run-1/log.txt",
  tokens: 12_345,
  artifacts: ["src/foo.ts"],
};

function decision(action: Action): Decision {
  return { decidedAt: NOW.toISOString(), action, rationale: "テスト", decidedBy: "llm" };
}

const ACT_INTENT = "テストの失敗を直す";

function target(over: Partial<ActTarget> = {}): ActTarget {
  return {
    goal: GOAL,
    decision: decision({ type: "ACT", intent: ACT_INTENT }),
    attempt: 1,
    ...over,
  };
}

interface Spy {
  deps: ActDeps;
  /** 呼ばれた順。write-ahead が守られているかはここで見る */
  events: string[];
  ensured: { name: string; baseBranch: string }[];
  invocations: ActorInvocation[];
  started: RunIntent[];
  finished: { runId: string; outcome: RunOutcome }[];
}

interface SpyOptions {
  actorResult?: ActorResult;
  actorError?: Error;
  /** Actor の実行中に中断が起きる場合に渡す */
  abortDuringRun?: AbortController;
  ensureError?: Error;
  startError?: Error;
  signal?: AbortSignal;
}

function spy(options: SpyOptions = {}): Spy {
  const events: string[] = [];
  const ensured: { name: string; baseBranch: string }[] = [];
  const invocations: ActorInvocation[] = [];
  const started: RunIntent[] = [];
  const finished: { runId: string; outcome: RunOutcome }[] = [];

  const worktree: WorktreePort = {
    ensure: async (name, baseBranch) => {
      events.push("worktree.ensure");
      ensured.push({ name, baseBranch });
      if (options.ensureError !== undefined) {
        throw options.ensureError;
      }
      return { path: `/tmp/entelecheia/${name}`, branch: `entelecheia/${name}` };
    },
    changedPaths: async () => [],
    repoDirtyState: async () => new Map(),
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async (invocation) => {
      events.push("actor.run");
      invocations.push(invocation);
      if (options.abortDuringRun !== undefined) {
        options.abortDuringRun.abort();
        throw new Error("SIGTERM を受けて Actor を kill した");
      }
      if (options.actorError !== undefined) {
        throw options.actorError;
      }
      return options.actorResult ?? SUCCESS;
    },
  };

  const runs: RunRecorderPort = {
    start: async (intent) => {
      events.push("runs.start");
      started.push(intent);
      if (options.startError !== undefined) {
        throw options.startError;
      }
      return "run-1";
    },
    finish: async (runId, outcome) => {
      events.push("runs.finish");
      finished.push({ runId, outcome });
    },
  };

  const deps: ActDeps = { worktree, actor, runs, signal: options.signal, now: () => NOW };
  return { deps, events, ensured, invocations, started, finished };
}

describe("act", () => {
  describe("ACT 以外の Decision", () => {
    const others: Action[] = [
      { type: "COMPLETE" },
      { type: "VERIFY" },
      { type: "WAIT", reason: "ci_running", resumeAfter: null },
      { type: "ESCALATE", reason: "budget_exhausted" },
      { type: "REPLAN" },
    ];

    for (const action of others) {
      it(`${action.type} では Actor を起動せず、副作用も出さない`, async () => {
        const s = spy();
        const result = await act(target({ decision: decision(action) }), s.deps);

        expect(result.acted).toBe(false);
        expect(s.events).toEqual([]);
      });
    }

    it("実行しなかった理由が入る", async () => {
      // 無言で握り潰すと、呼び出し側が「起動したが何も起きなかった」と読む。
      const s = spy();
      const result = await act(target({ decision: decision({ type: "COMPLETE" }) }), s.deps);

      expect(result.acted).toBe(false);
      if (!result.acted) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe("write-ahead", () => {
    it("副作用の前に Run(starting) を書く", async () => {
      // worktree の作成も副作用。Run を書く前に作ると、kill されたときに
      // 誰も知らない worktree が残る。
      const s = spy();
      await act(target(), s.deps);

      expect(s.events).toEqual(["runs.start", "worktree.ensure", "actor.run", "runs.finish"]);
    });

    it("Run を書けなかったら worktree も作らず Actor も起動しない", async () => {
      const s = spy({ startError: new Error("DB がロックされている") });
      const result = await act(target(), s.deps);

      expect(s.events).toEqual(["runs.start"]);
      expect(result.acted).toBe(false);
    });

    it("起動前に書く意図には intent / actor / worktree / attempt が入る", async () => {
      const s = spy();
      await act(target({ attempt: 3 }), s.deps);

      expect(s.started[0]).toMatchObject({
        intent: ACT_INTENT,
        actor: "claude-code",
        attempt: 3,
        startedAt: NOW.toISOString(),
      });
      expect(s.started[0]?.worktree.length).toBeGreaterThan(0);
    });

    it("正常終了したら completed で確定する", async () => {
      const s = spy();
      const result = await act(target(), s.deps);

      expect(s.finished[0]?.runId).toBe("run-1");
      expect(s.finished[0]?.outcome.status).toBe("completed");
      expect(result.acted).toBe(true);
      if (result.acted) {
        expect(result.run.status).toBe("completed");
      }
    });

    it("exit_code が 0 でなければ failed で確定する", async () => {
      const s = spy({ actorResult: { ...SUCCESS, exitCode: 1 } });
      const result = await act(target(), s.deps);

      expect(s.finished[0]?.outcome.status).toBe("failed");
      if (result.acted) {
        expect(result.run.exitCode).toBe(1);
      }
    });

    it("Actor が throw しても act は throw せず failed で確定する", async () => {
      const s = spy({ actorError: new Error("claude が起動できない") });
      const result = await act(target(), s.deps);

      expect(s.finished[0]?.outcome.status).toBe("failed");
      expect(s.finished[0]?.outcome.detail).toContain("claude が起動できない");
      expect(result.acted).toBe(true);
    });

    it("結果には exit_code / log_ref / tokens / artifacts が入る", async () => {
      // トークンは Claude Max 経由でも記録する（design.md §7）。
      // 生ログはファイルに置き、参照だけを持つ（design.md §4.6）。
      const s = spy();
      const result = await act(target(), s.deps);

      expect(result.acted).toBe(true);
      if (result.acted) {
        expect(result.run.exitCode).toBe(0);
        expect(result.run.logRef).toBe(SUCCESS.logRef);
        expect(result.run.tokens).toBe(12_345);
        expect(result.run.artifacts).toEqual(["src/foo.ts"]);
        expect(result.run.finishedAt).toBe(NOW.toISOString());
      }
    });

    it("戻り値の Run が Run スキーマを通る", async () => {
      const s = spy();
      const result = await act(target(), s.deps);

      expect(result.acted).toBe(true);
      if (result.acted) {
        expect(() => runSchema.parse(result.run)).not.toThrow();
      }
    });
  });

  describe("worktree 隔離", () => {
    it("worktree の名前は goal.id から決まる", async () => {
      // ティックをまたいで同じ作業ツリーを使う。毎回変わると差分が積み上がらない。
      const s = spy();
      await act(target(), s.deps);

      expect(s.ensured[0]?.name).toContain("sample-goal");
      expect(s.ensured[0]?.baseBranch).toBe("main");
    });

    it("同じ Goal なら何度呼んでも同じ worktree 名になる", async () => {
      const first = spy();
      await act(target({ attempt: 1 }), first.deps);
      const second = spy();
      await act(target({ attempt: 2 }), second.deps);

      expect(second.ensured[0]?.name).toBe(first.ensured[0]?.name);
    });

    it("Actor には作った worktree が渡る", async () => {
      const s = spy();
      await act(target(), s.deps);

      expect(s.invocations[0]?.worktree.path).toBe("/tmp/entelecheia/sample-goal");
      expect(s.invocations[0]?.worktree.branch).toBe("entelecheia/sample-goal");
    });

    it("worktree を作れなければ Actor を起動しない", async () => {
      // 隔離できていない状態で Agent を走らせると、controller 本体を書き換えうる。
      const s = spy({ ensureError: new Error("worktree が作れない") });
      const result = await act(target(), s.deps);

      expect(s.events).toEqual(["runs.start", "worktree.ensure", "runs.finish"]);
      expect(s.finished[0]?.outcome.status).toBe("failed");
      expect(s.finished[0]?.outcome.exitCode).toBeNull();
      expect(result.acted).toBe(true);
    });
  });

  describe("Actor への引き渡し", () => {
    it("intent がそのまま渡る", async () => {
      const s = spy();
      await act(target(), s.deps);

      expect(s.invocations[0]?.intent).toBe(ACT_INTENT);
    });

    it("require_human_approval がそのまま渡る", async () => {
      // merge や force push を Agent に実行させない（design.md §7）。
      const s = spy();
      await act(target(), s.deps);

      expect(s.invocations[0]?.deniedOperations).toEqual(["merge", "force_push"]);
    });

    it("signal を渡さなくても Actor には AbortSignal が渡る", async () => {
      const s = spy();
      await act(target(), s.deps);

      expect(s.invocations[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(s.invocations[0]?.signal.aborted).toBe(false);
    });
  });

  describe("中断可能性", () => {
    it("起動前に中断されていたら副作用を出さない", async () => {
      const controller = new AbortController();
      controller.abort();
      const s = spy({ signal: controller.signal });
      const result = await act(target(), s.deps);

      expect(s.events).toEqual([]);
      expect(result.acted).toBe(false);
    });

    it("中断は Actor に伝播する", async () => {
      const controller = new AbortController();
      const s = spy({ signal: controller.signal });
      await act(target(), s.deps);

      expect(s.invocations[0]?.signal.aborted).toBe(false);
      controller.abort();
      expect(s.invocations[0]?.signal.aborted).toBe(true);
    });

    it("走行中に中断されたら interrupted で確定する", async () => {
      // failed に畳むと、次ティックが「Actor が失敗した」と読んで
      // 再試行上限を無駄に消費する。
      const controller = new AbortController();
      const s = spy({ signal: controller.signal, abortDuringRun: controller });
      const result = await act(target(), s.deps);

      expect(s.finished[0]?.outcome.status).toBe("interrupted");
      expect(result.acted).toBe(true);
      if (result.acted) {
        expect(result.run.status).toBe("interrupted");
      }
    });

    it("中断されても throw せず、Run を確定してから return する", async () => {
      const controller = new AbortController();
      const s = spy({ signal: controller.signal, abortDuringRun: controller });
      await expect(act(target(), s.deps)).resolves.toBeDefined();

      expect(s.events).toEqual(["runs.start", "worktree.ensure", "actor.run", "runs.finish"]);
    });
  });
});
