import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPayload } from "../src/cli.js";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { Verification } from "../src/domain/verification.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `ent list` に、Goal をまたいで「いま誰の番で、どこまで通っているか」を出す。
 *
 * いまの `ent list` は id / name / status / reconciles / prNumber / resumeAfter を
 * 返すが、**status だけでは誰の番かが決まらない。** `ESCALATE(protected_path_touched)`
 * も `WAIT(review_pending)` も同じ `WAITING_HUMAN` になる（`nextStatus`）。前者は
 * 人間が worktree を掃除しないと二度と進まず、後者は承認の1行で進む。読む側から
 * その2つが同じに見えるので、一覧を数え上げても次の一手が決まらない。
 *
 * したがってここで足すのは集計ではなく、1件あたりの手がかりになる。
 *
 *   stopped     直近の判断が WAIT / ESCALATE なら、その種別と理由。動いていれば null
 *   criteria    直近ティックの検証結果の内訳。1度も検証していなければ null
 *   lastDecidedAt  最後に判断した時刻
 *
 * **見張る主体は作らない。** design.md §7 の境界は「完了判定と暴走の停止条件を
 * LLM に決めさせない」で、監査に相当するものは既に純ロジックの関門として動いている
 * （`src/domain/guard-rules.ts` は `PROTECTED_PATH_FLOOR` の中にある）。ここが作るのは
 * その関門が出した結論を Goal をまたいで読むための材料で、判断は1つも足さない。
 *
 * 読む先は既にある Store の口（`latestVerifications` / `listDecisions`）だけにする。
 * `Store.listGoals()` の戻り値は変えない。あちらは `tests/store-list.test.ts` が
 * 仕様として固定していて、DB の1行をそのまま写す役目になっている。組み立ては
 * usecase 層（`src/usecase/inspect.ts`）が行う。
 */

const AT = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";

function goalWith(id: string, name: string): Goal {
  return {
    version: 1,
    goal: { id, name, desired_state: "何かが完成している", depends_on: [] },
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

function verification(criterionId: string, result: Verification["result"]): Verification {
  return {
    criterionId,
    result,
    reason: result === "unresolved" ? "pending" : null,
    evidence: result === "unresolved" ? null : { source: "command", detail: "exit 0" },
    detail: "検証した",
    verifiedAt: AT,
  };
}

function decision(action: Decision["action"], decidedAt: string): Decision {
  return { decidedAt, action, rationale: "そう決めた", decidedBy: "guard" };
}

describe("止まっている理由を一覧に出す", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("ESCALATE で止まった Goal は、種別と理由の両方が読める", () => {
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.saveDecision(
      "alpha",
      "digest",
      decision({ type: "ESCALATE", reason: "protected_path_touched" }, AT),
    );

    expect(listPayload(store)[0]?.stopped).toEqual({
      action: "ESCALATE",
      reason: "protected_path_touched",
    });
  });

  it("WAIT で止まった Goal も同じ形で読める", () => {
    // status はどちらも WAITING_HUMAN になるので、ここが唯一の見分けになる。
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.saveDecision(
      "alpha",
      "digest",
      decision({ type: "WAIT", reason: "review_pending", resumeAfter: null }, AT),
    );

    expect(listPayload(store)[0]?.stopped).toEqual({
      action: "WAIT",
      reason: "review_pending",
    });
  });

  it("機械側にまだやることがある判断では null にする", () => {
    // ACT / VERIFY / REPLAN / COMPLETE は「止まっている」ではない。
    // COMPLETE を止まりに数えると、終わった Goal が毎回一覧の上で人を呼ぶ。
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.saveDecision("alpha", "digest", decision({ type: "ACT", intent: "書く" }, AT));

    expect(listPayload(store)[0]?.stopped).toBeNull();
  });

  it("1度も判断していない Goal は null にする", () => {
    store.upsertGoal(goalWith("alpha", "1番目"));

    expect(listPayload(store)[0]?.stopped).toBeNull();
    expect(listPayload(store)[0]?.lastDecidedAt).toBeNull();
  });

  it("読むのは最後の判断だけにする", () => {
    // 履歴に古い ESCALATE が残っていても、次のティックで動き出していれば
    // 止まってはいない。listDecisions は古い順に返す。
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.saveDecision(
      "alpha",
      "digest",
      decision({ type: "ESCALATE", reason: "loop_detected" }, AT),
    );
    store.saveDecision("alpha", "digest", decision({ type: "ACT", intent: "直す" }, LATER));

    expect(listPayload(store)[0]?.stopped).toBeNull();
    expect(listPayload(store)[0]?.lastDecidedAt).toBe(LATER);
  });
});

describe("criteria がどこまで通っているかを一覧に出す", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("直近ティックの検証結果を3値のまま数える", () => {
    // passed / failed / unresolved を畳まない。「落ちた」と「確かめられなかった」を
    // 混ぜないのは design.md §3.1 の一番外側の約束で、一覧でも同じにする。
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.saveVerifications("alpha", [
      verification("ac-1", "passed"),
      verification("ac-2", "passed"),
      verification("ac-3", "failed"),
      verification("ac-4", "unresolved"),
    ]);

    expect(listPayload(store)[0]?.criteria).toEqual({ passed: 2, failed: 1, unresolved: 1 });
  });

  it("1度も検証していなければ null にする", () => {
    // ゼロ件を { passed: 0, failed: 0, unresolved: 0 } にすると、
    // 「まだ回していない」が「全部落ちている」と同じ見た目になる。
    store.upsertGoal(goalWith("alpha", "1番目"));

    expect(listPayload(store)[0]?.criteria).toBeNull();
  });
});

describe("読む件数を上限より増やさない", () => {
  // 並びと既存6項目と JSON 可能性は tests/cli-list.test.ts が持つ。
  // あちらが `ent list` の出力そのものの仕様で、こちらはこの Goal が足す性質を見る。
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("上限で切ったあとの分しか読みに行かない", () => {
    // 1件ごとに Store を2回引くので、上限より前に切らないと登録数に比例して
    // クエリが増える。切ってから読む順序を仕様として固定する。
    for (const id of ["alpha", "bravo", "charlie"]) {
      store.upsertGoal(goalWith(id, id));
    }

    let reads = 0;
    const counted = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "latestVerifications") {
          reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Store;

    expect(listPayload(counted, { limit: 1 })).toHaveLength(1);
    expect(reads).toBe(1);
  });
});
