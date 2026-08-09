import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import { openStore } from "../src/store/index.js";

/**
 * 行の検査が、JSON の中身まで届いていない。
 *
 * `runRowSchema` は `artifacts: z.string()` までは見る。だが読む側は
 * `JSON.parse(row.artifacts) as string[]` で、**パースした結果は誰も見ていない**。
 * `Run.artifacts` は `z.array(z.string())` と宣言されているのに、
 * オブジェクトでも数値の配列でもそのまま外へ出る。
 *
 * 列を1つ改名したときに `undefined` が素通りしたのと同じ形が、
 * ここだけ JSON の内側に残っている（tests/store-rows.test.ts の指摘）。
 * `as` を挟んだ場所は実行時に何も検査しない、というのが元の問題なので、
 * 列の名前で止まって中身で止まらないなら、直りきっていない。
 *
 * 効き先は関門になる。`Run.artifacts` は Agent が編集したパスの一覧で、
 * controller の `guardedDecision` が `findViolations` に渡す入力の1つにあたる。
 * ここに文字列でないものが混ざると、`resolve()` が投げるか、
 * 文字列化された別物を照合することになる。**関門の入力は、関門の一部になる。**
 */

const NOW = "2026-08-09T05:00:00.000Z";
const GOAL_ID = "sample-goal";

const GOAL: Goal = {
  version: 1,
  goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している" },
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

const RUN_INTENT: RunIntent = {
  intent: "テストの失敗を直す",
  actor: "claude-code",
  worktree: GOAL_ID,
  attempt: 1,
  startedAt: NOW,
};

const RUN_OUTCOME: RunOutcome = {
  status: "completed",
  finishedAt: NOW,
  exitCode: 0,
  logRef: ".goals/.state/runs/run-1/log.txt",
  tokens: 100,
  artifacts: ["src/foo.ts"],
  detail: null,
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run を1件だけ持つファイル DB を作る。列の中身を直に差し替えるため */
function seededDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ent-run-artifacts-"));
  dirs.push(dir);
  const path = join(dir, "goals.db");

  const store = openStore(path);
  store.upsertGoal(GOAL);
  store.finishRun(store.startRun(GOAL_ID, RUN_INTENT), RUN_OUTCOME);
  store.close();

  return path;
}

/** artifacts を差し替えてから listRuns を呼ぶ関数を返す */
function readAfter(artifacts: string): () => unknown {
  const path = seededDb();

  const db = new DatabaseSync(path);
  db.prepare("UPDATE runs SET artifacts = ?").run(artifacts);
  db.close();

  const store = openStore(path);
  return () => {
    try {
      return store.listRuns(GOAL_ID);
    } finally {
      store.close();
    }
  };
}

describe("artifacts は文字列の配列として読む", () => {
  it("配列でなければ throw する", () => {
    // `as string[]` はオブジェクトも通す。関門に渡る入力なので黙って流さない。
    expect(readAfter('{"not":"an array"}')).toThrow();
  });

  it("文字列でない要素が混ざっていれば throw する", () => {
    expect(readAfter("[1, 2, 3]")).toThrow();
  });

  it("null が入っていれば throw する", () => {
    expect(readAfter('["src/foo.ts", null]')).toThrow();
  });

  it("入れ子の配列も throw する", () => {
    expect(readAfter('[["src/foo.ts"]]')).toThrow();
  });

  it("JSON として壊れていれば throw する", () => {
    // 現状も JSON.parse が投げるが、直したあとも投げ続けることを固定する。
    expect(readAfter("[src/foo.ts")).toThrow();
  });
});

describe("正しい形はこれまでどおり読める", () => {
  it("文字列の配列は通る", () => {
    const read = readAfter('["src/foo.ts", "tests/foo.test.ts"]');

    expect(read()).toMatchObject([{ artifacts: ["src/foo.ts", "tests/foo.test.ts"] }]);
  });

  it("空の配列も通る", () => {
    // Actor が1つも編集しなかったティック。違反ではないので落とさない。
    const read = readAfter("[]");

    expect(read()).toMatchObject([{ artifacts: [] }]);
  });
});
