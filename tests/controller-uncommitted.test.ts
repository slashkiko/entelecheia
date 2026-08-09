import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { LlmPort } from "../src/decide/index.js";
import type { AcceptanceCriterion, Goal } from "../src/domain/goal.js";
import { openStore, type Store } from "../src/store/index.js";

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
 * 観測する（`src/cli.ts` の `verifyRoot`）。自己ホストでは人間の編集で汚れて
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
    goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している" },
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

interface Options {
  /**
   * 作業ツリーに未 commit の変更があるか。
   *
   * `LocalRepoPort.snapshot()` の dirty がそのまま `local.dirty` の Fact になる。
   * 観測先は Goal 専用の worktree（1ティック目だけ controller 自身のリポジトリ）。
   */
  dirty?: boolean;
  /** 検証コマンドの終了コード。0 以外なら Gap が残って LLM の経路に入る */
  exitCode?: number;
  /** human の criterion を承認済みにするか */
  approved?: boolean;
  /** LLM が返す行動 */
  llm?: LlmPort;
}

function deps(store: Store, options: Options = {}): ControllerDeps {
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
        dirty: options.dirty ?? false,
      }),
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
      addComment: async () => {},
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

describe("未 commit の変更を残したまま終わらない", () => {
  it("criteria が全部通っていても、未 commit の変更があれば COMPLETE にしない", async () => {
    // これを許すと、実装が1行も push されないまま Goal が COMPLETED になる。
    // criteria が通ったのは worktree の作業ツリーであって、PR の中身ではない。
    // COMPLETED は終端なので、あとから取り消すこともできない（design.md §4.4）。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const result = await tick(goal, deps(store, { dirty: true }));

    expect(result.decision?.action.type).not.toBe("COMPLETE");
    expect(result.status).not.toBe("COMPLETED");
    expect(store.getState(GOAL_ID)?.status).not.toBe("COMPLETED");

    // 判断の材料は Fact として残っていること。これが消えると、人間が
    // `ent show` を読んでも「なぜ完了しなかったか」を追えない（design.md §3.1）。
    const dirty = (store.latestSnapshot(GOAL_ID)?.facts ?? []).find((f) => f.key === "local.dirty");
    expect(dirty?.value).toBe(true);
    expect(dirty?.confidence).toBe("VERIFIED");
  });

  it("未 commit の変更があれば、LLM の WAIT をそのまま採用しない", async () => {
    // 実際に踏んだ経路。人間の承認待ちだけが残った状態で LLM が
    // WAIT(review_pending) を返し、Goal は WAITING_HUMAN で止まった。
    // 人間が待っているのは「実装が載った PR」なので、この待ちは永久に終わらない。
    //
    // 検知した結果どう動くかは実装が決めてよい。ここで固定するのは、
    // その判断を LLM に委ねたままにしないこと（design.md §7）。
    const goal = goalWith([COMMAND_CRITERION, HUMAN_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const llm: LlmPort = {
      chooseAction: async () => ({ type: "WAIT", reason: "review_pending" }),
    };
    const result = await tick(goal, deps(store, { dirty: true, llm }));

    expect(result.decision?.action).not.toMatchObject({ type: "WAIT", reason: "review_pending" });
    expect(result.decision?.decidedBy).toBe("guard");

    // 1ティックに1行だけ書く（保護パスの関門と同じ）。差し替えたぶんを
    // 足すと、countTrailingDigest が数える行がずれる。
    const decisions = store.listDecisions(GOAL_ID);
    expect(decisions).toEqual([result.decision]);
  });

  it("作業ツリーが綺麗なら、これまでどおり COMPLETE にする", async () => {
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const result = await tick(goal, deps(store, { dirty: false }));

    expect(result.decision?.action.type).toBe("COMPLETE");
    expect(result.status).toBe("COMPLETED");
  });

  it("Actor がまだ1度も走っていないティックは、汚れていても止めない", async () => {
    // 1ティック目は worktree がまだ無いので、`local.*` は controller 自身の
    // リポジトリを観測する（src/cli.ts の verifyRoot）。自己ホストでは人間が
    // 編集中のファイルで汚れているのが普通で、それを Actor の書き残しと
    // 読むと、どの Goal も最初のティックから進まなくなる。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);

    const result = await tick(goal, deps(store, { dirty: true }));

    expect(result.decision?.action.type).toBe("COMPLETE");
    expect(result.status).toBe("COMPLETED");
  });

  it("Gap が残っているティックは、汚れていても ACT を続ける", async () => {
    // 実装の途中で作業ツリーが汚れているのは正常な状態にあたる。
    // ここまで止めると、Actor は1ティックも実装を進められない。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    const result = await tick(goal, deps(store, { dirty: true, exitCode: 1 }));

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
    expect(result.run?.status).toBe("completed");
    expect(result.status).toBe("ACTIVE");
  });
});
