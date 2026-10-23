import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionsPayload, main, parseCommand } from "../src/cli.js";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `ent decisions`。その Goal の判断を古い順に全部出す口。
 *
 * `ent get` の `decision` も `ent list` の `stopped` も直近1件しか出さない。
 * どちらも「いま誰の番か」を答えるもので、生涯に何回人間を呼んだかは答えない
 * （docs/metrics.md M6）。記録は `decisions` テーブルに残っているので、
 * 足りないのは読む口だけになる。
 *
 * **`ent get` に相乗りさせない。** あちらは宣言 YAML を読んでから状態ストアを
 * 開くので、畳んだあとに `.goals/<slug>.yaml` を消した Goal では ENOENT で落ちる。
 * 基準線の `zz-driver-boundary-probe` がその形で、あれが出した
 * `WAIT(human_review_pending)` は数える3件のひとつになる。get に載せると、
 * M6 の基準線をそのコマンドでは再現できない。読むのを状態ストアだけにする形は
 * `ent cost` が先にやっている。
 */

const SLUG = "read-the-decisions";

function goalWith(id: string): Goal {
  return {
    version: 1,
    goal: { id, name: "判断の履歴を読む", desired_state: "履歴が読める", depends_on: [] },
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

/** 通し番号を分の位に置いて、古い順が時刻の順と一致するようにする */
function escalation(index: number): Decision {
  return {
    decidedAt: `2026-08-25T13:${String(index).padStart(2, "0")}:00.000Z`,
    action: { type: "ESCALATE", reason: "protected_path_touched" },
    rationale: `${String(index)} 回目`,
    decidedBy: "guard",
  };
}

describe("引数の解釈", () => {
  it("slug を1本取る", () => {
    expect(parseCommand(["decisions", SLUG])).toEqual({ kind: "decisions", slug: SLUG });
  });

  it("--limit を受け取る", () => {
    expect(parseCommand(["decisions", SLUG, "--limit", "5"])).toEqual({
      kind: "decisions",
      slug: SLUG,
      limit: 5,
    });
  });

  it("slug が無ければ error", () => {
    expect(parseCommand(["decisions"]).kind).toBe("error");
  });

  it("知らないオプションは error", () => {
    expect(parseCommand(["decisions", SLUG, "--all"]).kind).toBe("error");
  });
});

describe("decisionsPayload", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(goalWith(SLUG));
  });

  afterEach(() => {
    store.close();
  });

  it("1件も判断していなければ空配列", () => {
    expect(decisionsPayload(SLUG, store)).toEqual([]);
  });

  it("古い順に全件返す", () => {
    for (const index of [1, 2, 3]) {
      store.saveDecision(SLUG, `digest-${String(index)}`, escalation(index));
    }

    expect(decisionsPayload(SLUG, store).map((decision) => decision.rationale)).toEqual([
      "1 回目",
      "2 回目",
      "3 回目",
    ]);
  });

  it("上限を超えたら古い方から落とす", () => {
    // 落とす向きは runs と揃える（`showPayload`）。直近の停止理由を追うために
    // 読むので、新しい方が消えると切れていることにすら気づけない。
    for (const index of [1, 2, 3]) {
      store.saveDecision(SLUG, `digest-${String(index)}`, escalation(index));
    }

    expect(decisionsPayload(SLUG, store, { limit: 2 }).map((d) => d.rationale)).toEqual([
      "2 回目",
      "3 回目",
    ]);
  });

  it("同じ理由の判断を全部残す。数えるのは読む側になる", () => {
    // `ent list` の `stopped` はこれを1件にしか見せない。M6 が数えたいのは
    // 生涯の回数なので、畳まずに列のまま出す。
    for (const index of [1, 2, 3]) {
      store.saveDecision(SLUG, `digest-${String(index)}`, escalation(index));
    }

    const escalations = decisionsPayload(SLUG, store).filter(
      (decision) =>
        decision.action.type === "ESCALATE" && decision.action.reason === "protected_path_touched",
    );

    expect(escalations).toHaveLength(3);
  });
});

describe("main() から叩く", () => {
  let cwd: string;
  let repoRoot: string;
  let stdout: string[];

  beforeEach(() => {
    cwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), "ent-decisions-"));
    process.chdir(repoRoot);

    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** 宣言 YAML は置かずに、状態ストアにだけ Goal と判断を残す */
  function seedStoreOnly(): void {
    mkdirSync(join(repoRoot, ".goals", ".state"), { recursive: true });
    const store = openStore(join(repoRoot, ".goals", ".state", "goals.db"));
    try {
      store.upsertGoal(goalWith(SLUG));
      store.saveDecision(SLUG, "digest-1", escalation(1));
      store.saveDecision(SLUG, "digest-2", {
        decidedAt: "2026-08-25T13:02:00.000Z",
        action: { type: "WAIT", reason: "human_review_pending", resumeAfter: null },
        rationale: "人間の承認を待つ",
        decidedBy: "llm",
      });
    } finally {
      store.close();
    }
  }

  it("宣言 YAML が無い Goal でも履歴を出す。ent get は同じ Goal で落ちる", async () => {
    // これがサブコマンドを分けた理由そのものになる。畳んだ Goal の宣言を消すと
    // `ent get` は ENOENT で 1 を返すが、判断は decisions テーブルに残っている。
    seedStoreOnly();

    const exitCode = await main(["decisions", SLUG]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual([
      expect.objectContaining({
        action: { type: "ESCALATE", reason: "protected_path_touched" },
      }),
      expect.objectContaining({
        action: { type: "WAIT", reason: "human_review_pending", resumeAfter: null },
      }),
    ]);
    await expect(main(["get", SLUG])).resolves.toBe(1);
  });

  it("状態ストアがまだ無ければ空配列。DB もディレクトリも作らない", async () => {
    // 1回も start していない checkout で `.goals/.state` を作らない。0件を読む
    // ためだけに DB を作る理由は無い（`ent cost` と同じ）。
    const exitCode = await main(["decisions", SLUG]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual([]);
    expect(existsSync(join(repoRoot, ".goals", ".state"))).toBe(false);
  });
});
