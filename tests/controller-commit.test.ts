import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { LlmPort } from "../src/decide/index.js";
import type { AcceptanceCriterion, Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 未 commit のまま取り残された実装を、controller が見落とさないこと。
 *
 * Phase 3 の自己ホストで踏んだ断線をここに固定する。Actor は worktree に実装を
 * 書き切り、`mise run test` は全件緑になったが、commit していなかった。
 * push は commit 済みの差分しか送らない（`git push -u origin HEAD:<branch>`）ので、
 * remote には何も出ない。一方 VERIFY は worktree の作業ツリーを見るので criteria は
 * 通る。controller からは「ローカルの criteria は全部 passed なのに PR だけが古い」
 * に見え、DECIDE は WAIT(review_pending) を選び、Goal は WAITING_HUMAN で止まった。
 * 実装は永久に push されない。
 *
 * ここで確かめるのは1つ。**「機械側にやることが残っていない」と controller が
 * 言い切るティックで、worktree に未 commit の変更が残っていてはいけない。**
 * COMPLETE も、LLM の WAIT をそのまま採用することも、その言い切りにあたる。
 * 検知した結果どう動くか（ESCALATE するか、commit させる ACT を出すか）は
 * 実装が決めてよいので、行動の種類までは固定しない。
 *
 * 逆向きの誤り——「worktree が汚れていれば常に止める」——も同じだけ困る。
 * 実装の途中で作業ツリーが汚れているのは正常なので、Gap が残っているティックと
 * まだ Actor が1度も走っていないティックは、これまでどおり進むことを併せて固定する。
 * 1ティック目は worktree がまだ無く、`local.*` は controller 自身のリポジトリを
 * 観測する（`src/wiring/index.ts` の `verifyRoot`）。自己ホストでは人間の編集で汚れて
 * いるのが普通なので、そこを違反と読むと関門が最初のティックから鳴りっぱなしになる。
 */

const NOW = new Date("2026-08-09T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "uncommitted-goal";

const COMMAND_CRITERION: AcceptanceCriterion = {
  id: "ac-1",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

const HUMAN_CRITERION: AcceptanceCriterion = {
  id: "ac-2",
  description: "人間が確認する",
  verification: { type: "human", prompt: "差分を読んでください" },
};

function goalWith(criteria: readonly AcceptanceCriterion[]): Goal {
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
    acceptance_criteria: [...criteria],
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
}

/** commit の呼び出し記録。テストごとに beforeEach で空にする */
let commits: { name: string; message: string }[] = [];

interface Options {
  /** worktree.commit が返す値。既定は「commit した」 */
  committed?: boolean;
  /**
   * 作業ツリーに未 commit の変更があるか。
   *
   * `LocalRepoPort.snapshot()` の dirty がそのまま `local.dirty` の Fact になる。
   * 観測先は Goal 専用の worktree（1ティック目だけ controller 自身のリポジトリ）。
   */
  dirty?: boolean;
  /**
   * 観測したブランチ。既定は Goal 専用の worktree が checkout しているもの。
   *
   * `verifyRoot` が worktree に落ちなかったティックでは controller 自身の
   * リポジトリを観測するので、ここが `entelecheia/<goal.id>` にならない。
   * 「どこを観測した dirty か」はこの Fact で分かる。
   */
  branch?: string;
  /** 検証コマンドの終了コード。0 以外なら Gap が残って LLM の経路に入る */
  exitCode?: number;
  /** human の criterion を承認済みにするか */
  approved?: boolean;
  /** LocalRepoPort が落ちる。local.* の Fact は作られず unobserved に積まれる */
  localFails?: boolean;
  /** LLM が返す行動 */
  llm?: LlmPort;
  /** 通知の回数を数える。PR コメントが書かれたかを見る */
  sink?: { comments: number };
}

function deps(store: Store, options: Options = {}): ControllerDeps {
  const sink = options.sink;
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
      snapshot: async () => {
        if (options.localFails === true) {
          throw new Error("git が読めない");
        }
        return {
          branch: options.branch ?? `entelecheia/${GOAL_ID}`,
          headSha: "a".repeat(40),
          dirty: options.dirty ?? false,
        };
      },
    },
    command: {
      run: async () => ({ exitCode: options.exitCode ?? 0, stdout: "", stderr: "" }),
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
      // **ここは commit が効かなかった側を固定する。** criteria が通ったティックは
      // controller が commit するようになった（tests/controller-commit.test.ts）が、
      // 何も commit されないこと（gitignore されたファイルだけが汚れている、
      // commit そのものが失敗した）はありうる。この関門はそのときの受け皿になる。
      commit: async (name, message) => {
        commits.push({ name, message });
        return options.committed ?? true;
      },
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => {
        if (sink !== undefined) {
          sink.comments += 1;
        }
      },
    },
    // commit されていない差分は push されない。ここが実際の断線にあたる。
    branch: {
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: false }),
    },
    llm: options.llm ?? { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

/**
 * 前のティックで Actor が走り終えた状態を作る。
 *
 * 未 commit の変更を残したのは前のティックなので、検知はこのティックの Run に
 * ぶら下げられない。実際の断線でも、実装したのは1ティック目で、WAIT を選んだのは
 * 4ティック目だった。保護パスの関門（design.md §10-6）と同じく、1ティックの
 * 出来事ではなく worktree が汚れているあいだ続く状態として扱う必要がある。
 */
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
});

