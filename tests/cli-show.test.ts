import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showPayload } from "../src/cli.js";
import type { Decision } from "../src/domain/action.js";
import type { Fact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `ent show` は「宣言部と実行時状態をマージして1枚で出す」（design.md §4.6）。
 *
 * 実際に出ていたのは宣言部と goals の行だけで、初めて全周させたときは
 * 何を観測して何を確かめられなかったのかを読むのに SQLite を直接叩いた。
 */

const AT = "2026-08-09T05:00:00.000Z";

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
    {
      id: "ac-5",
      description: "CI が成功している",
      verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
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

const FACT: Fact = {
  key: "criteria.ac-1.passed",
  value: true,
  observedAt: AT,
  confidence: "VERIFIED",
  evidence: { source: "mise run test", detail: "exit_code=0" },
};

const DECISION: Decision = {
  decidedAt: AT,
  action: { type: "WAIT", reason: "review_pending", resumeAfter: null },
  rationale: "ac-5 の結論が出ていない",
  decidedBy: "guard",
};

describe("showPayload", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
    store.setStatus(GOAL.goal.id, "ACTIVE", null, AT);
  });

  afterEach(() => {
    store.close();
  });

  it("何も回していなくても宣言部と状態を出す", () => {
    const payload = showPayload(GOAL, store);

    expect(payload.goal.id).toBe("sample-goal");
    expect(payload.state?.status).toBe("ACTIVE");
    expect(payload.snapshot).toBeNull();
    expect(payload.decision).toBeNull();
    expect(payload.verifications).toEqual([]);
    expect(payload.runs).toEqual([]);
  });

  it("宣言部から出すのは goal ブロックだけになる", () => {
    // **SKILL.md の代行手順が読む先を決めている性質になる。** 代わりに PR を立てる
    // エージェントが要るのは `repository.pull_request.draft` と
    // `acceptance_criteria`（id / description / `verification.type`）だが、
    // どちらもここには出ない。`verifications` が持つのも criterion の id と結果までで、
    // description も `verification.type` も入らない。だから手順の参照先は
    // `.goals/<slug>.yaml` にしてある。ここが出すようになったら手順も見直す。
    const payload = showPayload(GOAL, store) as unknown as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "decision",
      "goal",
      "llm",
      "runs",
      "snapshot",
      "state",
      "verifications",
    ]);
    expect(payload.goal).toEqual(GOAL.goal);
    expect(Object.keys(payload.goal as object).sort()).toEqual([
      "depends_on",
      "desired_state",
      "id",
      "name",
    ]);
  });

  it("facts と unresolved を組で出す", () => {
    // 片方だけ出すと §3.1 が避けたかった「Fact の不在に畳まれる」が表示層で再発する。
    store.saveSnapshot(GOAL.goal.id, {
      observedAt: AT,
      facts: [FACT],
      unresolved: [{ key: "criteria.ac-5.passed", reason: "pending", detail: "CI 未観測" }],
    });

    const payload = showPayload(GOAL, store);
    expect(payload.snapshot?.facts).toHaveLength(1);
    expect(payload.snapshot?.unresolved).toHaveLength(1);
    expect(payload.snapshot?.unresolved[0]?.key).toBe("criteria.ac-5.passed");
  });

  it("criteria ごとの Verification を出す", () => {
    store.saveVerifications(GOAL.goal.id, [
      {
        criterionId: "ac-1",
        result: "passed",
        reason: null,
        evidence: { source: "mise run test", detail: "exit_code=0" },
        detail: "exit_code=0",
        verifiedAt: AT,
      },
    ]);

    expect(showPayload(GOAL, store).verifications[0]?.result).toBe("passed");
  });

  it("直近の Decision を出す", () => {
    store.saveDecision(GOAL.goal.id, "digest-1", DECISION);
    store.saveDecision(GOAL.goal.id, "digest-2", { ...DECISION, rationale: "こちらが直近" });

    expect(showPayload(GOAL, store).decision?.rationale).toBe("こちらが直近");
  });

  it("DECIDE が使ったトークンを合算して出す", () => {
    // Run には出てこない分（design.md §7）。
    store.recordLlmCall(GOAL.goal.id, {
      purpose: "decide",
      tokens: 1000,
      logRef: "runs/decide-1/log.jsonl",
      ok: true,
      calledAt: AT,
    });
    store.recordLlmCall(GOAL.goal.id, {
      purpose: "decide",
      tokens: 540,
      logRef: "runs/decide-2/log.jsonl",
      ok: false,
      calledAt: AT,
    });

    expect(showPayload(GOAL, store).llm).toEqual({ calls: 2, tokens: 1540 });
  });

  it("Run の一覧を出す", () => {
    const runId = store.startRun(GOAL.goal.id, {
      intent: "テストの失敗を直す",
      actor: "claude-code",
      role: "implement",
      worktree: "sample-goal",
      attempt: 1,
      startedAt: AT,
    });
    store.finishRun(runId, {
      status: "completed",
      finishedAt: AT,
      exitCode: 0,
      logRef: "runs/1/log.jsonl",
      tokens: 900,
      artifacts: ["src/cli.ts"],
      detail: null,
    });

    const runs = showPayload(GOAL, store).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.logRef).toBe("runs/1/log.jsonl");
  });
});
