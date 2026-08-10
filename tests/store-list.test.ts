import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 登録済みの Goal を一覧する。
 *
 * cron から回す構成では、どの Goal が ACTIVE でどれが WAITING_HUMAN かを
 * まとめて見る手段が要る。いまは Goal ごとに ent show を叩くしかない。
 */

const AT = "2026-08-09T09:00:00.000Z";

function goalWith(id: string, name: string): Goal {
  return {
    version: 1,
    goal: { id, name, desired_state: "何かが完成している" },
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
}

describe("Store.listGoals", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("1件も登録されていなければ空", () => {
    expect(store.listGoals()).toEqual([]);
  });

  it("登録した Goal を返す", () => {
    store.upsertGoal(goalWith("sample-goal", "サンプル"));

    expect(store.listGoals()).toEqual([
      {
        id: "sample-goal",
        name: "サンプル",
        status: "DRAFT",
        reconciles: 0,
        prNumber: null,
        resumeAfter: null,
      },
    ]);
  });

  it("id の昇順に並ぶ", () => {
    // 登録順だと、どこに何があるか読むたびに変わる。
    store.upsertGoal(goalWith("charlie", "3番目"));
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.upsertGoal(goalWith("bravo", "2番目"));

    expect(store.listGoals().map((g) => g.id)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("状態と観測対象を反映する", () => {
    store.upsertGoal(goalWith("sample-goal", "サンプル"));
    store.setStatus("sample-goal", "WAITING_EXTERNAL", AT, AT);
    store.setObserveTarget("sample-goal", 12, 34);
    store.saveSnapshot("sample-goal", { observedAt: AT, facts: [], unresolved: [] });

    expect(store.listGoals()[0]).toEqual({
      id: "sample-goal",
      name: "サンプル",
      status: "WAITING_EXTERNAL",
      reconciles: 1,
      prNumber: 12,
      resumeAfter: AT,
    });
  });

  it("名前の変更が反映される", () => {
    // upsertGoal は宣言部だけを更新する。実行時状態は触らない。
    store.upsertGoal(goalWith("sample-goal", "古い名前"));
    store.setStatus("sample-goal", "ACTIVE", null, AT);
    store.upsertGoal(goalWith("sample-goal", "新しい名前"));

    const listed = store.listGoals()[0];
    expect(listed?.name).toBe("新しい名前");
    expect(listed?.status).toBe("ACTIVE");
  });
});
