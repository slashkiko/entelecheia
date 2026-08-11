import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorPort, WorktreePort } from "../src/act/index.js";
import { parseCommand } from "../src/cli.js";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { LlmPort } from "../src/decide/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `ent run <slug> --dry-run`。
 *
 * 次のティックで何が起きるかを、起こす前に見せる。OBSERVE / VERIFY / ASSESS /
 * DECIDE までは本当に回し、ACT と publish と永続化だけを飛ばす。
 * 観測を模擬すると「配管が繋がっているか」を確かめる用途に使えなくなるので、
 * 飛ばすのは副作用の側だけにする。
 *
 * 何を確かめるためのものか:
 * - VERIFY がどこで何を流したのか。criteria が落ちているのは実装のせいか環境のせいか
 * - 観測できなかったものが unresolved に残っているか（GITHUB_TOKEN の未設定など）
 * - DECIDE が次に何をしようとしているか。ACT なら Actor に渡す intent の文面
 *
 * 消費するものは正直に書く。VERIFY のコマンドは実際に流れ、DECIDE は LLM を呼ぶ。
 * 飛ぶのは Actor の起動と GitHub への書き込みで、ティックが無料になるわけではない。
 */

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
let events: string[];

interface Options {
  /** 0 以外なら Gap が残り、LLM 経路に入る */
  exitCode?: number;
  llm?: LlmPort;
  dryRun?: boolean;
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
      return { exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] };
    },
  };

  return {
    store,
    worktree,
    actor,
    owner: "worker-a",
    leaseSeconds: 300,
    dryRun: options.dryRun ?? false,
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => {
        events.push("code.getPullRequest");
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
      run: async () => {
        events.push("command.run");
        return { exitCode: options.exitCode ?? 1, stdout: "", stderr: "" };
      },
    },
    approval: { getApproval: async () => null },
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
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }),
    },
    llm: options.llm ?? { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

beforeEach(() => {
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
  store.setStatus("sample-goal", "ACTIVE", null, NOW.toISOString());
  events = [];
});

afterEach(() => {
  store.close();
});

describe("run は --dry-run を受け取る", () => {
  it("--dry-run は run にだけ付く", () => {
    expect(parseCommand(["run", "sample-goal", "--dry-run"])).toEqual({
      kind: "run",
      slug: "sample-goal",
      dryRun: true,
    });
    expect(parseCommand(["list", "--dry-run"]).kind).toBe("error");
    expect(parseCommand(["start", "sample-goal", "--dry-run"]).kind).toBe("error");
  });

  it("--dry-run を渡さないときの解釈は変えない", () => {
    expect(parseCommand(["run", "sample-goal"])).toEqual({ kind: "run", slug: "sample-goal" });
  });

  it("他のフラグと併せて渡せる", () => {
    expect(parseCommand(["run", "sample-goal", "--dry-run", "--pr", "12"])).toEqual({
      kind: "run",
      slug: "sample-goal",
      dryRun: true,
      prNumber: 12,
    });
  });
});

describe("tick(--dry-run)", () => {
  it("観測と検証は本当に行う", async () => {
    // ここを模擬すると、配管が繋がっているかを確かめる用途に使えなくなる。
    await tick(GOAL, deps({ dryRun: true }));

    expect(events).toContain("local.snapshot");
    expect(events).toContain("code.getPullRequest");
    expect(events).toContain("command.run");
  });

  it("Actor を起動しない", async () => {
    const result = await tick(GOAL, deps({ dryRun: true }));

    expect(result.decision?.action.type).toBe("ACT");
    expect(events).not.toContain("worktree.ensure");
    expect(events).not.toContain("actor.run");
    expect(result.run).toBeNull();
    expect(store.listRuns("sample-goal")).toEqual([]);
  });

  it("PR も進捗コメントも書かない", async () => {
    await tick(GOAL, deps({ dryRun: true }));

    expect(events).not.toContain("writer.createPullRequest");
    expect(events).not.toContain("writer.addComment");
  });

  it("DB に何も残さない。次のティックの判断材料を汚さない", async () => {
    const before = store.getState("sample-goal");
    await tick(GOAL, deps({ dryRun: true }));
    const after = store.getState("sample-goal");

    expect(store.latestSnapshot("sample-goal")).toBeNull();
    expect(store.listDecisions("sample-goal")).toEqual([]);
    expect(store.latestVerifications("sample-goal")).toEqual([]);
    expect(after?.reconciles).toBe(before?.reconciles);
    expect(after?.status).toBe("ACTIVE");
  });

  it("lease を取らない。書かないので他のワーカーを塞ぐ理由が無い", async () => {
    store.acquireLease("sample-goal", "worker-b", new Date(NOW.getTime() + 60_000), NOW);

    const result = await tick(GOAL, deps({ dryRun: true }));

    // 実行中の Goal に対しても、次に何をするつもりかは読めた方がよい。
    expect(result.skipped).toBeNull();
    expect(store.getState("sample-goal")?.leaseOwner).toBe("worker-b");
  });

  it("決まった行動と、その理由を返す", async () => {
    const result = await tick(GOAL, deps({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.decision?.action).toEqual({ type: "ACT", intent: "テストを直す" });
    expect(result.decision?.rationale.length).toBeGreaterThan(0);
  });

  it("書いていたらどの状態に移っていたかを返す", async () => {
    // 状態は動かさないので、動かしていたらどうなったかを別に返す。
    const result = await tick(GOAL, deps({ dryRun: true }));

    expect(result.status).toBe("ACTIVE");
    expect(result.wouldTransitionTo).toBe("ACTIVE");
  });

  it("観測と検証の結果を返す。DB に残らないので、ここで返さないと読めない", async () => {
    const result = await tick(GOAL, deps({ dryRun: true, exitCode: 1 }));

    expect(result.observed?.facts.some((fact) => fact.key === "local.head_sha")).toBe(true);
    expect(result.observed?.verifications.map((v) => v.criterionId)).toContain("ac-1");
    expect(result.observed?.verifications[0]?.result).toBe("failed");
  });

  it("criteria が揃っていれば COMPLETE を返す。ただし COMPLETED にはしない", async () => {
    const result = await tick(GOAL, deps({ dryRun: true, exitCode: 0 }));

    expect(result.decision?.action.type).toBe("COMPLETE");
    expect(result.wouldTransitionTo).toBe("COMPLETED");
    expect(store.getState("sample-goal")?.status).toBe("ACTIVE");
  });

  it("終端の Goal は dry-run でも回さない", async () => {
    store.setStatus("sample-goal", "COMPLETED", null);

    const result = await tick(GOAL, deps({ dryRun: true }));

    expect(result.skipped).not.toBeNull();
    expect(events).toEqual([]);
  });
});

describe("tick(通常)", () => {
  it("--dry-run を渡さなければ、これまでどおり ACT まで進む", async () => {
    const result = await tick(GOAL, deps());

    expect(result.ran).toBe(true);
    expect(result.dryRun).toBeFalsy();
    expect(events).toContain("actor.run");
    expect(store.latestSnapshot("sample-goal")).not.toBeNull();
  });
});
