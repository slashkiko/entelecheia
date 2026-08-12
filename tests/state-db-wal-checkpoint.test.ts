import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * controller 自身の書き込みが `goals.db` の中身を動かす条件を固定する（issue #62）。
 *
 * 関門は `.goals/.state/goals.db` を**中身の指紋**で見る（`outOfSightState`）。
 * 一方その DB は controller 自身の書き込み先で、ACT の窓——ベースラインを控えて
 * から検査するまで——の中でも `startRun` / `finishRun` と lease の延長が走る。
 *
 * SQLite は WAL なので、その書き込みは普段 `goals.db-wal` に載るだけで
 * `goals.db` の中身は1バイトも動かない。**動くのは WAL が既定の閾値
 * （1000 ページ）を越えたコミットで、自動 checkpoint が WAL の内容を
 * `goals.db` へ畳み込んだときになる。** どちらになるかは、そのプロセスが
 * それまでに書いた量で決まる。
 *
 * これが issue #62 の「同じ Goal で ACT を含むティックは他に4回あり、そちらでは
 * 鳴らなかった。条件は特定できていない」の正体にあたる。ティックの形は同じでも、
 * 書いた量が閾値を跨いだ回だけ `goals.db` の指紋が変わり、
 * `ESCALATE(protected_path_touched)` になる。
 *
 * **閾値そのものは固定しない。** SQLite の既定値に依存する数字を仕様として
 * 書くと、既定が変わった日にこのテストだけが落ちる。ここで固定するのは
 * 「1回では変わらない」「書き続ければ変わる」の2つで、その差こそが誤検知の
 * 間欠性を説明する。
 *
 * そのうえで、**同じ書き込みで論理ダイジェスト（`Store.guardDigest`）は動かない**
 * ことを最後に固定する。バイト列から論理的な行へ観測を移した理由がこれになる。
 * 詳しくは `tests/state-db-digest.test.ts`。
 */

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ent-wal-"));
  const stateDir = join(dir, ".goals", ".state");
  mkdirSync(stateDir, { recursive: true });
  dbPath = join(stateDir, "goals.db");
  store = openStore(dbPath);
  store.upsertGoal({
    version: 1,
    goal: { id: "g", name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
    repository: { provider: "github", owner: "o", name: "n", default_branch: "main" },
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
      max_actor_runs: 1,
      max_reconciles: 1,
      max_wall_clock: "1h",
      max_consecutive_failures: 1,
      max_unchanged_reconciles: 1,
    },
  });
  store.setStatus("g", "ACTIVE", null, new Date().toISOString());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** ACT のたびに controller が書く1組。write-ahead と確定になる。戻り値は Run の id */
function actRun(index: number): string {
  const intent: RunIntent = {
    intent: `テストを直す ${index}`,
    actor: "claude-code",
    role: "implement",
    worktree: "g",
    attempt: 1,
    startedAt: new Date().toISOString(),
  };
  const outcome: RunOutcome = {
    status: "completed",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    logRef: "log",
    tokens: 1,
    artifacts: [],
    detail: null,
  };
  const runId = store.startRun("g", intent);
  store.finishRun(runId, outcome);
  store.acquireLease("g", "worker-a", new Date(Date.now() + 300_000), new Date());
  return runId;
}

/**
 * `outOfSightState` と同じものを見る。あちらは sha256 を取るが、ここで問いたいのは
 * 「中身が変わったか」だけなので、指紋の作り方には依存しない形で読む。
 */
function contentOf(path: string): string {
  return readFileSync(path).toString("base64");
}

describe("状態 DB の中身が動く条件", () => {
  it("1ティック分の書き込みでは goals.db の中身は変わらない", () => {
    // 鳴らなかった4回にあたる。WAL に載るだけで本体は動かない。
    const before = contentOf(dbPath);

    actRun(0);

    expect(contentOf(dbPath)).toBe(before);
  });

  it("書き続けると、controller 自身の書き込みだけで goals.db の中身が変わる", () => {
    // 鳴った1回にあたる。触ったのは人間でも Actor でもなく controller 自身になる。
    const before = contentOf(dbPath);

    let changedAt: number | null = null;
    for (let i = 1; i <= 2000; i += 1) {
      actRun(i);
      if (contentOf(dbPath) !== before) {
        changedAt = i;
        break;
      }
    }

    expect(changedAt).not.toBeNull();
  });

  it("同じ書き込みで論理ダイジェストは動かない", () => {
    // 上の2本が示した「バイト列が動く条件」を、そのまま論理ダイジェストで測り直す。
    // controller 自身が作った Run を渡せば、checkpoint が走ろうと値は動かない。
    // ここが誤検知の消え方になる。
    const before = store.guardDigest("g");

    const own: string[] = [];
    let bytesMoved = false;
    const bytesBefore = contentOf(dbPath);
    for (let i = 1; i <= 2000 && !bytesMoved; i += 1) {
      own.push(actRun(i));
      bytesMoved = contentOf(dbPath) !== bytesBefore;
    }

    expect(bytesMoved).toBe(true);
    expect(store.guardDigest("g", own)).toBe(before);
  });
});
