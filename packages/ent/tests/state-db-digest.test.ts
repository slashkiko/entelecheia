import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import type { Store } from "../src/store/port.js";
import { encodeCell, encodeRow, openStore } from "../src/store/sqlite.js";

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

  it("この Goal の状態を書き換えると、バイト列が動かなくても値が変わる", () => {
    // `UPDATE goals SET status='COMPLETED'` の1行で、以降の全ティックを
    // 短絡させられる。保護を外さない、がこの変更の前提になる。
    //
    // **バイト列が動かないことも一緒に測る。** SQLite 経由の書き込みは WAL に
    // 載るだけで、次の checkpoint まで `goals.db` に現れない。かつての指紋は
    // ファイルを読んでいたので、この改竄をそのティックで取りこぼしえた
    // （design.md §10-6 の (g)）。論理ダイジェストは SQLite 経由で読むので、
    // まだ WAL にしか無い行も見える。ここが「バイト列を捨てて強くなった」分になる。
    const beforeBytes = bytesOf(dbPath);
    const before = store.guardDigest("goal-a");

    tamper("UPDATE goals SET status = 'COMPLETED' WHERE id = 'goal-a'");

    expect(bytesOf(dbPath)).toBe(beforeBytes);
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

  it("`sqlite_` で始まる名前は SQLite 自身が拒む", () => {
    // スキーマの節から `sqlite_%` を外しているのは、`sqlite_sequence` が最初の
    // AUTOINCREMENT な INSERT で生えるため（外さないと新しい DB の1回目の ACT が
    // 鳴る）。**そこが隠し場所にならないこと**をここで確かめる。SQLite は
    // 予約された接頭辞での作成を拒むので、この名前で trigger を仕込む経路は無い。
    expect(() =>
      tamper("CREATE TRIGGER sqlite_evil AFTER INSERT ON runs BEGIN SELECT 1; END"),
    ).toThrow(/reserved for internal use/);
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
 * 符号化そのものの性質。
 *
 * ここが崩れると、行と列が「同じ中身なら同じ値・違えば違う値」を満たさなくなる。
 * 関門はティックの前後で同じ関数を2回呼んで比べるだけなので、崩れても
 * 症状は出ない——**改竄が黙って通る**という形でしか現れない。だから単体で当てる。
 */
describe("値の符号化", () => {
  // 節・行・列の区切り。`src/store/sqlite.ts` の同名の定数と同じものになる。
  // ここで欲しいのは「この3つが符号化した先に出てこない」なので、実装から
  // export せず、確かめたい文字そのものをテスト側に書く。
  const SECTION = "\u001d";
  const ROW = "\u001e";
  const CELL = "\u001f";

  it('数値の 1 と文字列の "1" を区別する', () => {
    // 接頭辞（`d:` / `s:`）が無いと、`tokens` を 1 から '1' へ書き換えても
    // ダイジェストが動かない。
    expect(encodeCell(1)).not.toBe(encodeCell("1"));
  });

  it("NULL と空文字と 0 を区別する", () => {
    expect(new Set([encodeCell(null), encodeCell(""), encodeCell(0)]).size).toBe(3);
  });

  it("値の中に区切りを入れても、符号化した先に区切りは出てこない", () => {
    // 区切りは制御文字（U+001D 節 / U+001E 行 / U+001F 列）で、`JSON.stringify` は
    // 制御文字を必ず `\uXXXX` へ逃がす。逃がさないと、値の中身で「列がもう1つある」
    // 「行がもう1つある」を偽装して、別の中身を同じ値に落とせる。
    const forged = `a${SECTION}b${ROW}c${CELL}d`;
    const encoded = encodeCell(forged);

    expect(encoded).not.toContain(SECTION);
    expect(encoded).not.toContain(ROW);
    expect(encoded).not.toContain(CELL);
    // 逃がしたうえで、別の値は別のままであること。
    expect(encoded).not.toBe(encodeCell("abcd"));
  });

  it("区切りを跨いだ偽装が、行の連結でも成立しない", () => {
    // 「1つの列に、隣の列ごと詰め込む」形。列名も混ぜてあるので、
    // 値の側から `status=...` を生やしても本物の列とは並ばない。
    const crafted = encodeRow(
      { name: `x${CELL}status=s:"COMPLETED"`, status: "ACTIVE" },
      new Set(),
    );
    const genuine = encodeRow({ name: "x", status: "COMPLETED" }, new Set());

    expect(crafted).not.toBe(genuine);
  });

  it("bigint と Uint8Array を符号化できる", () => {
    // `node:sqlite` は 2^53 を越える INTEGER を bigint で、BLOB を Uint8Array で返す。
    // `JSON.stringify` は bigint を渡されると throw するので、文字列とは別に扱う。
    expect(encodeCell(2n ** 60n)).toBe(`i:${(2n ** 60n).toString()}`);
    expect(encodeCell(new Uint8Array([0, 15, 255]))).toBe("b:000fff");
    // 見た目が同じでも型が違えば別の値になる。
    expect(encodeCell(1n)).not.toBe(encodeCell(1));
    expect(encodeCell(new Uint8Array([1]))).not.toBe(encodeCell("01"));
  });

  it("知らない型は throw する", () => {
    // 黙って `String(value)` に落とすと、その列だけが実質的に射影から外れる。
    // 呼び出し側（controller）はこの throw を `ESCALATE(guard_unavailable)` に倒す
    // （`tests/controller-state-db-writes.test.ts`）。「確かめられなかった」を
    // 「変わっていない」にしない（design.md §3.1）。
    expect(() => encodeCell({})).toThrow(/type that cannot go into the state DB digest/);
    expect(() => encodeCell(true)).toThrow(/type that cannot go into the state DB digest/);
    expect(() => encodeCell(undefined)).toThrow(/type that cannot go into the state DB digest/);
  });

  it("列の並びが違っても、同じ中身なら同じ行になる", () => {
    // `SELECT *` の列順はスキーマの順で、`ALTER TABLE` で足した列は末尾に付く。
    // 同じ中身の DB でも、作られ方（最初から在ったか migrate で足したか）で順が
    // 変わる。**本物の2つの DB から読んだ行**で確かめる。
    const migratedPath = join(dir, "migrated.db");
    const freshPath = join(dir, "fresh.db");

    // `role` を持たない古いスキーマを手で作る。openStore の migrate が末尾に足す。
    const old = new DatabaseSync(migratedPath);
    old.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      actor TEXT NOT NULL,
      worktree TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      log_ref TEXT,
      tokens INTEGER,
      artifacts TEXT NOT NULL DEFAULT '[]',
      detail TEXT
    )`);
    old.close();

    const migrated = openStore(migratedPath);
    const fresh = openStore(freshPath);
    try {
      for (const target of [migrated, fresh]) {
        target.upsertGoal(goalWith("goal-a"));
        target.finishRun(target.startRun("goal-a", INTENT), OUTCOME);
      }

      const migratedRow = rowOf(migratedPath);
      const freshRow = rowOf(freshPath);

      // 前提。並びが同じなら、この test は何も測っていない。
      expect(Object.keys(migratedRow)).not.toEqual(Object.keys(freshRow));
      expect([...Object.keys(migratedRow)].sort()).toEqual([...Object.keys(freshRow)].sort());

      expect(encodeRow(migratedRow, new Set())).toBe(encodeRow(freshRow, new Set()));
    } finally {
      migrated.close();
      fresh.close();
    }
  });
});

describe("ファイルの差し替え", () => {
  it("同じパスに別のファイルを置かれると値が変わる", () => {
    // `rmSync` は存在で捕まるが、unlink して同じパスに別のファイルを置くと
    // `existsSync` は true を返す。開いたままのコネクションは旧 inode を読み
    // 続けるので、行にも差が出ない。inode も観測に混ぜて初めて捕まる。
    const before = store.guardDigest("goal-a");

    const replacement = join(dir, "replacement");
    writeFileSync(replacement, "別のファイル");
    rmSync(dbPath);
    renameSync(replacement, dbPath);

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });
});

/** `SELECT *` が返す1行を、列順を保ったまま取り出す */
function rowOf(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT * FROM runs ORDER BY id").get() as unknown as Record<string, unknown>;
  } finally {
    db.close();
  }
}

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
