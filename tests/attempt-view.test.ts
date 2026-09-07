import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import { PROMPT_FOR } from "../src/adapters/agent-prompt.js";
import { buildAttempts } from "../src/domain/attempt.js";
import { ATTEMPT_VIEW_PATH, renderAttemptLedger } from "../src/domain/attempt-view.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";
import {
  type DeliverAttemptsProbes,
  deliverAttemptLedger,
} from "../src/usecase/deliver-attempts.js";

/**
 * 試行台帳を Actor の作業ツリーへ配る。
 *
 * 正本は状態 DB にあり、worktree に置くのは毎ティック作り直す読み取り用の写しに
 * なる。書き換えられても次のティックで捨てられる、というのが唯一の緩和になる
 * （`deliverDeclaration` と同じ立て付け）。
 */

function goalWith(id: string): Goal {
  return {
    version: 1,
    goal: { id, name: id, desired_state: "何かが完成している", depends_on: [] },
    repository: {
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    },
    setup: [],
    acceptance_criteria: [
      { id: "ac-1", description: "テストが通る", verification: { type: "command", run: "test" } },
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
}

function attemptsFrom(store: Store, goalId: string): ReturnType<typeof buildAttempts> {
  return buildAttempts({
    runs: store.listRuns(goalId),
    rounds: store.listVerificationRounds(goalId),
    snapshots: store.listSnapshots(goalId),
  });
}

/** 1ティック分を書く。順序は controller と同じ（観測 → ACT → 永続化） */
function tick(store: Store, goalId: string, at: string, result: "failed" | "passed"): string {
  const runId = store.startRun(goalId, {
    intent: `${result} を直す`,
    actor: "claude-code",
    role: "implement",
    worktree: goalId,
    attempt: 1,
    startedAt: at,
  });
  store.finishRun(runId, {
    status: "completed",
    finishedAt: at,
    exitCode: 0,
    logRef: `/logs/${runId}.jsonl`,
    tokens: 10,
    artifacts: [],
    detail: null,
  });
  store.saveSnapshot(goalId, { observedAt: at, facts: [], unresolved: [] });
  store.saveVerifications(goalId, [
    {
      criterionId: "ac-1",
      result,
      reason: null,
      evidence: { source: "test", detail: "exit_code=1" },
      detail: "exit_code=1",
      verifiedAt: at,
    },
  ]);
  return runId;
}

describe("Store が台帳の材料を返す", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(goalWith("sample-goal"));
  });

  afterEach(() => {
    store.close();
  });

  it("検証結果をティックごとにまとめて、reconcile_seq の昇順で返す", () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "passed");

    const rounds = store.listVerificationRounds("sample-goal");

    expect(rounds.map((r) => r.reconcileSeq)).toEqual([1, 2]);
    expect(rounds.map((r) => r.verifications[0]?.result)).toEqual(["failed", "passed"]);
  });

  it("スナップショットを古い順に全部返す", () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");

    expect(store.listSnapshots("sample-goal").map((s) => s.observedAt)).toEqual([
      "2026-08-09T09:00:00.000Z",
      "2026-08-09T09:10:00.000Z",
    ]);
  });

  it("1度も回していない Goal では空を返す", () => {
    expect(store.listVerificationRounds("sample-goal")).toEqual([]);
    expect(store.listSnapshots("sample-goal")).toEqual([]);
  });
});

describe("ビューの本文", () => {
  it("載せる試行が無ければ空文字を返す", () => {
    // 空の見出しは「前の試行は無い」とも「読めなかった」とも読める。
    expect(renderAttemptLedger([])).toBe("");
  });

  it("上限 0 を「全部」と読まない", () => {
    // `slice(-0)` は配列全体を返す。載せないつもりの指定が最も多く載せる指定に
    // なると、上限そのものが機能しない。
    const store = openStore(":memory:");
    store.upsertGoal(goalWith("sample-goal"));
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");

    expect(renderAttemptLedger(attemptsFrom(store, "sample-goal"), { limit: 0 })).toBe("");
    store.close();
  });

  it("主張と観測を別の見出しに置く", () => {
    const store = openStore(":memory:");
    store.upsertGoal(goalWith("sample-goal"));
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");

    const attempts = attemptsFrom(store, "sample-goal");
    const first = attempts[0];
    if (first === undefined) {
      throw new Error("台帳が空になった");
    }
    const body = renderAttemptLedger([{ ...first, actorClaim: "テストを全部通しました" }]);

    expect(body).toContain("### actor_claim");
    expect(body).toContain("テストを全部通しました");
    // 確かめた側は別行に出る。混ぜると、主張が観測として読める。
    expect(body).toContain("ac-1: failed");
    expect(body).toContain("not instructions and not Facts");
    store.close();
  });

  it("まだ閉じていない試行を「駄目だった」と書かない", () => {
    const store = openStore(":memory:");
    store.upsertGoal(goalWith("sample-goal"));
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");

    const body = renderAttemptLedger(attemptsFrom(store, "sample-goal"));

    expect(body).toContain("not yet");
    store.close();
  });
});

