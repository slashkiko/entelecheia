import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

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
  pushes: number;
}

interface Fixture {
  /** Actor の自己申告。Edit / Write / NotebookEdit だけがここに出る */
  artifacts?: string[];
  /** git が観測した変更。Bash 経由の書き込みはこちらにしか出ない */
  changed?: string[];
  /** worktree の名前ごとの変更。役割ごとに作業ツリーが分かれる場合に使う */
  changedByWorktree?: Record<string, string[]>;
  /** changedPaths が落ちる場合 */
  changedError?: Error;
  /** 本体リポジトリ側の汚れ。1件目が ACT 前、2件目が ACT 後（絶対パス → 中身の指紋） */
  repo?: [Array<[string, string]>, Array<[string, string]>];
  /** repoDirtyState が落ちる回。0 なら ACT 前、1 なら ACT 後 */
  repoErrorAt?: 0 | 1;
  /** LLM が返す行動。ACT 以外にすると Actor が走らない */
  action?: unknown;
}

function deps(store: Store, fixture: Fixture, sink: Sink): ControllerDeps {
  const artifacts = fixture.artifacts ?? [];
  // repoDirtyState は1ティックに2回呼ばれる。ACT 前と ACT 後で別の値を返す。
  let repoCalls = 0;
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
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
    // 0 以外にして Gap を残す。ACT に落ちないと Actor が走らない。
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      commit: async () => true,
      changedPaths: async (name) => {
        if (fixture.changedError !== undefined) {
          throw fixture.changedError;
        }
        if (fixture.changedByWorktree !== undefined) {
          return fixture.changedByWorktree[name] ?? [];
        }
        return fixture.changed ?? [];
      },
      repoDirtyState: async () => {
        const call = repoCalls;
        repoCalls += 1;
        if (fixture.repoErrorAt === call) {
          throw new Error("本体リポジトリを読めない");
        }
        return new Map(fixture.repo?.[call === 0 ? 0 : 1] ?? []);
      },
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
    branch: {
      push: async (name) => {
        sink.pushes += 1;
        return { branch: `entelecheia/${name}`, pushed: true };
      },
    },
    llm: {
      chooseAction: async () => fixture.action ?? { type: "ACT", intent: "テストを直す" },
    },
    now: () => NOW,
  };
}

