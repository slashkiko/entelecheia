import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import { type Goal, goalSchema } from "../src/domain/goal.js";
import type { GoalStatus } from "../src/domain/goal-state.js";
import { dependencyGate, describeDependencyGate } from "../src/domain/guard-rules.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * サブ Goal の依存宣言（design.md §10-12）。
 *
 * 分解した1本ごとに Goal を立てる方針を採ったので、順序は Goal YAML の
 * `goal.depends_on` に書く。Goal の下に Task 層は切らないため、依存を持つ層は
 * ここしかない。
 *
 * 判定は `dependencyGate` の純ロジックが持つ。「先に進んでよいか」は停止条件で、
 * LLM に決めさせない境界（design.md §7）の内側にある。だから `guard-rules.ts` に
 * 置き、そのファイルは `PROTECTED_PATH_FLOOR` に入っている。
 */

function goalYaml(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    goal: {
      id: "sub-goal-a",
      name: "サブ Goal",
      desired_state: "何かが完成している",
      ...overrides,
    },
    repository: {
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    },
    acceptance_criteria: [
      {
        id: "ac-1",
        description: "テストが通る",
        verification: { type: "command", run: "mise run test" },
      },
    ],
    context: { background: "背景", constraints: [] },
    policies: {},
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 3,
    },
  };
}

function statusMap(entries: Record<string, GoalStatus>) {
  return (goalId: string): GoalStatus | null => entries[goalId] ?? null;
}

describe("depends_on を宣言部に置く", () => {
  it("書かなければ空になる。既存の Goal はこれまでどおり単独で回る", () => {
    const goal: Goal = goalSchema.parse(goalYaml());

    expect(goal.goal.depends_on).toEqual([]);
  });

  it("id の配列を宣言順のまま受け取る", () => {
    const goal: Goal = goalSchema.parse(
      goalYaml({ depends_on: ["build-the-thing", "wire-it-up"] }),
    );

    expect(goal.goal.depends_on).toEqual(["build-the-thing", "wire-it-up"]);
  });

  it("自分自身への依存は受け付けない", () => {
    // 書けた時点で永久に進まない Goal になる。循環はファイル1本からは
    // 見えないので、ここで見るのは自己参照だけにする。
    const parsed = goalSchema.safeParse(goalYaml({ depends_on: ["sub-goal-a"] }));

    expect(parsed.success).toBe(false);
  });

  it("同じ id を2回書いたら受け付けない", () => {
    const parsed = goalSchema.safeParse(goalYaml({ depends_on: ["other-goal", "other-goal"] }));

    expect(parsed.success).toBe(false);
  });

  it("slug の形をしていない id は受け付けない", () => {
    // slug はそのまま .goals/<slug>.yaml のパスになる。id と同じ厳しさで縛る。
    expect(goalSchema.safeParse(goalYaml({ depends_on: ["../escape"] })).success).toBe(false);
    expect(goalSchema.safeParse(goalYaml({ depends_on: ["Not_A_Slug"] })).success).toBe(false);
  });
});

describe("依存が揃っているかを判定する", () => {
  it("depends_on が空なら常に進める", () => {
    expect(dependencyGate([], statusMap({}))).toEqual({
      ready: true,
      pending: [],
      unreachable: [],
    });
  });

  it("すべて COMPLETED なら進める", () => {
    const gate = dependencyGate(
      ["alpha", "bravo"],
      statusMap({ alpha: "COMPLETED", bravo: "COMPLETED" }),
    );

    expect(gate.ready).toBe(true);
  });

  it("まだ回っている依存は pending にする", () => {
    const gate = dependencyGate(
      ["alpha", "bravo"],
      statusMap({ alpha: "COMPLETED", bravo: "ACTIVE" }),
    );

    expect(gate).toEqual({ ready: false, pending: ["bravo"], unreachable: [] });
  });

  it("登録されていない依存も pending にする", () => {
    // 「ent start を打ち忘れた」と「もう終わらない」は別物で、前者は待てば進む。
    // 無いことを終端と読むと、まとめて宣言してから順に start する使い方が壊れる。
    const gate = dependencyGate(["alpha"], statusMap({}));

    expect(gate).toEqual({ ready: false, pending: ["alpha"], unreachable: [] });
  });

  it("人間待ちの依存も pending にする", () => {
    const gate = dependencyGate(["alpha"], statusMap({ alpha: "WAITING_HUMAN" }));

    expect(gate.pending).toEqual(["alpha"]);
  });

  it("終端だが COMPLETED でない依存は unreachable にする", () => {
    // 待っても解けない。pending に畳むと、永久に終わらない待ちを待ち続ける。
    expect(dependencyGate(["alpha"], statusMap({ alpha: "FAILED" }))).toEqual({
      ready: false,
      pending: [],
      unreachable: ["alpha"],
    });
    expect(dependencyGate(["alpha"], statusMap({ alpha: "ABANDONED" }))).toEqual({
      ready: false,
      pending: [],
      unreachable: ["alpha"],
    });
  });

  it("pending と unreachable が同時に出ることもある", () => {
    const gate = dependencyGate(
      ["alpha", "bravo", "charlie"],
      statusMap({ alpha: "ABANDONED", bravo: "COMPLETED", charlie: "ACTIVE" }),
    );

    expect(gate).toEqual({ ready: false, pending: ["charlie"], unreachable: ["alpha"] });
  });

  it("宣言順を保つ", () => {
    // 人間が YAML と突き合わせて読む。並べ替えると、どれを直せばよいかが探しにくい。
    const gate = dependencyGate(
      ["zulu", "alpha", "mike"],
      statusMap({ zulu: "ACTIVE", alpha: "ACTIVE", mike: "ACTIVE" }),
    );

    expect(gate.pending).toEqual(["zulu", "alpha", "mike"]);
  });
});

