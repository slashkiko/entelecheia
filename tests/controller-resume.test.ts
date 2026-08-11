import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `resume_after` を読む側。design.md §10-5。
 *
 * 書き込む側は Phase 2 の3本目で入ったが、読む側が無かった。
 * WAITING_EXTERNAL(usage_limit) で resume_after を書いても、次のティックが
 * それを見ずに走ってしまい、§9 の「上限で寝て起きる」に到達できない。
 */

const NOW = new Date("2026-08-09T06:00:00.000Z");

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
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

function deps(store: Store): ControllerDeps {
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({ path: `/tmp/${name}`, branch: `entelecheia/${name}` }),
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log", tokens: 0, artifacts: [] }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => undefined,
    },
    branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: false }) },
    llm: { chooseAction: async () => ({ type: "VERIFY" }) },
    now: () => NOW,
  };
}

describe("resume_after を読む", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
    store.setStatus(GOAL.goal.id, "ACTIVE", null, NOW.toISOString());
  });

  afterEach(() => {
    store.close();
  });

  it("resume_after を過ぎるまで回さない", async () => {
    const later = new Date(NOW.getTime() + 3600_000).toISOString();
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", later);

    const result = await tick(GOAL, deps(store));

    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("resume_after");
    expect(result.status).toBe("WAITING_EXTERNAL");
    // 観測もしていない。reconciles は進まない。
    expect(store.getState(GOAL.goal.id)?.reconciles).toBe(0);
  });

  it("寝ているあいだは lease を取らない", async () => {
    // 取ると、寝ているだけの Goal が他のワーカーを塞ぐ。
    const later = new Date(NOW.getTime() + 3600_000).toISOString();
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", later);

    await tick(GOAL, deps(store));

    expect(store.getState(GOAL.goal.id)?.leaseOwner).toBeNull();
  });

  it("resume_after を過ぎていれば回す", async () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", past);

    const result = await tick(GOAL, deps(store));

    expect(result.ran).toBe(true);
    expect(result.skipped).toBeNull();
  });

  it("ちょうど同時刻なら起きる", async () => {
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", NOW.toISOString());

    expect((await tick(GOAL, deps(store))).ran).toBe(true);
  });

  it("resume_after が無ければ回す", async () => {
    expect((await tick(GOAL, deps(store))).ran).toBe(true);
  });

  it("解釈できない resume_after では止まらない", async () => {
    // 壊れた値のせいで Goal が永久に止まる方が、1ティック早く起きるより悪い。
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", "いつか");

    expect((await tick(GOAL, deps(store))).ran).toBe(true);
  });

  it("起きたティックで resume_after が消える", async () => {
    // 次に WAIT 以外の Decision が出た時点で null に戻る。
    const past = new Date(NOW.getTime() - 1000).toISOString();
    store.setStatus(GOAL.goal.id, "WAITING_EXTERNAL", past);

    await tick(GOAL, deps(store));

    expect(store.getState(GOAL.goal.id)?.resumeAfter).toBeNull();
  });

  it("回さなかった理由を区別できる", async () => {
    // 「寝ている」「他のワーカーが処理中」「終端」はどれも ran: false になる。
    store.setStatus(GOAL.goal.id, "COMPLETED", null);
    const terminal = await tick(GOAL, deps(store));
    expect(terminal.skipped).toContain("終端");

    store.setStatus(GOAL.goal.id, "ACTIVE", null);
    // 期限判定も注入した時計で行う。NOW より先に置いておけば奪われない。
    store.acquireLease(GOAL.goal.id, "worker-b", new Date(NOW.getTime() + 3_600_000), NOW);
    const leased = await tick(GOAL, deps(store));
    expect(leased.skipped).toContain("lease");
  });
});
