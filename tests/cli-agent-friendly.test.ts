import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPayload, parseCommand, showPayload, truncationHint } from "../src/cli.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * エージェントが叩く前提で CLI が満たすべき基本条件。
 *
 * 出典は `.goals/agent-friendly-cli.yaml` が参照する gist で、ここで固定するのは
 * 2.2（構造化出力）/ 2.3（有効値を並べるエラー）/ 2.5（出力の上限）/
 * 3.1（語彙の統一）の4つにあたる。
 *
 * Command の判別タグは `show` のまま変えない。エージェントが見るのは
 * サブコマンド名であって内部のタグ名ではなく、変えると既存のテストが
 * 仕様として固定した解釈が壊れる。
 */

const AT = "2026-08-09T09:00:00.000Z";

function goalWith(id: string): Goal {
  return {
    version: 1,
    goal: { id, name: `${id} の名前`, desired_state: "何かが完成している" },
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

describe("JSON 出力の指定は --json ひとつにする（2.2 / 3.1）", () => {
  it("データを出すサブコマンドはすべて --json を受け取る", () => {
    expect(parseCommand(["list", "--json"])).toEqual({ kind: "list", json: true });
    expect(parseCommand(["get", "sample-goal", "--json"])).toEqual({
      kind: "show",
      slug: "sample-goal",
      json: true,
    });
    expect(parseCommand(["start", "sample-goal", "--json"])).toEqual({
      kind: "start",
      slug: "sample-goal",
      json: true,
    });
    expect(parseCommand(["run", "sample-goal", "--json"])).toEqual({
      kind: "run",
      slug: "sample-goal",
      json: true,
    });
  });

  it("--format=json と --output json は受け取らない。表記を増やさない", () => {
    expect(parseCommand(["list", "--format=json"]).kind).toBe("error");
    expect(parseCommand(["list", "--output", "json"]).kind).toBe("error");
  });

  it("--json を渡さないときの解釈は変えない", () => {
    // 既存の呼び出しが壊れないこと。json は指定があったときだけ入る。
    expect(parseCommand(["list"])).toEqual({ kind: "list" });
    expect(parseCommand(["get", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
    expect(parseCommand(["run", "sample-goal", "--once"])).toEqual({
      kind: "run",
      slug: "sample-goal",
    });
  });
});

describe("取得の動詞は get だけにする（3.1）", () => {
  it("get で引ける", () => {
    // 判別タグは show のまま変えない。エージェントが見るのはサブコマンド名で、
    // 内部の識別子まで追いかけると変更の範囲が無駄に広がる。
    expect(parseCommand(["get", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
  });

  it("get も slug を要求する", () => {
    expect(parseCommand(["get"]).kind).toBe("error");
  });

  it("show は残さない。同じ操作に2つ名前があること自体が摩擦になる", () => {
    const result = parseCommand(["show", "sample-goal"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      return;
    }
    // 打ち直す先が分からないと、エージェントは --help に戻る。
    expect(result.message).toContain("get");
  });
});

describe("エラーは次の一手が分かる形にする（2.3）", () => {
  it("知らないサブコマンドは受け付けられる値を並べる", () => {
    const result = parseCommand(["info", "sample-goal"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      return;
    }
    // 推測させると無駄な再試行になる。有効値の集合をその場で示す。
    for (const name of ["start", "run", "get", "list", "agent-context"]) {
      expect(result.message).toContain(name);
    }
    expect(result.message).toContain("info");
  });

  it("slug が無いエラーは具体的な例を添える", () => {
    const result = parseCommand(["run"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      return;
    }
    expect(result.message).toContain("ent run <slug>");
  });

  it("--limit が読めなければ、渡された値を添えて返す", () => {
    const result = parseCommand(["list", "--limit", "zero"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      return;
    }
    expect(result.message).toContain("--limit");
    expect(result.message).toContain("zero");
  });

  it("--limit は正の整数だけを受け取る", () => {
    expect(parseCommand(["list", "--limit", "0"]).kind).toBe("error");
    expect(parseCommand(["list", "--limit", "-1"]).kind).toBe("error");
    expect(parseCommand(["list", "--limit", "3"])).toEqual({ kind: "list", limit: 3 });
    expect(parseCommand(["get", "sample-goal", "--limit", "3"])).toEqual({
      kind: "show",
      slug: "sample-goal",
      limit: 3,
    });
  });
});

describe("出力は既定で上限を持つ（2.5）", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("list は件数を指定できる", () => {
    for (let index = 0; index < 5; index += 1) {
      store.upsertGoal(goalWith(`goal-${String(index).padStart(3, "0")}`));
    }

    expect(listPayload(store, { limit: 2 })).toHaveLength(2);
    expect(listPayload(store, { limit: 2 })[0]?.id).toBe("goal-000");
  });

  it("list は指定が無くても全件は返さない", () => {
    for (let index = 0; index < 200; index += 1) {
      store.upsertGoal(goalWith(`goal-${String(index).padStart(3, "0")}`));
    }

    const items = listPayload(store);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(200);
  });

  it("登録が少なければ、これまでどおり全件を id の昇順で返す", () => {
    store.upsertGoal(goalWith("bravo"));
    store.upsertGoal(goalWith("alpha"));

    expect(listPayload(store).map((item) => item.id)).toEqual(["alpha", "bravo"]);
  });

  it("get の runs は既定で絞り、新しい方を残す", () => {
    const goal = goalWith("sample-goal");
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, AT);
    for (let index = 0; index < 60; index += 1) {
      store.startRun(goal.goal.id, {
        intent: `intent-${String(index).padStart(3, "0")}`,
        actor: "claude-code",
        role: "implement",
        worktree: "sample-goal",
        attempt: index + 1,
        startedAt: AT,
      });
    }

    const runs = showPayload(goal, store).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThan(60);
    // 直近の失敗を追うために読むので、落とすなら古い方から。
    expect(runs.map((run) => run.intent)).toContain("intent-059");
    expect(runs.map((run) => run.intent)).not.toContain("intent-000");
  });

  it("get は --limit で runs の件数を指定できる", () => {
    const goal = goalWith("sample-goal");
    store.upsertGoal(goal);
    for (let index = 0; index < 5; index += 1) {
      store.startRun(goal.goal.id, {
        intent: `intent-${index}`,
        actor: "claude-code",
        role: "implement",
        worktree: "sample-goal",
        attempt: index + 1,
        startedAt: AT,
      });
    }

    expect(showPayload(goal, store, { limit: 2 }).runs).toHaveLength(2);
  });

  it("切り捨てたときだけ、絞り込み方のヒントを返す", () => {
    // 「全部出た」と「途中で切れた」が同じ見た目だと、エージェントは
    // 足りない分に気づけない。
    expect(truncationHint(50, 50, "--limit")).toBeNull();
    expect(truncationHint(50, 12, "--limit")).toBeNull();

    const hint = truncationHint(50, 200, "--limit");
    expect(hint).not.toBeNull();
    expect(hint).toContain("--limit");
    expect(hint).toContain("200");
  });
});
