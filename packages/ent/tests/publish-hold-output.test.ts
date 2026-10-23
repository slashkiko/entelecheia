import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentContextPayload } from "../src/cli/agent-context.js";
import { summarize } from "../src/cli/present.js";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Decision } from "../src/domain/action.js";
import type { Goal, PublishPolicy } from "../src/domain/goal.js";
import type { Verification } from "../src/domain/verification.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type PublishTarget,
  publish,
} from "../src/publish/index.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 宣言（`policies.publish`）で止めたことを、`ent run` の出力から機械的に読む（issue #60）。
 *
 * ティックを叩くのは人間だけではない。エージェントが回している構成では、controller が
 * 作らなかった PR をそのエージェントが代わりに立てる。そのためには「作らなかった」と
 * 「作るなら head と base はこれ」が、**散文の grep 無しで**読めなければならない。
 *
 * 既にある `skipped` と `decision.rationale` は人間が読む1行で、文面は直る。停止条件を
 * 文字列の部分一致に載せると、文面を直した瞬間にエージェント側の分岐が黙って消える。
 *
 * ここで固定するのは4つ。
 *
 * - 止めた段と、ブランチと base が、専用のキー（`publishHold`）に構造化されて出る
 * - **「push は済んで PR だけ作っていない」と「push も止めた」が区別できる。**
 *   push されていないブランチに PR は立てられないので、混ざると使えない
 * - 宣言が無いティックの出力は1キーも変わらない。既存の `jq` を壊さない
 * - 止めたのが宣言でないとき（保護パスの関門）は、このキーが出ない。
 *   関門で止まったティックのブランチを「押していい」と読ませない
 */

const NOW = new Date("2026-08-12T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "publish-hold-goal";
const BRANCH = `entelecheia/${GOAL_ID}`;

function goalWith(
  policy?: PublishPolicy,
  protectedPaths: string[] = [],
  criterionCommand = "mise run test",
): Goal {
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
        verification: { type: "command", run: criterionCommand },
      },
    ],
    context: { background: "背景", constraints: [], references: [] },
    policies: {
      require_human_approval: ["merge"],
      protected_paths: protectedPaths,
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

interface Fixture {
  /** Actor の自己申告。保護パスの関門を鳴らすときに使う */
  artifacts?: string[];
  /** criteria のコマンドの終了コード。0 以外にすると Gap が残って ACT に落ちる */
  exitCode?: number;
}

let pushes: string[] = [];
let created: number[] = [];

function deps(store: Store, fixture: Fixture = {}): ControllerDeps {
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
      snapshot: async () => ({ branch: BRANCH, headSha: "a".repeat(40), dirty: false }),
    },
    command: {
      run: async () => ({ exitCode: fixture.exitCode ?? 0, stdout: "", stderr: "" }),
    },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({ path: `${WORKTREE_ROOT}/${name}`, branch: `entelecheia/${name}` }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({
        exitCode: 0,
        logRef: "log.txt",
        tokens: 10,
        artifacts: fixture.artifacts ?? [],
      }),
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

function activate(goal: Goal): void {
  store.upsertGoal(goal);
  store.setStatus(GOAL_ID, "ACTIVE", null, NOW.toISOString());
}

describe("止めた段が ent run の出力から機械的に読める", () => {
  it("PR だけ止めたティックは、押した head と base まで出る", async () => {
    // エージェントはこれを読んで `gh pr create --head <branch> --base <base>` を叩く。
    // ブランチ名を rationale から正規表現で剥がす形にすると、文面を直した瞬間に壊れる。
    const goal = goalWith({ push_branch: "auto", open_pull_request: "manual" });
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.publishHold).toEqual({
      step: "open_pull_request",
      reason: "declared_manual",
      pushed: true,
      branch: BRANCH,
      base: "main",
    });
    expect(summarize(result).publishHold).toEqual(result.publishHold);
  });

  it("push も止めたティックは pushed: false になる", async () => {
    // **ここが混ざると使えない。** remote に無いブランチに PR は立てられないので、
    // エージェントは pushed を見てから PR を作るかどうかを決める。
    const goal = goalWith({ push_branch: "manual", open_pull_request: "auto" });
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.publishHold).toEqual({
      step: "push_branch",
      reason: "declared_manual",
      pushed: false,
      branch: BRANCH,
      base: "main",
    });
  });

  it("止めた理由の種別を持つ。止め方が増えても分岐が壊れない", async () => {
    // `step` だけだと「宣言で止めた」と「別の事情で止めた」が同じ形になる。
    // 段が増えるより先に理由が増える方があり得るので、種別を別のキーに置く。
    const goal = goalWith({ push_branch: "auto", open_pull_request: "manual" });
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.publishHold?.reason).toBe("declared_manual");
  });
});

