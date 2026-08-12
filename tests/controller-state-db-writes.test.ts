import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import { type Goal, goalSchema } from "../src/domain/goal.js";
import { CONTROLLER_STATE_DB_KEY } from "../src/domain/guard-rules.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * controller 自身の書き込みで関門が鳴らないこと、外からの改竄では鳴ることを、
 * **本物の状態 DB を通して**固定する（issue #62）。
 *
 * `.goals/.state/goals.db` は関門が見る保護対象でありながら、controller 自身の
 * 書き込み先でもある。ACT の窓——ベースラインを控えてから検査するまでの間——で
 * controller は必ずこの DB に書く（`startRun` / `finishRun` と lease の延長）。
 * かつて関門はこのファイルを**バイト列**で見ていたので、SQLite の WAL が自動
 * checkpoint に当たった回だけ `goals.db` の中身が動き、ACT を含むティックが
 * `ESCALATE(protected_path_touched)` で止まっていた。実装役の成果は publish されず、
 * worktree に未 commit で残る。
 *
 * **観測をバイト列から論理的な行へ移した**（`Store.guardDigest`）。関門が見るのは
 * 「この Goal に属する行の内容」で、checkpoint が走ってもファイルが再配置されても
 * 動かない。controller 自身が ACT の窓で書く分——lease の列と、そのティックで
 * 作った Run の行——だけを射影から外す。
 *
 * **この形にした一番の理由は、ここを本物の DB で書けるようになることになる。**
 * 指紋を文字列で偽装した fake で組むと、controller の書き込みが1つ増えた日に
 * 何も落ちない。本物の store を通しておけば、ACT の窓の中で説明の付かない
 * 書き込みが増えた瞬間に「controller 自身の書き込みでは止まらない」が落ちる。
 */

const NOW = new Date("2026-08-12T08:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";

function goalWith(id: string): Goal {
  return goalSchema.parse({
    version: 1,
    goal: { id, name: "サンプル", desired_state: "何かが完成している" },
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
    // 空で宣言しても、スキーマの下限が `.goals/.state/**` と `.git/**` を入れる。
    policies: { require_human_approval: ["merge"], protected_paths: [] },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 9,
    },
  });
}

interface Options {
  /** ACT の窓の中（Actor が走っているあいだ）に起きること */
  duringAct?: () => void | Promise<void>;
}

function deps(store: Store, goalId: string, options: Options = {}): ControllerDeps {
  return {
    store,
    owner: `worker-${goalId}`,
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      commit: async () => true,
      changedPaths: async () => [],
      // git が見える汚れは空にする。ここで見たいのは状態 DB だけになる。
      repoDirtyState: async () => new Map(),
      // 状態 DB はもうここには出ない。controller が store から論理ダイジェストを
      // 取り、`CONTROLLER_STATE_DB_KEY` として観測に混ぜる。
      outOfSightState: async () =>
        new Map([
          [".git/hooks/pre-push", "sha-clean"],
          [".git/config#core.hooksPath", "unset"],
        ]),
    },
    actor: {
      kind: "claude-code",
      run: async () => {
        await options.duringAct?.();
        return { exitCode: 0, logRef: "log", tokens: 10, artifacts: [] };
      },
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => undefined,
    },
    branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }) },
    llm: { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    now: () => NOW,
  };
}

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ent-state-db-"));
  mkdirSync(join(dir, ".goals", ".state"), { recursive: true });
  dbPath = join(dir, ".goals", ".state", "goals.db");
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function activate(target: Store, goal: Goal): void {
  target.upsertGoal(goal);
  target.setStatus(goal.goal.id, "ACTIVE", null, NOW.toISOString());
}

describe("controller 自身の書き込みでは止まらない", () => {
  it("ACT の窓で checkpoint が走っても ESCALATE しない", async () => {
    // issue #62 の症状そのもの。`goals.db` のバイト列が動くのは checkpoint の
    // せいで、論理的な行は1つも変わっていない。ACT の最中に checkpoint を
    // 明示的に起こして、その1点だけを再現する。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const result = await tick(
      goal,
      deps(store, goal.goal.id, {
        duringAct: () => {
          checkpoint();
        },
      }),
    );

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
    expect(result.status).toBe("ACTIVE");
  });

  it("Run の write-ahead と確定、lease の延長だけでは ESCALATE しない", async () => {
    // 射影から外しているのは lease の列と「このティックで作った Run」だけになる。
    // ACT の窓で説明の付かない書き込みが1つ増えれば、ここが落ちる。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const result = await tick(goal, deps(store, goal.goal.id));

    expect(result.decision?.action).toMatchObject({ type: "ACT" });
  });
});

