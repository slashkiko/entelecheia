import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActDeps, type ActTarget, act, type WorktreePort } from "../src/act/index.js";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 関門が差分を取る相手と、worktree を切る元。
 *
 * **この2つは同じでなければならず、`repository.default_branch` とは別物になる。**
 * 関門が答えたい問いは「Actor が何を書いたか」で、`default_branch` が答えるのは
 * 「リリース先との差は何か」になる。後者を前者に流用すると、人間が呼び出し側の
 * ブランチに書いたものまで Actor の編集として並ぶ。
 *
 * 実際に踏んだ形はこう。ent は `.claude/worktrees/<name>` のような呼び出し側の
 * worktree から回す。Goal の宣言（`.goals/<slug>.yaml`）と仕様テストはそこに書く。
 * ent の worktree を `main` から切ると、その宣言は base 側に入らないので、
 * `main...HEAD` に `.goals/<slug>.yaml` が出る。`.goals/**` は
 * `PROTECTED_PATH_FLOOR` にあってどの Goal からも外せないので、Actor が何も
 * していないティックでも `ESCALATE(protected_path_touched)` になる。
 *
 * ブランチ名ではなく sha で持つ。3点表記（`base...HEAD`）は base が先に進むだけなら
 * 分岐点が動かないが、**分岐点の commit 自体を書き換えると merge-base が消える**。
 * 作業ブランチでは amend も rebase も日常的で、走行中に1回打つだけで
 * `ESCALATE(guard_unavailable)` になる。sha なら、その commit が生きている限り
 * 差分は取れる。
 */

const NOW = new Date("2026-08-10T05:00:00.000Z");
const CALLER_HEAD = "f".repeat(40);
const WORKTREE_ROOT = "/tmp/entelecheia-guard-base";

function goalFixture(id: string): Goal {
  return {
    version: 1,
    goal: { id, name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
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
    policies: { require_human_approval: [], protected_paths: [] },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 9,
    },
  };
}

describe("act が worktree を切る元", () => {
  const ensured: { name: string; base: string }[] = [];

  function deps(): ActDeps {
    const worktree: WorktreePort = {
      ensure: async (name, base) => {
        ensured.push({ name, base });
        return { path: `${WORKTREE_ROOT}/${name}`, branch: `entelecheia/${name}` };
      },
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    };
    return {
      worktree,
      actor: {
        kind: "claude-code",
        run: async () => ({ exitCode: 0, logRef: "log", tokens: 1, artifacts: [] }),
      },
      runs: { start: async () => "run-1", finish: async () => {} },
      now: () => NOW,
    };
  }

  function target(over: Partial<ActTarget> = {}): ActTarget {
    return {
      goal: goalFixture("act-base"),
      decision: {
        decidedAt: NOW.toISOString(),
        action: { type: "ACT", intent: "実装する" },
        rationale: "テスト",
        decidedBy: "llm",
      },
      attempt: 1,
      ...over,
    };
  }

  beforeEach(() => {
    ensured.length = 0;
  });

  it("base を渡せば、その commit から切る", async () => {
    await act(target({ base: CALLER_HEAD }), deps());

    expect(ensured[0]?.base).toBe(CALLER_HEAD);
  });

  it("base が無ければ default_branch から切る（記録より前に start した Goal）", async () => {
    await act(target(), deps());

    // 走行中の worktree を別の commit へ切り直すと、それまでの差分が PR から消える。
    // 古い Goal の挙動は変えない。
    expect(ensured[0]?.base).toBe("main");
  });

  it("base に null を渡しても default_branch に落ちる", async () => {
    await act(target({ base: null }), deps());

    expect(ensured[0]?.base).toBe("main");
  });
});