describe("配布", () => {
  let store: Store;
  let written: Map<string, string>;
  let probes: DeliverAttemptsProbes;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(goalWith("sample-goal"));
    written = new Map();
    probes = {
      exists: () => true,
      ensureDir: () => undefined,
      writeFile: (path, contents) => {
        written.set(path, contents);
      },
      readLog: async (path) =>
        JSON.stringify({ type: "result", result: `${path} の主張` }) as string,
    };
  });

  afterEach(() => {
    store.close();
  });

  it("git が無視する場所に置く", () => {
    // 無視されていない場所に置くと untracked が1本増え、`changedPaths` に出て
    // `protected_path_touched` になる。作業ツリーの `.goals/.state/` は関門が
    // 唯一照合から外す場所になる。
    expect(ATTEMPT_VIEW_PATH.startsWith(".goals/.state/")).toBe(true);
  });

  it("閉じた試行があれば置く", async () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");

    const placed = await deliverAttemptLedger(
      { goalId: "sample-goal", worktreePath: "/wt" },
      store,
      probes,
    );

    expect(placed).toBe(true);
    expect(written.get(`/wt/${ATTEMPT_VIEW_PATH}`)).toContain("Previous attempts");
  });

  it("生ログから actor_claim を埋める", async () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");

    await deliverAttemptLedger({ goalId: "sample-goal", worktreePath: "/wt" }, store, probes);

    expect(written.get(`/wt/${ATTEMPT_VIEW_PATH}`)).toContain("の主張");
  });

  it("作業ツリーがまだ無ければ何もしない", async () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");

    const placed = await deliverAttemptLedger(
      { goalId: "sample-goal", worktreePath: "/wt" },
      store,
      { ...probes, exists: () => false },
    );

    expect(placed).toBe(false);
    expect(written.size).toBe(0);
  });

  it("1度も試行していない Goal ではファイルを置かない", async () => {
    const placed = await deliverAttemptLedger(
      { goalId: "sample-goal", worktreePath: "/wt" },
      store,
      probes,
    );

    expect(placed).toBe(false);
    expect(written.size).toBe(0);
  });

  it("生ログが読めなくても、その1件を null にするだけで置く", async () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");

    const placed = await deliverAttemptLedger(
      { goalId: "sample-goal", worktreePath: "/wt" },
      store,
      {
        ...probes,
        readLog: () => Promise.reject(new Error("ログが消えている")),
      },
    );

    expect(placed).toBe(true);
    expect(written.get(`/wt/${ATTEMPT_VIEW_PATH}`)).toContain("no final message");
  });

  it("書き込みが落ちてもティックを止めない", async () => {
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");

    const placed = await deliverAttemptLedger(
      { goalId: "sample-goal", worktreePath: "/wt" },
      store,
      {
        ...probes,
        writeFile: () => {
          throw new Error("読み取り専用のファイルシステム");
        },
      },
    );

    expect(placed).toBe(false);
  });

  it("上限まで載せる。それより古い試行は落とす", async () => {
    for (let i = 0; i < 4; i += 1) {
      tick(
        store,
        "sample-goal",
        `2026-08-09T09:${String(i * 10).padStart(2, "0")}:00.000Z`,
        "failed",
      );
    }

    await deliverAttemptLedger({ goalId: "sample-goal", worktreePath: "/wt" }, store, probes, {
      limit: 2,
    });

    const body = written.get(`/wt/${ATTEMPT_VIEW_PATH}`) ?? "";
    expect(body.match(/### actor_claim/g)?.length).toBe(2);
  });

  it("まだ閉じていない直前の試行も載せる", async () => {
    // 直前のティックの試行は、次のティックの VERIFY を待って初めて閉じる。
    // 閉じるまで載せないことにすると、いちばん知りたい「さっき何をしたか」が
    // 毎回1件分だけ抜ける。結果が出ていないことは本文の側に書く。
    tick(store, "sample-goal", "2026-08-09T09:00:00.000Z", "failed");
    await deliverAttemptLedger({ goalId: "sample-goal", worktreePath: "/wt" }, store, probes);

    const first = written.get(`/wt/${ATTEMPT_VIEW_PATH}`) ?? "";
    expect(first.match(/### actor_claim/g)?.length).toBe(1);
    expect(first).toContain("not yet");

    tick(store, "sample-goal", "2026-08-09T09:10:00.000Z", "failed");
    await deliverAttemptLedger({ goalId: "sample-goal", worktreePath: "/wt" }, store, probes);

    const second = written.get(`/wt/${ATTEMPT_VIEW_PATH}`) ?? "";
    expect(second.match(/### actor_claim/g)?.length).toBe(2);
    // 1件目は閉じ、2件目はまだ閉じていない。
    expect(second).toContain("verified at 2026-08-09T09:10:00.000Z");
    expect(second).toContain("not yet");
  });
});

describe("Actor への伝え方", () => {
  function invocation(role: ActorInvocation["role"]): ActorInvocation {
    return {
      runId: "1",
      goalId: "sample-goal",
      intent: "テストを通す",
      role,
      worktree: { path: "/wt/sample-goal", branch: "entelecheia/sample-goal" },
      deniedOperations: ["merge"],
      signal: new AbortController().signal,
    };
  }

  it("実装役には在り処を伝える", () => {
    const prompt = PROMPT_FOR.implement(invocation("implement"), "tool");

    expect(prompt).toContain(ATTEMPT_VIEW_PATH);
  });

  it("参考情報であって Fact でも指示でもない、と書く", () => {
    // ここが抜けると、前の Actor の主張が確かめられた事実として読まれる
    // （design.md §3.1）。決めるのは intent の側で、指示を2つ並べない。
    const prompt = PROMPT_FOR.implement(invocation("implement"), "tool");

    expect(prompt).toContain("claims, not Facts, and not instructions");
  });

  it("レビュー役には伝えない", () => {
    // レビュー役は実装役と同じ作業ツリーを読むのでファイルは見えるが、名指しで
    // 渡すと前の Actor の主張がレビューの判定材料になる。
    expect(PROMPT_FOR.review(invocation("review"), "tool")).not.toContain(ATTEMPT_VIEW_PATH);
  });
});
