import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal, PublishPolicy } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";
import { showPayload } from "../src/usecase/inspect.js";

/**
 * 宣言で publish を止めたティックが、人間から読める形で止まること（issue #60）。
 *
 * `policies.publish` は controller の行動を止める宣言なので、止まったことが
 * 状態と `ent get` の両方に出なければならない。黙って push しないだけだと、
 * 「押せなかった」のか「押さないと決めていた」のかを人間が区別できない。
 *
 * 固定するのは3つ。
 *
 * - 止めたティックの状態は WAITING_HUMAN になる。COMPLETED にはしない。
 *   PR が1本も無いまま「終わった」と言い切ると、完了判定が意味を失う
 * - 止めた理由が `ent get`（`decision`）から読める。どの段を止めたのかと、
 *   人間が何をすれば進むのかまで書く
 * - 宣言が無ければ、これまでどおり最後まで進む
 */

const NOW = new Date("2026-08-12T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "declared-manual-goal";

function goalWith(policy?: PublishPolicy): Goal {
  return {
    version: 1,
    goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
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
    policies: {
      require_human_approval: ["merge"],
      protected_paths: [],
      ...(policy === undefined ? {} : { publish: policy }),
    },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 9,
    },
  };
}

/** publish の呼び出し記録。テストごとに beforeEach で空にする */
let pushes: string[] = [];
let created: number[] = [];

function deps(store: Store): ControllerDeps {
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
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
        dirty: false,
      }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({ path: `${WORKTREE_ROOT}/${name}`, branch: `entelecheia/${name}` }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => {
        created.push(1);
        return 42;
      },
      addComment: async () => {},
    },
    branch: {
      push: async (name) => {
        pushes.push(name);
        return { branch: `entelecheia/${name}`, pushed: true };
      },
    },
    llm: { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  pushes = [];
  created = [];
});

afterEach(() => {
  store.close();
});

/** 2ティック目で max_reconciles に当たる予算にする */
function exhausting(goal: Goal): Goal {
  return { ...goal, budget: { ...goal.budget, max_reconciles: 1 } };
}

/**
 * criteria が落ち続ける構成。予算の枯渇を見るティックで COMPLETE に抜けさせない。
 *
 * 判定順は `budget_exhausted` → `COMPLETE` なので（design.md §4.4）、全部緑のまま
 * だと1ティック目で終端に入り、2ティック目が回らない。
 */
function failingCriteria(s: Store): ControllerDeps {
  return {
    ...deps(s),
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "落ちた" }) },
  };
}

function activate(goal: Goal): void {
  store.upsertGoal(goal);
  store.setStatus(GOAL_ID, "ACTIVE", null);
}

