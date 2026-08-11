import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { AcceptanceCriterion, Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `--dry-run` が、本番のティックと同じ関門を通ることを固定する。
 *
 * dry-run の存在理由は「次のティックで何が起きるかを、起こす前に見る」ことにある。
 * 関門を1つ通し忘れると、実際には止まるティックを「進む」と見せる。止まる側を
 * 見落とすのは、進む側を見落とすより悪い。人間はそれを見て安全だと判断する。
 *
 * 実際 preview() は guardedDecision（保護パス）だけを通し、あとから足された
 * uncommittedDecision（未 commit）を通していなかった。PR #20 が足した
 * 「覗く道具」が、PR #22 が足した関門を見ていない状態になっていた。
 *
 * あわせて、終端と休眠のティックでも dryRun を名乗ることを固定する。
 * この2つの分岐は dry-run の分岐より前にあるので、通ると dryRun が付かなかった。
 * SKILL.md は「`--dry-run` だけは例外で、`ran: false` でも `skipped` は null に
 * なる。代わりに `dryRun: true` が付くので、そちらで見分ける」と無条件に書いている。
 */

const NOW = new Date("2026-08-09T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "dry-run-guard-goal";

const COMMAND_CRITERION: AcceptanceCriterion = {
  id: "ac-1",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

const GOAL: Goal = {
  version: 1,
  goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [COMMAND_CRITERION],
  context: { background: "背景", constraints: [], references: [] },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 9,
  },
};

function deps(store: Store, options: { dirty?: boolean; approved?: boolean } = {}): ControllerDeps {
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
    dryRun: true,
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({
        branch: `entelecheia/${GOAL_ID}`,
        headSha: "a".repeat(40),
        dirty: options.dirty ?? false,
      }),
    },
    command: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    approval: {
      getApproval: async () =>
        options.approved === true
          ? { approvedBy: "reviewer", approvedAt: "2026-08-09T08:00:00.000Z" }
          : null,
    },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => {
        throw new Error("dry-run では Actor を起動しない");
      },
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => {
        throw new Error("dry-run では PR を作らない");
      },
      addComment: async () => {
        throw new Error("dry-run では書き込まない");
      },
    },
    branch: {
      push: async () => {
        throw new Error("dry-run では push しない");
      },
    },
    llm: {
      chooseAction: async () => {
        throw new Error("criteria が全部通っているので guard が決める");
      },
    },
    now: () => NOW,
  };
}

/** 前のティックで Actor が走り終えた状態にする。未 commit の関門はこれを前提にする */
function seedCompletedRun(store: Store): void {
  const runId = store.startRun(GOAL_ID, {
    intent: "criteria を満たす実装を書く",
    actor: "claude-code",
    role: "implement",
    worktree: GOAL_ID,
    attempt: 1,
    startedAt: "2026-08-09T08:00:00.000Z",
  });
  store.finishRun(runId, {
    status: "completed",
    finishedAt: "2026-08-09T08:30:00.000Z",
    exitCode: 0,
    logRef: "log.txt",
    tokens: 1000,
    artifacts: ["src/cli.ts"],
    detail: null,
  });
}

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
  store.setStatus(GOAL_ID, "ACTIVE", null);
});

afterEach(() => {
  store.close();
});

describe("--dry-run は本番と同じ関門を通す", () => {
  it("未 commit の変更があれば COMPLETED を予告しない", async () => {
    // 同じ状態で本番のティックは ESCALATE(uncommitted_changes) → WAITING_HUMAN に
    // なる（tests/controller-uncommitted.test.ts）。dry-run だけが COMPLETE を
    // 見せると、「1行も push せず COMPLETED」を安全だと読ませる。
    //
    // **`command` 型を持たない Goal で見る。** 機械側の criteria が全部通った
    // ティックは、本番なら controller が先に commit するので関門は鳴らない
    // （tests/controller-commit.test.ts）。dry-run はそれも予告するので、
    // ここで確かめたいのは「commit が起きない側のティック」になる。
    const humanOnly: Goal = {
      ...GOAL,
      acceptance_criteria: [
        {
          id: "ac-1",
          description: "人間が確認する",
          verification: { type: "human", prompt: "読む" },
        },
      ],
    };
    seedCompletedRun(store);

    const result = await tick(humanOnly, deps(store, { dirty: true, approved: true }));

    expect(result.dryRun).toBe(true);
    expect(result.decision?.action.type).not.toBe("COMPLETE");
    expect(result.wouldTransitionTo).not.toBe("COMPLETED");
    // 書かないことは変わらない。
    expect(store.getState(GOAL_ID)?.status).toBe("ACTIVE");
  });

  it("worktree が汚れていなければ COMPLETED を予告する", async () => {
    // 上のテストが「dry-run はいつも COMPLETE を出さない」で通っていないことを示す。
    seedCompletedRun(store);

    const result = await tick(GOAL, deps(store, { dirty: false }));

    expect(result.decision?.action.type).toBe("COMPLETE");
    expect(result.wouldTransitionTo).toBe("COMPLETED");
  });
});

describe("--dry-run の出力は常に dryRun を名乗る", () => {
  it("終端の Goal でも dryRun が付く", async () => {
    store.setStatus(GOAL_ID, "COMPLETED", null);

    const result = await tick(GOAL, deps(store));

    expect(result.ran).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it("休眠中の Goal でも dryRun が付く", async () => {
    const resumeAfter = new Date(NOW.getTime() + 60_000).toISOString();
    store.setStatus(GOAL_ID, "WAITING_EXTERNAL", resumeAfter);

    const result = await tick(GOAL, deps(store));

    expect(result.ran).toBe(false);
    expect(result.dryRun).toBe(true);
  });
});
