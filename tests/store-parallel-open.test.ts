import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/index.js";

/**
 * 複数の ent プロセスが同じ `goals.db` を同時に開ける、の仕様。
 *
 * `openStore` は PRAGMA を1つの `exec` にまとめて流している。並びは
 * journal_mode → synchronous → busy_timeout → foreign_keys で、**busy_timeout が
 * journal_mode より後ろにある**。journal_mode を WAL に変える操作は排他ロックを
 * 要求するので、他のプロセスが書いている最中に開くと、busy_timeout がまだ 0 の
 * まま SQLITE_BUSY を受け取り、待たずにその場で throw する。
 *
 * 実測（`.goals/.state/` を消した状態から probe を4プロセス同時に起動、3試行）:
 *
 *   trial 1: 3/4 が `database is locked` で異常終了
 *   trial 2: 2/4 が同上
 *   trial 3: 0/4（この試行だけ WAL への変換が競合しなかった）
 *
 * busy_timeout を journal_mode より前に置いた版では 12/12 が完走した。
 * つまり `ent run` を並列に叩くと、DB がまだ WAL になっていない間は
 * 高い確率でプロセスが exit 1 で落ちる。ティックが1周もしないので、
 * lease もスキップの記録も残らない。
 *
 * WAL に**なった後**は同時書き込みで壊れない（同じ probe で 12/12 完走、
 * 欠損なし）。塞ぐべきはここ1点で、並行制御そのものではない。
 *
 * このテストが縛るのは「掴まれていても待って開ける」ことだけで、直し方は問わない。
 * ただし WAL をやめる形では通らないようにしてある（design.md §4.7）。
 */

const FIXTURE = join(import.meta.dirname, "fixtures", "hold-db-lock.mjs");

/** 子プロセスがロックを握るまで待つ。握る前に開くとテストが素通りする */
function holdLock(dbPath: string, holdMs: number): Promise<() => void> {
  const child = spawn(process.execPath, [FIXTURE, dbPath, String(holdMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) {
        resolve(() => child.kill());
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(new Error(`ロックを握る子プロセスが先に終了した: exit=${code}`));
    });
  });
}

describe("同じ DB を複数プロセスが同時に開く", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ent-parallel-open-"));
    dbPath = join(dir, "goals.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("他のプロセスが掴んでいる DB でも、離されるまで待って開ける", async () => {
    // 400ms 握らせる。今の実装は待たずに `database is locked` で throw する。
    const release = await holdLock(dbPath, 400);

    try {
      const store = openStore(dbPath);
      // 開けたなら使える。スキーマも用意されている。
      expect(store.listGoals()).toEqual([]);
      store.close();
    } finally {
      release();
    }
  }, 15_000);

  it("待って開いた後も WAL のままにする", async () => {
    // busy_timeout を諦めて journal_mode を落とす、という直し方を通さない。
    // 「複数リーダー + 単一ライター」は design.md §4.7 の前提で、
    // ここを外すと同時に開ける代わりに同時に書けなくなる。
    const release = await holdLock(dbPath, 400);

    try {
      const store = openStore(dbPath);
      store.close();
    } finally {
      release();
    }

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    db.close();
  }, 15_000);

  it("掴まれていない DB は今までどおり開ける", async () => {
    // 待ちを足したせいで、単独で開く経路が遅くなったり壊れたりしない。
    const store = openStore(dbPath);
    expect(store.listGoals()).toEqual([]);
    store.close();

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    db.close();
  });
});
