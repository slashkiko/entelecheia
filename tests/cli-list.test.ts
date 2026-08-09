import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPayload, parseCommand } from "../src/cli.js";
import type { Goal } from "../src/domain/goal.js";
import { openStore, type Store } from "../src/store/index.js";

/**
 * `ent list`。登録済みの Goal をまとめて見る4つ目のサブコマンド。
 *
 * 出力は JSON にする。`ent show` と同じく、検証コマンドから使えるように
 * 機械可読を保つ。
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

describe("parseCommand と list", () => {
  it("list は slug を取らない", () => {
    expect(parseCommand(["list"])).toEqual({ kind: "list" });
  });

  it("余分な引数は error", () => {
    const result = parseCommand(["list", "sample-goal"]);
    expect(result.kind).toBe("error");
  });

  it("知らないオプションは error", () => {
    expect(parseCommand(["list", "--all"]).kind).toBe("error");
  });

  it("既存のサブコマンドを壊さない", () => {
    expect(parseCommand(["get", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
    expect(parseCommand(["run", "sample-goal"])).toEqual({ kind: "run", slug: "sample-goal" });
  });
});

describe("listPayload", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("1件も登録されていなければ空配列", () => {
    expect(listPayload(store)).toEqual([]);
  });

  it("登録した Goal を id の昇順で返す", () => {
    store.upsertGoal(goalWith("bravo", "2番目"));
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.setStatus("alpha", "ACTIVE", null, AT);

    expect(listPayload(store)).toEqual([
      {
        id: "alpha",
        name: "1番目",
        status: "ACTIVE",
        reconciles: 0,
        prNumber: null,
        resumeAfter: null,
      },
      {
        id: "bravo",
        name: "2番目",
        status: "DRAFT",
        reconciles: 0,
        prNumber: null,
        resumeAfter: null,
      },
    ]);
  });

  it("JSON にできる形にする", () => {
    // 検証コマンドや jq から使う。
    store.upsertGoal(goalWith("sample-goal", "サンプル"));

    expect(() => JSON.stringify(listPayload(store))).not.toThrow();
  });
});
