import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { LlmCall } from "../src/domain/llm-call.js";
import type { Verification } from "../src/domain/verification.js";
import { openStore, type Store } from "../src/store/index.js";

/**
 * Verification と llm_calls の永続化。
 *
 * Verification は design.md §4.5 のテーブルで、§9 の完了判定が読む索引になる。
 * llm_calls は §4.5 の一覧には無いが、DECIDE を Actor 層経由に寄せた（§3.5）結果、
 * Run を作らない LLM 呼び出しが生まれ、そのトークンを §7 のとおり残す場所が要る。
 */

const AT = "2026-08-09T05:00:00.000Z";

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

function passed(criterionId: string): Verification {
  return {
    criterionId,
    result: "passed",
    reason: null,
    evidence: { source: "mise run test", detail: "exit_code=0" },
    detail: "exit_code=0",
    verifiedAt: AT,
  };
}

function unresolved(criterionId: string): Verification {
  return {
    criterionId,
    result: "unresolved",
    reason: "pending",
    evidence: null,
    detail: "github.ci.conclusion が観測されていない",
    verifiedAt: AT,
  };
}

const CALL: LlmCall = {
  purpose: "decide",
  tokens: 1540,
  logRef: ".goals/.state/runs/decide-2026-08-09T05-00-00-000Z-1/log.jsonl",
  ok: true,
  calledAt: AT,
};

describe("Store と Verification", () => {
  let store: Store;

  beforeEach(() => {
    // テストはファイルを残さない。
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
  });

  afterEach(() => {
    store.close();
  });

  it("criteria 単位の結果を書いて読み戻せる", () => {
    store.saveVerifications(GOAL.goal.id, [passed("ac-1"), unresolved("ac-5")]);

    expect(store.latestVerifications(GOAL.goal.id)).toEqual([passed("ac-1"), unresolved("ac-5")]);
  });

  it("書いていなければ空", () => {
    expect(store.latestVerifications(GOAL.goal.id)).toEqual([]);
  });

  it("直近のティックの分だけを返す", () => {
    // 過去のティックと混ぜると、直したはずの criteria が failed のまま見える。
    store.saveVerifications(GOAL.goal.id, [
      { ...passed("ac-1"), result: "failed", detail: "exit_code=1" },
    ]);
    store.saveSnapshot(GOAL.goal.id, { observedAt: AT, facts: [], unresolved: [] });
    store.saveVerifications(GOAL.goal.id, [passed("ac-1")]);

    const latest = store.latestVerifications(GOAL.goal.id);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.result).toBe("passed");
  });

  it("evidence が無い結果は null のまま戻る", () => {
    // 空文字にすると「evidence がある」と読めてしまう。
    store.saveVerifications(GOAL.goal.id, [unresolved("ac-5")]);

    expect(store.latestVerifications(GOAL.goal.id)[0]?.evidence).toBeNull();
  });
});

describe("Store と LLM 呼び出し", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
  });

  afterEach(() => {
    store.close();
  });

  it("トークンと生ログのパスを残す", () => {
    store.recordLlmCall(GOAL.goal.id, CALL);

    expect(store.listLlmCalls(GOAL.goal.id)).toEqual([CALL]);
  });

  it("失敗した呼び出しも残す", () => {
    // 採用できなかった応答もトークンは消費している。
    store.recordLlmCall(GOAL.goal.id, { ...CALL, ok: false, tokens: 320 });

    const calls = store.listLlmCalls(GOAL.goal.id);
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.tokens).toBe(320);
  });

  it("古い順に並ぶ", () => {
    store.recordLlmCall(GOAL.goal.id, { ...CALL, tokens: 1 });
    store.recordLlmCall(GOAL.goal.id, { ...CALL, tokens: 2 });

    expect(store.listLlmCalls(GOAL.goal.id).map((c) => c.tokens)).toEqual([1, 2]);
  });
});

describe("Store と観測ダイジェストの連続", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(GOAL);
  });

  afterEach(() => {
    store.close();
  });

  const decision = (rationale: string): Decision => ({
    decidedAt: AT,
    action: { type: "VERIFY" },
    rationale,
    decidedBy: "guard",
  });

  it("末尾から数える", () => {
    // 間に別の観測が挟まれば連続は切れる。全件を数えると、
    // 過去に同じ状態を通ったぶんまで足してしまう。
    store.saveDecision(GOAL.goal.id, "a", decision("1"));
    store.saveDecision(GOAL.goal.id, "b", decision("2"));
    store.saveDecision(GOAL.goal.id, "a", decision("3"));
    store.saveDecision(GOAL.goal.id, "a", decision("4"));

    expect(store.countTrailingDigest(GOAL.goal.id, "a")).toBe(2);
  });

  it("末尾と違うダイジェストは 0", () => {
    store.saveDecision(GOAL.goal.id, "a", decision("1"));

    expect(store.countTrailingDigest(GOAL.goal.id, "b")).toBe(0);
  });

  it("1件も無ければ 0", () => {
    expect(store.countTrailingDigest(GOAL.goal.id, "a")).toBe(0);
  });

  it("latestDigest は直近の1件を返す", () => {
    store.saveDecision(GOAL.goal.id, "a", decision("1"));
    store.saveDecision(GOAL.goal.id, "b", decision("2"));

    expect(store.latestDigest(GOAL.goal.id)).toBe("b");
  });
});
