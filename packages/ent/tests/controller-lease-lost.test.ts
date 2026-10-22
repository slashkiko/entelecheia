import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * ティックの途中で lease を失ったことを検知する、の仕様。
 *
 * `acquireLease` は「取れたか」を boolean で返すが、延長する側
 * （src/controller/index.ts の heartbeat）はその戻り値を捨てている。
 * 失ったことを検知する口がどこにも無い。
 *
 * 効いてくるのは、まさに controller のコメントが書いている状況になる。
 * ACT は分単位で、leaseSeconds は 300。延長が何度か落ちれば期限は切れる。
 * 切れた lease は別のワーカーが奪えて、worktree の名前は goal.id 固定なので、
 * **同じ作業ツリーで2つの Actor が並行する**。heartbeat はその窓を狭めたが、
 * 閉じてはいない。戻り値を捨てている限り、奪われたことは構造上わからない。
 *
 * 失った側は、そのまま観測結果・検証結果・Decision・status を書き切る。
 * 書き込む先は、いま別のワーカーが進めている Goal の行になる。ダイジェストの
 * 連続（`countTrailingDigest`）も reconciles も、2つのプロセスの分が混ざる。
 *
 * 満たすべき性質:
 * - lease を失ったティックは、snapshot / verifications / decision / status を
 *   1つも書かない。書く直前に自分が持ち主かを確かめる。heartbeat の間隔より
 *   短いティックでも失いうるので、タイマーの検知だけに寄せない
 * - 失ったと分かった時点で Actor を起動しない。予算を使ってから気づいても遅い
 * - 走行中の Actor には中断を伝える。放置すると、奪ったワーカーの Actor と
 *   同じ worktree を2つのプロセスが同時に書く
 * - Run の確定だけは書いてよい。Actor は実際に走ったので、starting のまま
 *   残す方が悪い。ただし中断は failed ではなく interrupted にする
 * - 他人の lease を解放しない
 * - throw しない。`ran: false` と理由を返して次のティックに任せる
 * - lease を保っている限り、これまでどおり書く
 */

const NOW = new Date("2026-08-09T07:00:00.000Z");
/** 期限切れとみなされる時刻。奪う側はこの時計で acquireLease を呼ぶ */
const AFTER_EXPIRY = new Date(NOW.getTime() + 3_600_000);

const GOAL: Goal = {
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
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

/** 別のワーカーが、期限の切れた lease を奪う */
function steal(store: Store): void {
  store.acquireLease(
    GOAL.goal.id,
    "worker-b",
    new Date(AFTER_EXPIRY.getTime() + 300_000),
    AFTER_EXPIRY,
  );
}

function deps(store: Store, over: Partial<ControllerDeps> = {}): ControllerDeps {
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
    // 0 以外にして Gap を残す。全部通っていると guard が COMPLETE を選び、
    // ACT の経路に入らない。
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({ path: `/tmp/${name}`, branch: `entelecheia/${name}` }),
      commit: async () => true,
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
    llm: { chooseAction: async () => ({ type: "ACT", intent: "実装する" }) },
    now: () => NOW,
    ...over,
  };
}

/** 何も書かれていないこと。1行でも書けば、別のワーカーが進めている Goal を汚す */
function expectNothingWritten(store: Store): void {
  expect(store.latestSnapshot(GOAL.goal.id)).toBeNull();
  expect(store.latestVerifications(GOAL.goal.id)).toEqual([]);
  expect(store.listDecisions(GOAL.goal.id)).toEqual([]);
  expect(store.getState(GOAL.goal.id)?.reconciles).toBe(0);
  expect(store.getState(GOAL.goal.id)?.status).toBe("ACTIVE");
}

/**
 * ACT の途中で lease を奪う Actor。
 *
 * 中断が伝わればそこで返る。伝わらなければ fallbackMs（偽の時計で 200 秒）で
 * 諦めて返る。heartbeat の間隔（leaseSeconds / 2 = 150 秒）より後ろに置いて、
 * 「中断が来なかったから諦めた」と「中断が来た」を取り違えないようにする。
 */
function stealingActor(store: Store, seen: { aborted: boolean }): ControllerDeps["actor"] {
  return {
    kind: "claude-code",
    run: async (invocation) => {
      steal(store);
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener(
          "abort",
          () => {
            seen.aborted = true;
            resolve();
          },
          { once: true },
        );
        setTimeout(resolve, 200_000);
      });
      return { exitCode: 130, logRef: "log", tokens: 0, artifacts: [] };
    },
  };
}

describe("ティックの途中で lease を失う", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
    store.setStatus(GOAL.goal.id, "ACTIVE", null, NOW.toISOString());
  });

  afterEach(() => {
    store.close();
  });

  it("観測中に奪われたら、Actor を起動せず何も書かない", async () => {
    // ここは heartbeat が1度も鳴らない長さのティックになる。タイマーではなく、
    // 書く前・起動する前の確認でしか捕まえられない。
    let actorRuns = 0;

    const result = await tick(
      GOAL,
      deps(store, {
        local: {
          snapshot: async () => {
            steal(store);
            return { branch: "main", headSha: "a".repeat(40), dirty: false };
          },
        },
        actor: {
          kind: "claude-code",
          run: async () => {
            actorRuns += 1;
            return { exitCode: 0, logRef: "log", tokens: 0, artifacts: [] };
          },
        },
      }),
    );

    expect(actorRuns).toBe(0);
    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("lease");
    expectNothingWritten(store);
    // 他人の lease を解放しない。解放すると、動いている側が次のティックで弾かれる。
    expect(store.getState(GOAL.goal.id)?.leaseOwner).toBe("worker-b");
  });

  it("ACT の途中で奪われたら、Actor に中断が伝わって何も書かない", async () => {
    vi.useFakeTimers();
    try {
      const seen = { aborted: false };
      const promise = tick(GOAL, deps(store, { actor: stealingActor(store, seen) }));

      // heartbeat は leaseSeconds / 2 = 150 秒ごと。1回鳴れば奪われたと分かる。
      await vi.advanceTimersByTimeAsync(320_000);
      const result = await promise;

      expect(seen.aborted).toBe(true);
      expect(result.ran).toBe(false);
      expect(result.skipped).toContain("lease");
      expectNothingWritten(store);
      expect(store.getState(GOAL.goal.id)?.leaseOwner).toBe("worker-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("走った Actor の Run は残し、中断として確定する", async () => {
    vi.useFakeTimers();
    try {
      const seen = { aborted: false };
      const promise = tick(GOAL, deps(store, { actor: stealingActor(store, seen) }));
      await vi.advanceTimersByTimeAsync(320_000);
      await promise;

      // Actor は実際に走った。starting のまま残すと次ティックが orphan として拾う。
      // 意図して止めたものを failed にすると、再試行の上限を無駄に消費する。
      const runs = store.listRuns(GOAL.goal.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lease を保っていれば、これまでどおり書く", async () => {
    // 確認を足したせいで、通常のティックが書かなくなっていないこと。
    const result = await tick(GOAL, deps(store));

    expect(result.ran).toBe(true);
    expect(result.skipped).toBeNull();
    expect(store.latestSnapshot(GOAL.goal.id)).not.toBeNull();
    expect(store.listDecisions(GOAL.goal.id)).toHaveLength(1);
    expect(store.getState(GOAL.goal.id)?.reconciles).toBe(1);
    // 自分の lease は最後に解放する。
    expect(store.getState(GOAL.goal.id)?.leaseOwner).toBeNull();
  });
});
