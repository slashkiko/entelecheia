import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 関門が状態 DB を見る単位を、**ファイルのバイト列から論理的な行へ**移す（issue #62）。
 *
 * `.goals/.state/goals.db` は関門が指紋で見る保護対象でありながら、controller 自身の
 * 書き込み先でもある。バイト列で見ているかぎり、この2つは同じ差として現れる。
 * SQLite は WAL なので、controller 自身のコミットが自動 checkpoint を起こした回だけ
 * `goals.db` の中身が動き、ACT を含むティックが `ESCALATE(protected_path_touched)` で
 * 止まっていた（`tests/state-db-wal-checkpoint.test.ts` が引き金そのものを固定する）。
 *
 * ここで固定するのは `Store.guardDigest` の性質になる。
 *
 * - **決定的**であること。同じ中身なら何度計算しても、開き直しても同じ値になる
 * - **Goal ごとに閉じている**こと。別の Goal の行がいくら増えても値が動かない。
 *   同じディレクトリで別の Goal を回す2本目の ent が、こちらの関門を鳴らさない
 * - **改竄では動く**こと。`UPDATE goals SET status='COMPLETED'` の1行で以降の
 *   全ティックを短絡させられるので、ここが鳴らなくなっては元も子もない
 * - controller 自身が ACT の窓の中で書く分——lease の列と、そのティックで作った
 *   Run の行——**だけ**が対象から外れること
 *
 * **バイト列を捨てて何を諦めたか。** 「バイト列は違うが、この Goal の論理的な行は
 * 同じ」改竄は通る。具体的には (1) 別の Goal の行の書き換え、(2) この Goal の
 * lease 列、(3) このティックで controller が作った Run の行、(4) ファイルの
 * 差し替えや破損のうち上の射影に出ないもの。代わりに1つ強くなっている。
 * **論理ダイジェストは SQLite 経由で読むので、まだ WAL にしか無い行も見える。**
 * バイト列の指紋は次の checkpoint まで見えなかった（design.md §10-6 の (g)）。
 */

const NOW = new Date("2026-08-12T08:00:00.000Z");

let dir: string;
let dbPath: string;
let store: Store;

function goalWith(id: string): Goal {
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
      max_reconciles: 10,
      max_wall_clock: "1h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 3,
    },
  };
}

const INTENT: RunIntent = {
  intent: "テストを直す",
  actor: "claude-code",
  role: "implement",
  worktree: "w",
  attempt: 1,
  startedAt: NOW.toISOString(),
};

const OUTCOME: RunOutcome = {
  status: "completed",
  finishedAt: NOW.toISOString(),
  exitCode: 0,
  logRef: "log",
  tokens: 1,
  artifacts: [],
  detail: null,
};