describe("進めない理由を人間に届ける", () => {
  it("揃っていれば理由は無い", () => {
    expect(describeDependencyGate(dependencyGate([], statusMap({})))).toBeNull();
  });

  it("待っている依存の id を名指しする", () => {
    const reason = describeDependencyGate(dependencyGate(["alpha"], statusMap({})));

    expect(reason).toContain("alpha");
  });

  it("終端に落ちた依存は、待っても解けないことと次の一手を書く", () => {
    // ここが人間に届く唯一の説明になる。止めた理由だけでは動きようがない。
    const reason = describeDependencyGate(
      dependencyGate(["alpha"], statusMap({ alpha: "ABANDONED" })),
    );

    expect(reason).toContain("alpha");
    expect(reason).toContain("待っても解けない");
    expect(reason).toContain("depends_on");
  });
});

describe("依存が揃うまでティックを進めない", () => {
  const NOW = new Date("2026-08-11T06:00:00.000Z");

  function goalDependingOn(dependsOn: readonly string[]): Goal {
    return goalSchema.parse(goalYaml({ id: "downstream", depends_on: [...dependsOn] }));
  }

  function dependency(id: string): Goal {
    return goalSchema.parse(goalYaml({ id }));
  }

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

  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function activate(goal: Goal, status: GoalStatus = "ACTIVE"): void {
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, status, null, NOW.toISOString());
  }

  it("依存が COMPLETED でなければ回さない", async () => {
    const goal = goalDependingOn(["upstream"]);
    activate(goal);
    activate(dependency("upstream"));

    const result = await tick(goal, deps(store));

    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("upstream");
    // 観測もしていない。reconciles は進まない。
    expect(store.getState(goal.goal.id)?.reconciles).toBe(0);
  });

  it("待っているあいだは lease を取らない", async () => {
    // 取ると、待っているだけの Goal が他のワーカーを塞ぐ。並べる本数を決めるのは
    // 呼び出し側なので、依存待ちの1本が枠を持ち続けると進める側まで回らなくなる。
    const goal = goalDependingOn(["upstream"]);
    activate(goal);
    activate(dependency("upstream"));

    await tick(goal, deps(store));

    expect(store.getState(goal.goal.id)?.leaseOwner).toBeNull();
  });

  it("依存が COMPLETED になれば回す", async () => {
    const goal = goalDependingOn(["upstream"]);
    activate(goal);
    activate(dependency("upstream"), "COMPLETED");

    expect((await tick(goal, deps(store))).ran).toBe(true);
  });

  it("depends_on が空なら、これまでどおり回る", async () => {
    const goal = goalDependingOn([]);
    activate(goal);

    expect((await tick(goal, deps(store))).ran).toBe(true);
  });

  it("依存がまだ登録されていなければ待つ", async () => {
    const goal = goalDependingOn(["not-started-yet"]);
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("not-started-yet");
  });

  it("依存が終端に落ちたら、待っても解けないことを言う", async () => {
    const goal = goalDependingOn(["upstream"]);
    activate(goal);
    activate(dependency("upstream"), "ABANDONED");

    const result = await tick(goal, deps(store));

    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("待っても解けない");
  });

  it("--dry-run でも、依存待ちなら中身を見せずに理由を返す", async () => {
    // 次のティックが進まないのだから、preview する中身も無い。
    const goal = goalDependingOn(["upstream"]);
    activate(goal);
    activate(dependency("upstream"));

    const result = await tick(goal, { ...deps(store), dryRun: true });

    expect(result.ran).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.skipped).toContain("upstream");
  });
});