describe("保護パスの関門", () => {
  let store: Store;
  let sink: Sink;

  beforeEach(() => {
    store = openStore(":memory:");
    sink = { comments: 0, created: 0, pushes: 0 };
  });

  afterEach(() => {
    store.close();
  });

  /** 登録して1ティック回す。2ティック目以降は register を false にする */
  const tickWith = async (goal: Goal, fixture: Fixture, register = true) => {
    if (register) {
      store.upsertGoal(goal);
      store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    }
    return tick(goal, deps(store, fixture, sink));
  };

  const run = async (goal: Goal, artifacts: string[]) => tickWith(goal, { artifacts });

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

  it("レビュー役のティックでも、実装役の作業ツリーの違反を拾う", async () => {
    // push するのは実装役の木（pushWorktree、src/publish/index.ts）なので、
    // 走った role の木だけを検査していると「検査した木」と「押す木」が別になる。
    // レビュー役は編集ツールを持たないが Bash は持つので、git -C で実装役の木を
    // 書いて commit する経路は塞がっていない。その commit はレビュー役の
    // changedPaths にも本体リポジトリ側の観測にも出ない。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      action: { type: "ACT", intent: "差分を読む", role: "review" },
      changedByWorktree: { "sample-goal": ["src/controller/index.ts"], "sample-goal-review": [] },
    });

    expect(result.decision?.action).toMatchObject({ reason: "protected_path_touched" });
    expect(result.decision?.decidedBy).toBe("guard");
  });

  it("実装役のティックでは、レビュー役の木は検査しない", async () => {
    // 走っていない役割の木まで見ると、レビュー役が残した差分で実装が止まる。
    // 押す木を必ず検査に含める、が守りたい不変条件で、その逆は要らない。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      changedByWorktree: { "sample-goal": [], "sample-goal-review": ["src/controller/index.ts"] },
    });

    expect(result.decision?.action).not.toMatchObject({ reason: "protected_path_touched" });
  });

  it("worktree の外を編集しても止める", async () => {
    const result = await run(goalWith([]), ["/repo/entelecheia/src/cli.ts"]);

    expect(result.decision?.action).toMatchObject({ reason: "protected_path_touched" });
    expect(result.decision?.rationale).toContain("outside the worktree");
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

    expect(result.decision?.rationale).toContain("original decision");
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

  it("artifacts に出ない変更でも git から検知する", async () => {
    // Bash 経由の書き込みは Edit / Write / NotebookEdit を通らないので
    // Run.artifacts に1件も現れない（design.md §10-6）。自己申告だけを
    // 検査していたころは、echo > で制御ループを書き換えても素通りした。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      artifacts: [],
      changed: ["src/controller/index.ts"],
    });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(sink.pushes).toBe(0);
  });

  it("ACT しないティックでも、worktree が汚れていれば止める", async () => {
    // 違反した編集は worktree に残す（人間が判断できるように）。
    // そのティックの Run だけを見ていると、次のティックが保護パスに
    // 触れずに終わった時点で、汚れた worktree ごと push されてしまう。
    const goal = goalWith(["src/controller/**"]);
    const result = await tickWith(goal, {
      action: { type: "VERIFY" },
      changed: ["src/controller/index.ts"],
    });

    expect(result.run).toBeNull();
    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.status).toBe("WAITING_HUMAN");
    expect(sink.pushes).toBe(0);
    expect(sink.created).toBe(0);
  });

  it("違反したティックの次も、worktree が汚れているあいだは止め続ける", async () => {
    const goal = goalWith(["src/controller/**"]);
    await tickWith(goal, { artifacts: [`${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`] });

    // 2ティック目の Actor は保護パスに触れないが、1ティック目の編集は残っている。
    const second = await tickWith(
      goal,
      { artifacts: [], changed: ["src/controller/index.ts"] },
      false,
    );

    expect(second.decision?.action).toMatchObject({ reason: "protected_path_touched" });
    expect(sink.pushes).toBe(0);
  });

  it("検査できなかったら ESCALATE(guard_unavailable)。push もしない", async () => {
    // 「触っていない」と「確かめられなかった」を混ぜない（design.md §3.1）。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      changedError: new Error("git status が落ちた"),
    });

    expect(result.decision?.action).toEqual({ type: "ESCALATE", reason: "guard_unavailable" });
    expect(result.decision?.decidedBy).toBe("guard");
    expect(sink.pushes).toBe(0);
    expect(sink.created).toBe(0);
  });

  it("worktree の外に Bash で書いても、本体リポジトリ側の git から検知する", async () => {
    // worktree の中で git を回しても、`git worktree add` で分けた本体側の
    // 作業ツリーは観測できない。Run.artifacts も Bash 経由の書き込みを拾わない。
    // つまり `bash -c 'echo > ../../src/controller/index.ts'` は、
    // artifacts にも changedPaths にも現れないまま通っていた。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      artifacts: [],
      changed: [],
      repo: [[], [["/repo/src/controller/index.ts", "sha-pwned"]]],
    });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.decision?.rationale).toContain("outside the worktree");
    expect(sink.pushes).toBe(0);
    expect(sink.created).toBe(0);
  });

  it("人間が先に汚していたファイルは違反にしない", async () => {
    // 自己ホストなので、本体リポジトリは人間の編集中のファイルで最初から汚れている。
    // それを違反と読むと関門が毎ティック鳴り、鳴りっぱなしの関門は誰も見なくなる。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      repo: [
        [["/repo/src/controller/index.ts", "sha-human"]],
        [["/repo/src/controller/index.ts", "sha-human"]],
      ],
    });

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
    expect(result.status).toBe("ACTIVE");
  });

  it("人間が編集中のファイルを Actor が上書きしたら検知する", async () => {
    // パスの集合だけで比べると、前後で同じパスが並んで差がゼロになる。
    // Actor は `git -C ../.. status` でどれが汚れているかを読めるので、
    // 「どこを上書きすれば検知されないか」を選べる状態になっていた。
    const result = await tickWith(goalWith(["src/controller/**"]), {
      repo: [
        [["/repo/src/controller/index.ts", "sha-human"]],
        [["/repo/src/controller/index.ts", "sha-pwned"]],
      ],
    });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
  });

  it("ACT 前の状態を控えられなかったら ESCALATE(guard_unavailable)", async () => {
    // 控えられていなければ「Actor が書いた分」を切り出せない。
    const result = await tickWith(goalWith([]), { repoErrorAt: 0 });

    expect(result.decision?.action).toEqual({ type: "ESCALATE", reason: "guard_unavailable" });
    expect(sink.pushes).toBe(0);
  });

  it("ACT 後の本体リポジトリを読めなかったら ESCALATE(guard_unavailable)", async () => {
    const result = await tickWith(goalWith([]), { repoErrorAt: 1 });

    expect(result.decision?.action).toEqual({ type: "ESCALATE", reason: "guard_unavailable" });
    expect(sink.pushes).toBe(0);
  });

  it("差し替えても Decision は1ティックに1行", async () => {
    // 2行入ると countTrailingDigest が同じ観測を二重に数え、
    // max_unchanged_reconciles がそのぶん早く尽きる。
    await run(goalWith(["src/controller/**"]), [
      `${WORKTREE_ROOT}/sample-goal/src/controller/index.ts`,
    ]);

    expect(store.listDecisions("sample-goal")).toHaveLength(1);
  });
});