describe("宣言で publish を止めたティック", () => {
  it("open_pull_request: manual なら PR を作らず WAITING_HUMAN で止まる", async () => {
    // criteria は全部通っているので、宣言が無ければ COMPLETED まで行くティック。
    // PR が1本も無いまま終わったことにしない。
    const goal = goalWith({ push_branch: "auto", open_pull_request: "manual" });
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(created).toEqual([]);
    expect(result.status).toBe("WAITING_HUMAN");
  });

  it("push_branch: manual なら push もしない", async () => {
    const goal = goalWith({ push_branch: "manual", open_pull_request: "auto" });
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(pushes).toEqual([]);
    expect(result.status).toBe("WAITING_HUMAN");
  });

  it("何を待っているのかが ent get から読める", async () => {
    // status だけでは、承認待ちなのか関門で止まったのかを区別できない
    // （`ESCALATE(protected_path_touched)` も `WAIT(review_pending)` も WAITING_HUMAN）。
    // 止めた段と、人間が何をすれば進むのかを rationale に書く。
    const goal = goalWith({ push_branch: "auto", open_pull_request: "manual" });
    activate(goal);

    await tick(goal, deps(store));

    const decision = showPayload(goal, store).decision;
    expect(decision?.action).toEqual({
      type: "ESCALATE",
      reason: "open_pull_request_declared_manual",
    });
    expect(decision?.decidedBy).toBe("guard");
    expect(decision?.rationale).toContain("policies.publish.open_pull_request");
    // 人間が次に何をすればよいかまで書く。「止まった」しか読めない関門は、
    // 原因不明の停止と区別がつかない。
    expect(decision?.rationale).toContain("gh pr create");
  });

  it("push を止めたティックの理由も、段ごとに分かれている", async () => {
    const goal = goalWith({ push_branch: "manual", open_pull_request: "auto" });
    activate(goal);

    await tick(goal, deps(store));

    const decision = showPayload(goal, store).decision;
    expect(decision?.action).toEqual({
      type: "ESCALATE",
      reason: "push_branch_declared_manual",
    });
    expect(decision?.rationale).toContain("policies.publish.push_branch");
  });

  it("push_branch: manual は、宣言を書き換えるまで毎ティック止まり続ける", async () => {
    // 人間が手で push しても controller には見えない。押さないと決めた口
    // （BranchPort.push）が remote を知る唯一の経路になるため。
    // `open_pull_request` は findPullRequest が人間の PR を拾って解けるが、
    // こちらにその経路は無い。**解けないことを仕様として固定する。**
    // 止まっているのに毎ティック押し始めたら、宣言が効かなくなっている。
    const goal = goalWith({ push_branch: "manual", open_pull_request: "auto" });
    activate(goal);

    await tick(goal, deps(store));
    const second = await tick(goal, deps(store));

    expect(pushes).toEqual([]);
    expect(second.status).toBe("WAITING_HUMAN");
    expect(second.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "push_branch_declared_manual",
    });
    // 進むには宣言を戻すしかない。それを rationale が言っていること。
    expect(second.decision?.rationale).toContain("set back to auto");
  });

  it("予算を使い切っても BLOCKED にはならない", async () => {
    // 差し替えは publish の後ろにあるので、DECIDE が `ESCALATE(budget_exhausted)` を
    // 選んでいても `*_declared_manual` で上書きされる。`BLOCKED` になるのは
    // `budget_exhausted` だけなので（`nextStatus`）、止めているあいだ予算の枯渇は
    // 表に出ない。SKILL.md の代行手順が「BLOCKED になる」と書いていた形は起きない。
    const goal = exhausting(goalWith({ push_branch: "manual", open_pull_request: "auto" }));
    activate(goal);

    await tick(goal, failingCriteria(store));
    const second = await tick(goal, failingCriteria(store));

    expect(second.status).toBe("WAITING_HUMAN");
    expect(second.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "push_branch_declared_manual",
    });
  });

  it("宣言が無ければ、同じ予算で BLOCKED になる", async () => {
    // 上の1本が「上限を外した」のではなく「上書きしている」ことを示す対になる。
    // 宣言だけを外せば、同じ予算・同じ criteria で budget_exhausted が表に出る。
    const goal = exhausting(goalWith());
    activate(goal);

    await tick(goal, failingCriteria(store));
    const second = await tick(goal, failingCriteria(store));

    expect(second.status).toBe("BLOCKED");
    expect(second.decision?.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
  });

  it("1ティックに書く Decision は1行のまま", async () => {
    // 差し替えた分をもう1行足すと、countTrailingDigest が数える行が増えて
    // max_unchanged_reconciles が余計に進む。
    const goal = goalWith({ push_branch: "manual", open_pull_request: "auto" });
    activate(goal);

    await tick(goal, deps(store));

    expect(store.listDecisions(GOAL_ID)).toHaveLength(1);
  });
});

describe("宣言が無ければ、これまでどおり進む", () => {
  it("push も PR 作成も走り、WAITING_HUMAN にはならない", async () => {
    const goal = goalWith();
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(pushes).toEqual([GOAL_ID]);
    expect(created).toEqual([1]);
    expect(result.status).not.toBe("WAITING_HUMAN");
  });
});
