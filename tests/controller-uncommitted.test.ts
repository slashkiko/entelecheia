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

/**
 * worktree を作れずに失敗した Run を残す。
 *
 * `act` は `worktree.ensure` より先に Run(starting) を書く（write-ahead）。
 * 「Run が1件でもあれば worktree を観測している」と読むと、この Run 1本で
 * その前提が崩れる。README にある「`git branch --format` の引用符不足で
 * worktree の作成が Phase 2 からずっと失敗していた」が実際にこの形だった。
 */
function seedFailedRun(store: Store): void {
  const runId = store.startRun(GOAL_ID, {
    intent: "criteria を満たす実装を書く",
    actor: "claude-code",
    role: "implement",
    worktree: GOAL_ID,
    attempt: 1,
    startedAt: "2026-08-09T08:00:00.000Z",
  });
  store.finishRun(runId, {
    status: "failed",
    finishedAt: "2026-08-09T08:00:10.000Z",
    exitCode: null,
    logRef: null,
    tokens: null,
    artifacts: [],
    detail: "worktree を用意できなかった: fatal: invalid reference",
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
    // リポジトリを観測する（src/wiring/index.ts の verifyRoot）。自己ホストでは人間が
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

  it("止めたティックは、観測が前のティックと同じでも PR にコメントを書く", async () => {
    // 関門が鳴っても、それが人間に届かなければ鳴っていないのと同じになる。
    //
    // 進捗コメントは既定では「観測が前のティックと同じなら書かない」。ダイジェストは
    // Fact だけから作るので Decision を含まず、止まっているあいだ観測は1文字も
    // 変わらない。黙って飛ばすと、2ティック目以降は PR が静かなまま
    // max_reconciles に当たって BLOCKED になる。
    //
    // 保護パスの関門はこの規則を既に持っている（design.md §10-6 の
    // 「PR が既にあるなら、観測が前ティックと同じでもコメントを書く」）。
    // 同じ性質を持つ関門なので、同じ扱いにする。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);
    // PR が無いとコメントの置き場所が無い。controller が既に立てた状態にする。
    store.setObserveTarget(GOAL_ID, 7, null);

    const sink = { comments: 0 };
    await tick(goal, deps(store, { dirty: true, sink }));
    const first = sink.comments;
    await tick(goal, deps(store, { dirty: true, sink }));

    expect(first).toBe(1);
    expect(sink.comments).toBe(2);
  });

  it("観測できなかったティックを、前のティックの local.dirty で止めない", async () => {
    // reconcile は前ティックの Fact を土台にして今ティックの観測で上書きするので、
    // LocalRepoPort が落ちたティックには前ティックの local.dirty が VERIFIED の
    // まま残る（陳腐化して落ちるのは github.ci.* だけ）。それを今の観測として
    // 読むと、「確かめられなかった」が「汚れている」に化ける（design.md §3.1）。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedCompletedRun(store);

    // 1ティック目: 汚れているが Gap が残っているので ACT。local.dirty=true が残る。
    await tick(goal, deps(store, { dirty: true, exitCode: 1 }));
    // 2ティック目: LocalRepoPort が落ちる。criteria は通る。
    const result = await tick(goal, deps(store, { localFails: true }));

    expect(result.decision?.action).toMatchObject({ type: "WAIT", reason: "observation_failed" });
  });

  it("worktree を観測していない dirty では止めない", async () => {
    // `verifyRoot` は worktree があればそちら、無ければ controller 自身の
    // リポジトリを見る（src/cli.ts）。「Run が1件でもあれば worktree を観測して
    // いる」は代理にならない。act は worktree.ensure より先に Run(starting) を
    // 書くので、worktree を作れずに失敗した Run が1本あるだけで破れる。
    //
    // どこを観測した値かは、同じ観測で作られる local.branch で分かる。
    const goal = goalWith([COMMAND_CRITERION]);
    activate(goal);
    seedFailedRun(store);

    const result = await tick(goal, deps(store, { dirty: true, branch: "main" }));

    expect(result.decision?.action.type).toBe("COMPLETE");
    expect(result.status).toBe("COMPLETED");
  });
});
