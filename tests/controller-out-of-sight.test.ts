import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import { type AcceptanceCriterion, type Goal, goalSchema } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * git に見えない書き込みの検知が、controller まで通して実際に鳴ることを固定する。
 *
 * `tests/out-of-sight.test.ts` は adapter（`gitWorktree.outOfSightState`）が
 * hooks と `core.hooksPath` と状態 DB の指紋を返すことを確かめている。だが
 * 「観測が正しい」ことと「関門が鳴る」ことは別で、その間の配線を見ていなかった。
 *
 * 実際、配線は片側だけ繋がっていなかった。ACT の前は
 * `repoBaseline`（dirty + outOfSight）を控えるのに、後は
 * `repoDirtyState()` だけを読んでいた。差分の抽出は after 側のエントリしか
 * 走査しないので、before にしか無い out-of-sight のパスは指紋がどう変わっても
 * 差分に入らない。**hooks を書かれても DB を偽造されても素通りしていた。**
 * そのうえ、controller から out-of-sight の合成を丸ごと消しても既存 543 本が
 * 全部緑だった。守るものが1本も無かったことになる。
 *
 * この形は README が挙げた4つの断線と同じで、部品は正しいのに繋がっていない。
 * 部品側のテストは繋がっていなくても緑になる。
 */

const NOW = new Date("2026-08-09T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "out-of-sight-goal";

const COMMAND_CRITERION: AcceptanceCriterion = {
  id: "ac-1",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

/**
 * スキーマを通して作る。`PROTECTED_PATH_FLOOR` を混ぜるのは zod の transform なので、
 * リテラルで組み立てた Goal には下限が入らない。本番の経路（`loadGoalFile` →
 * `parseGoal` → `goalSchema.parse`）と同じ形にしないと、関門の適用範囲が
 * 実運用と違うものになる。
 */
const GOAL: Goal = goalSchema.parse({
  version: 1,
  goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している" },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [COMMAND_CRITERION],
  context: { background: "背景", constraints: [], references: [] },
  // 保護パスを空で宣言しても、スキーマの下限が .git/** と .goals/.state/** を入れる。
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 9,
  },
});

interface Options {
  /** ACT の前後で outOfSightState が返す指紋。2要素なら before / after */
  outOfSight: readonly Map<string, string>[];
}

function deps(store: Store, options: Options): ControllerDeps {
  let call = 0;
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
      snapshot: async () => ({
        branch: `entelecheia/${GOAL_ID}`,
        headSha: "a".repeat(40),
        dirty: false,
      }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      changedPaths: async () => [],
      // git が見える汚れは常に空。ここでは out-of-sight だけを動かす。
      repoDirtyState: async () => new Map(),
      outOfSightState: async () => {
        const value = options.outOfSight[Math.min(call, options.outOfSight.length - 1)];
        call += 1;
        return new Map(value ?? []);
      },
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => undefined,
    },
    branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }) },
    llm: { chooseAction: async () => ({ type: "ACT", intent: "実装する" }) },
    now: () => NOW,
  };
}

const CLEAN = new Map([
  [".git/hooks/pre-push", "sha-clean"],
  [".git/config#core.hooksPath", "unset"],
  [".goals/.state/goals.db", "sha-db"],
]);

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
  store.setStatus(GOAL_ID, "ACTIVE", null);
});

afterEach(() => {
  store.close();
});

describe("git に見えない書き込みが controller の関門を鳴らす", () => {
  it("hook を置かれたら ESCALATE する", async () => {
    const after = new Map(CLEAN).set(".git/hooks/pre-push", "sha-evil");

    const result = await tick(GOAL, deps(store, { outOfSight: [CLEAN, after] }));

    expect(result.decision?.action.type).toBe("ESCALATE");
    expect(store.getState(GOAL_ID)?.status).toBe("WAITING_HUMAN");
  });

  it("core.hooksPath を差し替えられたら ESCALATE する", async () => {
    const after = new Map(CLEAN).set(".git/config#core.hooksPath", "evil-hooks");

    const result = await tick(GOAL, deps(store, { outOfSight: [CLEAN, after] }));

    expect(result.decision?.action.type).toBe("ESCALATE");
  });

  it("状態 DB を書き換えられたら ESCALATE する", async () => {
    const after = new Map(CLEAN).set(".goals/.state/goals.db", "sha-forged");

    const result = await tick(GOAL, deps(store, { outOfSight: [CLEAN, after] }));

    expect(result.decision?.action.type).toBe("ESCALATE");
  });

  it("hook を消されても ESCALATE する", async () => {
    // 消された分は after 側に現れない。after だけを走査していると取りこぼす。
    const after = new Map(CLEAN);
    after.delete(".git/hooks/pre-push");

    const result = await tick(GOAL, deps(store, { outOfSight: [CLEAN, after] }));

    expect(result.decision?.action.type).toBe("ESCALATE");
  });

  it("何も変わっていなければ ESCALATE しない", async () => {
    // 上の4本が「常に ESCALATE する」で通っていないことを示す。
    // 鳴りっぱなしの関門は誰も見なくなる。
    const result = await tick(GOAL, deps(store, { outOfSight: [CLEAN, CLEAN] }));

    expect(result.decision?.action.type).not.toBe("ESCALATE");
  });
});