const FACT: Fact = {
  key: "local.branch",
  value: "main",
  observedAt: NOW.toISOString(),
  confidence: "VERIFIED",
  evidence: { source: "git", detail: "rev-parse" },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ent-digest-"));
  mkdirSync(join(dir, ".goals", ".state"), { recursive: true });
  dbPath = join(dir, ".goals", ".state", "goals.db");
  store = openStore(dbPath);
  store.upsertGoal(goalWith("goal-a"));
  store.setStatus("goal-a", "ACTIVE", null, NOW.toISOString());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("状態 DB の論理ダイジェスト", () => {
  it("同じ中身なら何度計算しても同じ値になる", () => {
    expect(store.guardDigest("goal-a")).toBe(store.guardDigest("goal-a"));
  });

  it("開き直しても同じ値になる", () => {
    // 行の順序・NULL の扱い・数値の表現がコネクションに依存していないこと。
    // ここが揺れると、関門が前後で別のものを比べることになる。
    const before = store.guardDigest("goal-a");

    const reopened = openStore(dbPath);
    try {
      expect(reopened.guardDigest("goal-a")).toBe(before);
    } finally {
      reopened.close();
    }
  });

  it("NULL と空文字を区別する", () => {
    store.setStatus("goal-a", "WAITING_EXTERNAL", null);
    const withNull = store.guardDigest("goal-a");

    store.setStatus("goal-a", "WAITING_EXTERNAL", "");

    expect(store.guardDigest("goal-a")).not.toBe(withNull);
  });

  it("この Goal の状態を書き換えると値が変わる", () => {
    // `UPDATE goals SET status='COMPLETED'` の1行で、以降の全ティックを
    // 短絡させられる。保護を外さない、がこの変更の前提になる。
    const before = store.guardDigest("goal-a");

    tamper("UPDATE goals SET status = 'COMPLETED' WHERE id = 'goal-a'");

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("この Goal の Decision を差し込むと値が変わる", () => {
    const before = store.guardDigest("goal-a");

    tamper(
      `INSERT INTO decisions (goal_id, reconcile_seq, observed_digest, action, rationale, decided_by, decided_at)
       VALUES ('goal-a', 1, 'd', '{"type":"DONE"}', '偽造', 'llm', '${NOW.toISOString()}')`,
    );

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("この Goal の Fact を書き換えると値が変わる", () => {
    // facts は goal_id を持たず snapshots 経由で辿る。射影から落ちていないこと。
    store.saveSnapshot("goal-a", { observedAt: NOW.toISOString(), facts: [FACT], unresolved: [] });
    const before = store.guardDigest("goal-a");

    tamper("UPDATE facts SET value = '\"forged\"'");

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("スキーマを足すと値が変わる", () => {
    // trigger を1つ仕込めば、以降の書き込みに任意の副作用を付けられる。
    // 行を1つも変えずに DB の振る舞いを変えられるので、スキーマも見る。
    const before = store.guardDigest("goal-a");

    tamper(
      `CREATE TRIGGER evil AFTER INSERT ON runs BEGIN UPDATE goals SET status='COMPLETED'; END`,
    );

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("DB ファイルを消すと値が変わる", () => {
    // 開いたままのコネクションは unlink されたファイルを読み続けるので、
    // 行だけを見ていると消されたことに気づけない。存在そのものも値に混ぜる。
    const before = store.guardDigest("goal-a");

    rmSync(dbPath);

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });
});

describe("Goal ごとに閉じている", () => {
  it("別の Goal を丸ごと回しても、こちらの値は変わらない", () => {
    // 同じディレクトリで2本目の ent が別の Goal を回す形にあたる。
    // ここが動くと、片方の ACT がもう片方の書き込みで止まる。
    const before = store.guardDigest("goal-a");

    const other = openStore(dbPath);
    try {
      other.upsertGoal(goalWith("goal-b"));
      other.setStatus("goal-b", "ACTIVE", null, NOW.toISOString());
      other.acquireLease("goal-b", "worker-b", new Date(NOW.getTime() + 300_000), NOW);
      other.saveSnapshot("goal-b", {
        observedAt: NOW.toISOString(),
        facts: [FACT],
        unresolved: [],
      });
      other.saveVerifications("goal-b", [
        {
          criterionId: "ac-1",
          result: "passed",
          reason: null,
          evidence: { source: "command", detail: "exit 0" },
          detail: "通った",
          verifiedAt: NOW.toISOString(),
        },
      ]);
      other.recordLlmCall("goal-b", {
        purpose: "decide",
        tokens: 10,
        logRef: "log",
        ok: true,
        calledAt: NOW.toISOString(),
      });
      for (let i = 0; i < 20; i += 1) {
        other.finishRun(other.startRun("goal-b", INTENT), OUTCOME);
      }
    } finally {
      other.close();
    }

    expect(store.guardDigest("goal-a")).toBe(before);
  });

  it("別の Goal の書き込みで goals.db のバイト列は動くが、値は変わらない", () => {
    // **「goal_id で行を分ければ済む」だけでは解けない**ことの確認になる。
    // WAL は DB ファイルに1つしか無いので、別の Goal の書き込みでも自動
    // checkpoint は起き、`goals.db` のバイト列は動く。バイト列で見ているかぎり
    // 行が分かれていても関門は鳴る。論理ダイジェストと組にして初めて、
    // Goal ごとに閉じた観測になる。
    const other = openStore(dbPath);
    other.upsertGoal(goalWith("goal-b"));
    const beforeBytes = bytesOf(dbPath);
    const before = store.guardDigest("goal-a");

    try {
      let moved = false;
      for (let i = 0; i < 5000 && !moved; i += 1) {
        other.finishRun(other.startRun("goal-b", INTENT), OUTCOME);
        moved = bytesOf(dbPath) !== beforeBytes;
      }
      expect(moved).toBe(true);
    } finally {
      other.close();
    }

    expect(store.guardDigest("goal-a")).toBe(before);
  });
});

describe("controller 自身が ACT の窓で書く分", () => {
  it("lease を延長しても値は変わらない", () => {
    const before = store.guardDigest("goal-a");

    store.acquireLease("goal-a", "worker-a", new Date(NOW.getTime() + 600_000), NOW);

    expect(store.guardDigest("goal-a")).toBe(before);
  });

  it("自分が作った Run を渡せば、その Run の前後で値は変わらない", () => {
    const before = store.guardDigest("goal-a");

    const runId = store.startRun("goal-a", INTENT);
    store.finishRun(runId, OUTCOME);

    expect(store.guardDigest("goal-a", [runId])).toBe(before);
  });

  it("渡していない Run が増えれば値が変わる", () => {
    // 自分が作った Run だけを外す。ACT の窓で誰かに Run を差し込まれたら鳴る。
    const own = store.startRun("goal-a", INTENT);
    store.finishRun(own, OUTCOME);
    const before = store.guardDigest("goal-a", [own]);

    tamper(
      `INSERT INTO runs (goal_id, intent, actor, role, worktree, attempt, status, started_at, artifacts)
       VALUES ('goal-a', '偽の Run', 'claude-code', 'implement', 'w', 1, 'completed', '${NOW.toISOString()}', '[]')`,
    );

    expect(store.guardDigest("goal-a", [own])).not.toBe(before);
  });
});

/**
 * 外から DB を書き換える。別プロセスの ent や、Bash を持つ Actor にあたる。
 *
 * `Store` は生の SQL を通さないので、テストだけ別のコネクションを開く。
 * 同じ WAL を共有するので、本体側のコネクションからも読める。
 */
function tamper(sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** `outOfSightState` がかつて見ていたもの。ファイルのバイト列そのもの */
function bytesOf(path: string): string {
  return readFileSync(path).toString("base64");
}