describe("宣言が無いティックの出力は変わらない", () => {
  it("キーが1つも増えない", async () => {
    // 既存の `.goals/*.yaml` を回している `jq` を壊さない。「増やしていない」ではなく
    // 「増やせない」を固定する。
    const goal = goalWith();
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.publishHold).toBeUndefined();
    expect(Object.keys(summarize(result)).sort()).toEqual([
      "action",
      "ran",
      "rationale",
      "reclaimed",
      "run",
      "skipped",
      "status",
    ]);
  });
});

describe("宣言以外で止まったティックには出ない", () => {
  it("保護パスの関門で止めたときは、キーが出ない", async () => {
    // 関門が止めたティックのブランチは push していない。ここに publishHold を
    // 出すと、エージェントが「代わりに押して PR を立てる」経路に入る。
    // 関門をエージェントに迂回させるのは、関門が無いのと同じになる。
    const goal = goalWith(undefined, ["src/controller/**"], "exit 1");
    activate(goal);

    const result = await tick(goal, {
      ...deps(store, {
        exitCode: 1,
        artifacts: [`${WORKTREE_ROOT}/${GOAL_ID}/src/controller/index.ts`],
      }),
    });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.publishHold).toBeUndefined();
    expect(summarize(result)).not.toHaveProperty("publishHold");
  });
});

describe("publish が返す hold", () => {
  const DECISION: Decision = {
    decidedAt: NOW.toISOString(),
    action: { type: "ACT", intent: "テストの失敗を直す" },
    rationale: "Gap が 1 件ある",
    decidedBy: "llm",
  };

  const VERIFICATIONS: Verification[] = [
    {
      criterionId: "ac-1",
      result: "passed",
      reason: null,
      evidence: { source: "mise run test", detail: "exit_code=0" },
      detail: "exit_code=0",
      verifiedAt: NOW.toISOString(),
    },
  ];

  const writer: CodeWriterPort = {
    findPullRequest: async () => null,
    createPullRequest: async () => 42,
    addComment: async () => {},
  };
  const branch: BranchPort = {
    push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }),
  };

  function target(goal: Goal, over: Partial<PublishTarget> = {}): PublishTarget {
    return {
      goal,
      run: null,
      decision: DECISION,
      verifications: VERIFICATIONS,
      prNumber: null,
      digest: "digest-2",
      previousDigest: "digest-1",
      ...over,
    };
  }

  it("段と pushed の対応は入れ替わらない", async () => {
    // publish の順序が変わって、押していないブランチに open_pull_request の hold が
    // 出るようになったら、ここで落ちる。エージェントに remote に無いブランチで
    // PR を立てさせる形が、この変更でいちばん重い壊れ方になる。
    const held = await publish(
      target(goalWith({ push_branch: "auto", open_pull_request: "manual" })),
      { writer, branch, now: () => NOW },
    );
    const stopped = await publish(
      target(goalWith({ push_branch: "manual", open_pull_request: "auto" })),
      { writer, branch, now: () => NOW },
    );

    expect(held.held?.step).toBe("open_pull_request");
    expect(held.held?.pushed).toBe(true);
    expect(stopped.held?.step).toBe("push_branch");
    expect(stopped.held?.pushed).toBe(false);
  });

  it("--report で回しても hold は返る", async () => {
    // 進捗を PR に投稿しない構成（`ent run --report stdout`）は、まさにエージェントが
    // 回すときの叩き方になる。ここで hold が落ちると、代わりに PR を作らせる相手に
    // 届かない。
    const result = await publish(
      target(goalWith({ push_branch: "auto", open_pull_request: "manual" })),
      {
        writer,
        branch,
        now: () => NOW,
        report: { destination: "stdout", write: async () => {} },
      },
    );

    expect(result.held?.step).toBe("open_pull_request");
    expect(result.report?.written).toBe(true);
  });

  it("保護パスの関門が止めたティックでは null", async () => {
    const result = await publish(
      target(goalWith({ push_branch: "auto", open_pull_request: "manual" }), {
        decision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ESCALATE", reason: "protected_path_touched" },
          rationale: "保護パスに触れた",
          decidedBy: "guard",
        },
      }),
      { writer, branch, now: () => NOW },
    );

    expect(result.held).toBeNull();
  });
});

describe("agent-context が出力の形を申告する", () => {
  it("run が条件付きで足すキーを並べる", () => {
    // ここが実装より古いと、Layer 2 は --help より当てにならないものになる。
    const run = agentContextPayload().commands.find((command) => command.name === "run");
    const keys = run?.output?.map((entry) => entry.key) ?? [];

    expect(keys).toContain("publishHold");
    expect(keys).toContain("dryRun");
    expect(keys).toContain("report");
  });

  it("版を上げる。増えたのか壊れたのかを読む側が区別できるようにする", () => {
    expect(agentContextPayload().schemaVersion).toBeGreaterThanOrEqual(3);
  });
});