describe("関門が差分を取る相手", () => {
  let store: Store;
  const diffed: string[] = [];

  function deps(): ControllerDeps {
    return {
      store,
      owner: "worker-a",
      leaseSeconds: 300,
      worktreeRoot: WORKTREE_ROOT,
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
      // 0 以外にして Gap を残す。ACT に落ちないと Actor も関門も通らない。
      command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
      approval: { getApproval: async () => null },
      worktree: {
        ensure: async (name) => ({
          path: `${WORKTREE_ROOT}/${name}`,
          branch: `entelecheia/${name}`,
        }),
        commit: async () => true,
        changedPaths: async (_name, base) => {
          diffed.push(base);
          return [];
        },
        repoDirtyState: async () => new Map(),
      },
      actor: {
        kind: "claude-code",
        run: async () => ({ exitCode: 0, logRef: "log", tokens: 1, artifacts: [] }),
      },
      writer: {
        findPullRequest: async () => null,
        createPullRequest: async () => 1,
        addComment: async () => {},
      },
      branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }) },
      llm: { chooseAction: async () => ({ type: "ACT", intent: "実装する" }) },
      now: () => NOW,
    };
  }

  beforeEach(() => {
    store = openStore(":memory:");
    diffed.length = 0;
  });

  afterEach(() => {
    store.close();
  });

  it("記録した sha と比べる。default_branch は使わない", async () => {
    const goal = goalFixture("guard-base");
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    store.setGuardBase(goal.goal.id, CALLER_HEAD);

    await tick(goal, deps());

    expect(diffed).toContain(CALLER_HEAD);
    expect(diffed).not.toContain("main");
  });

  it("commit id の形をしていない記録は、default_branch に落とさず止める", async () => {
    // 状態 DB は gitignore 済みで、本体側の汚れの観測には出ない。ここを検証せずに
    // 読むと、リテラル `HEAD` を1回書き込むだけで毎ティック `diff HEAD...HEAD` が
    // 空を返し、関門が恒久的に黙る。default_branch に落とすと「基準が壊れている」が
    // 「既定で回っている」に化けるので、確かめられなかった側に倒す（design.md §3.1）。
    const goal = goalFixture("guard-base-broken");
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    store.setGuardBase(goal.goal.id, "HEAD");

    const result = await tick(goal, deps());

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "guard_unavailable",
    });
    // Actor も起動しない。1回分の予算を使ってから止まるのは無駄になる。
    expect(result.run).toBeNull();
    expect(diffed).toHaveLength(0);
  });

  it("記録が無ければ default_branch に落ちる", async () => {
    const goal = goalFixture("guard-base-legacy");
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());

    await tick(goal, deps());

    expect(diffed).toContain("main");
  });

  it("worktree を切る元と、関門が比べる相手は同じになる", async () => {
    // ここがずれると、切った元に無いものを「Actor が書いた」と読むか、
    // 逆に Actor が書いたものが差分から消える。
    const goal = goalFixture("guard-base-same");
    const ensured: string[] = [];
    store.upsertGoal(goal);
    store.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
    store.setGuardBase(goal.goal.id, CALLER_HEAD);

    const base = deps();
    await tick(goal, {
      ...base,
      worktree: {
        ...base.worktree,
        ensure: async (name, from) => {
          ensured.push(from);
          return { path: `${WORKTREE_ROOT}/${name}`, branch: `entelecheia/${name}` };
        },
      },
    });

    expect(ensured).toContain(CALLER_HEAD);
    expect(new Set([...ensured, ...diffed])).toEqual(new Set([CALLER_HEAD]));
  });
});

describe("基準の記録", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ent-guard-base-"));
    dbPath = join(dir, "goals.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): void {
    const store = openStore(dbPath);
    try {
      store.upsertGoal(goalFixture("rows-goal"));
    } finally {
      store.close();
    }
  }

  it("書いた sha がそのまま読める", () => {
    seed();
    const store = openStore(dbPath);
    try {
      expect(store.getState("rows-goal")?.guardBaseSha).toBeNull();
      store.setGuardBase("rows-goal", CALLER_HEAD);
      expect(store.getState("rows-goal")?.guardBaseSha).toBe(CALLER_HEAD);
    } finally {
      store.close();
    }
  });

  it("あとから足した列が無い DB でも開ける", () => {
    // Phase 2 から動き続けている実物の goals.db にはこの列が無い。
    // 列を足す前の DB を開いたときに getState が落ちると、start も run も get も
    // 通らなくなる（`runs.role` と `abandon_reason` で同じ形を踏んでいる）。
    seed();

    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE goals DROP COLUMN guard_base_sha");
    raw.close();

    const store = openStore(dbPath);
    try {
      // 既定は null。読む側が default_branch に落とすので、古い Goal の
      // 関門はこれまでどおり動く。
      expect(store.getState("rows-goal")?.guardBaseSha).toBeNull();
    } finally {
      store.close();
    }
  });
});
