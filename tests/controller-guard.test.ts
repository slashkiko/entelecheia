import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import { openStore, type Store } from "../src/store/index.js";

/**
 * controller 側の関門（design.md §7 / §10-6）。
 *
 * Agent が保護パスを書き換えた、あるいは worktree の外に出たときに、
 * ACT の外側で検知して ESCALATE(protected_path_touched) にする。
 * 関門を act の中に入れると、Actor を起動する層と検査する層が同じになる。
 */

const NOW = new Date("2026-08-09T08:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";

function goalWith(protectedPaths: string[]): Goal {
  return {
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
    policies: { require_human_approval: ["merge"], protected_paths: protectedPaths },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 9,
    },
  };
}

interface Sink {
  comments: number;
  created: number;
}

function deps(store: Store, artifacts: string[], sink: Sink): ControllerDeps {
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    // 0 以外にして Gap を残す。ACT に落ちないと Actor が走らない。
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log", tokens: 10, artifacts }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => {
        sink.created += 1;
        return 1;
      },
      addComment: async () => {
        sink.comments += 1;
      },
    },
    branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }) },
    llm: { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

describe("保護パスの関門", () => {
  let store: Store;
  let sink: Sink;

  beforeEach(() => {
    store = openStore(":memory:");
    sink = { comments: 0, created: 0 };
  });

  afterEach(() => {
    store.close();
  });

  const run = async (goal: Goal, artifacts: string[]) => {
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    return tick(goal, deps(store, artifacts, sink));
  };

  it("保護パスを編集したら ESCALATE(protected_path_touched)", async () => {
    const result = await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    // 判断したのは LLM ではない（design.md §7）。
    expect(result.decision?.decidedBy).toBe("guard");
    expect(result.status).toBe("WAITING_HUMAN");
  });

  it("worktree の外を編集しても止める", async () => {
    const result = await run(goalWith([]), ["/repo/entelecheia/src/cli.ts"]);

    expect(result.decision?.action).toMatchObject({ reason: "protected_path_touched" });
    expect(result.decision?.rationale).toContain("worktree の外");
  });

  it("PR を作らない", async () => {
    // 作ると、保護パスへの変更が通常の変更として流れてしまう。
    await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    expect(sink.created).toBe(0);
  });

  it("Run は残す。worktree も触らない", async () => {
    // 差分を残しておかないと人間が判断できない。
    const result = await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    expect(result.run?.status).toBe("completed");
    expect(store.listRuns("sample-goal")).toHaveLength(1);
  });

  it("元の判断を rationale に残す", async () => {
    // 何をしようとしていたのかが読めなくなる。
    const result = await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    expect(result.decision?.rationale).toContain("元の判断");
  });

  it("差し替えた判断を DB に残す", async () => {
    await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    const decisions = store.listDecisions("sample-goal");
    expect(decisions.at(-1)?.action).toMatchObject({ reason: "protected_path_touched" });
  });

  it("保護パスに触れていなければ ACT のまま", async () => {
    const result = await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/cli.ts`,
    ]);

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
    expect(result.status).toBe("ACTIVE");
  });

  it("何も編集していなければ ACT のまま", async () => {
    const result = await run(goalWith(["src/controller/**"]), []);

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
  });
});