describe("外からの改竄では止まる", () => {
  it("ACT 中に status を書き換えられたら ESCALATE する", async () => {
    // ここが鳴らなくなると、`UPDATE goals SET status='COMPLETED'` の1行で
    // 以降の全ティックを短絡させられる。保護を外していないことの確認になる。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const result = await tick(
      goal,
      deps(store, goal.goal.id, {
        duringAct: () => {
          tamper("UPDATE goals SET status = 'COMPLETED' WHERE id = 'state-db-goal'");
        },
      }),
    );

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
    expect(result.decision?.rationale).toContain(CONTROLLER_STATE_DB_KEY);
  });

  it("ACT 中に Run を差し込まれたら ESCALATE する", async () => {
    // 外すのは「controller 自身が作った Run」だけで、Run のテーブル全体ではない。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const result = await tick(
      goal,
      deps(store, goal.goal.id, {
        duringAct: () => {
          tamper(
            `INSERT INTO runs (goal_id, intent, actor, role, worktree, attempt, status, started_at, artifacts)
             VALUES ('state-db-goal', '偽の Run', 'claude-code', 'implement', 'w', 1, 'completed', '${NOW.toISOString()}', '[]')`,
          );
        },
      }),
    );

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
  });

  it("ACT 中に DB を消されたら ESCALATE する", async () => {
    // 開いたままのコネクションは unlink されたファイルを読み続ける。
    // 行だけを見ていると気づけないので、存在も観測に混ぜてある。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const result = await tick(
      goal,
      deps(store, goal.goal.id, {
        duringAct: () => {
          rmSync(dbPath);
        },
      }),
    );

    expect(result.decision?.action).toEqual({
      type: "ESCALATE",
      reason: "protected_path_touched",
    });
  });
});

describe("同じディレクトリで別の Goal を回しても止まらない", () => {
  it("ACT 中に別の Goal の行が増えても ESCALATE しない", async () => {
    // 2本目の ent が同じ `goals.db` に書いている状態にあたる。
    const goal = goalWith("state-db-goal");
    activate(store, goal);

    const other = openStore(dbPath);
    activate(other, goalWith("other-goal"));

    try {
      const result = await tick(
        goal,
        deps(store, goal.goal.id, {
          duringAct: () => {
            const intent: RunIntent = {
              intent: "別の Goal を進める",
              actor: "claude-code",
              role: "implement",
              worktree: "other-goal",
              attempt: 1,
              startedAt: NOW.toISOString(),
            };
            const outcome: RunOutcome = {
              status: "completed",
              finishedAt: NOW.toISOString(),
              exitCode: 0,
              logRef: "log",
              tokens: 1,
              artifacts: [],
              detail: null,
            };
            other.acquireLease("other-goal", "worker-b", new Date(NOW.getTime() + 300_000), NOW);
            other.finishRun(other.startRun("other-goal", intent), outcome);
          },
        }),
      );

      expect(result.decision?.action).toMatchObject({ type: "ACT" });
    } finally {
      other.close();
    }
  });

  it("2本のティックを同じ DB へ同時に流しても、どちらも ESCALATE しない", async () => {
    // **これはテストの中の並列で、`ent run` を2本立てたわけではない。**
    // 確かめているのは「同じ `goals.db` を共有する2つのティックが、互いの
    // 書き込みで関門を鳴らさない」の1点だけになる。git のロック競合など、
    // プロセスを分けて初めて出るものはここには出ない。
    const a = goalWith("goal-a");
    const b = goalWith("goal-b");
    activate(store, a);

    const second = openStore(dbPath);
    activate(second, b);

    // 互いの ACT の窓が重なるようにする。片方が先に閉じてしまうと、
    // 相手の書き込みが自分の窓の外へ出る。
    const started = { a: false, b: false };
    const overlap = async (side: "a" | "b"): Promise<void> => {
      started[side] = true;
      for (let i = 0; i < 200 && !(started.a && started.b); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // 相手の窓が開いているあいだに書く。
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    try {
      const [left, right] = await Promise.all([
        tick(a, deps(store, a.goal.id, { duringAct: () => overlap("a") })),
        tick(b, deps(second, b.goal.id, { duringAct: () => overlap("b") })),
      ]);

      expect(started).toEqual({ a: true, b: true });
      expect(left.decision?.action).toMatchObject({ type: "ACT" });
      expect(right.decision?.action).toMatchObject({ type: "ACT" });
    } finally {
      second.close();
    }
  });
});

/** 外から DB を書き換える。Bash を持つ Actor や、別プロセスにあたる */
function tamper(sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * WAL の内容を `goals.db` へ畳み込む。誤検知の引き金だったものを明示的に起こす。
 *
 * 実際には SQLite が閾値（既定 1000 ページ）を越えたコミットで勝手に走らせる。
 * 何回書けば越えるかはそのプロセスがそれまでに書いた量で決まるので、
 * ティックの形が同じでも鳴ったり鳴らなかったりしていた
 * （`tests/state-db-wal-checkpoint.test.ts`）。
 */
function checkpoint(): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