afterEach(() => {
  store.close();
});

function activate(goal: Goal): void {
  store.upsertGoal(goal);
  store.setStatus(GOAL_ID, "ACTIVE", null);
}

describe("機械側の criteria が通ったら controller が commit する", () => {
  beforeEach(() => {
    commits = [];
  });

  it("command 型の criteria が全部通れば commit する", async () => {
    // 「Actor が commit する」という前提を置くのをやめた（design.md §10-11）。
    // intent にもプロンプトにも書けるが、従ったことは確かめられない。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    await tick(goal, deps(store, { dirty: true }));

    expect(commits).toHaveLength(1);
  });

  it("押す木に commit する", async () => {
    // publish が押すのも実装役の木。ここがずれると、検査した木と押す木と
    // commit する木が別々になる。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    await tick(goal, deps(store, { dirty: true }));

    expect(commits[0]?.name).toBe(GOAL_ID);
  });

  it("commit したティックは未 commit の関門で止めない", async () => {
    // local.dirty は commit より前の観測なので、読むと自分が片付けた汚れで
    // 自分を止めることになる。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const result = await tick(goal, deps(store, { dirty: true }));

    expect(result.decision?.action).not.toEqual({
      type: "ESCALATE",
      reason: "uncommitted_changes",
    });
  });

  it("command 型が1本も通っていなければ commit しない", async () => {
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    await tick(goal, deps(store, { dirty: true, exitCode: 1 }));

    expect(commits).toHaveLength(0);
  });

  it("command 型の criteria が1本も無ければ commit しない", async () => {
    // 機械側で確かめたものが1つも無いのに commit すると、Actor が書いただけの
    // ものが commit 済みとして push される。
    const goal = goalWith([HUMAN_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    await tick(goal, deps(store, { dirty: true }));

    expect(commits).toHaveLength(0);
  });

  it("commit のメッセージに Goal の名前と通った criteria を書く", async () => {
    // 人間があとから履歴を読む唯一の手がかりになる。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    await tick(goal, deps(store, { dirty: true }));

    expect(commits[0]?.message).toContain(goal.goal.name);
    expect(commits[0]?.message).toContain(COMMAND_CRITERION.id);
  });

  it("何も commit されなければ、未 commit の関門はこれまでどおり効く", async () => {
    // gitignore されたファイルだけが汚れている場合や、commit そのものが
    // 失敗した場合。関門を外すのではなく、鳴る条件を1つ減らしただけにする。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const result = await tick(goal, deps(store, { dirty: true, committed: false }));

    expect(result.decision?.action.type).not.toBe("COMPLETE");
  });
});
