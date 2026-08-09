import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/index.js";

/**
 * DB の行が、こちらの型どおりであることを実際に確かめる。
 *
 * `node:sqlite` は行を `any` 相当で返す。これまでは `as unknown as XRow[]` で
 * 名乗らせていた。列挙の列（status / purpose / decided_by など）だけは後段で
 * zod にかけていて、そこはコメントに「列を捨てて固定値を返していたころは…」と
 * 苦労の記録が残っている。だが素の string / number 列は素通りだった。
 *
 * 素通りだと何が起きるか。列名を1つ変えると——`log_ref` を `log_path` にする、
 * のような——`LlmCall.logRef` は `z.string().min(1)` と宣言されているのに
 * `undefined` が入ったまま外へ出る。tsc も実行時も何も言わない。
 * DB のスキーマ（SCHEMA 定数）と手書きの型が別々の真実源になっていたのが原因。
 *
 * ここでは実際に列名を変えた DB を作り、読んだときに落ちることを見る。
 * 「落ちる」が正しい。読めなかった行を黙って捨てると、Fact が1件消えたことに
 * 誰も気づけない（design.md §3.1）。
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ent-store-rows-"));
  dbPath = join(dir, "goals.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 正常な DB を1つ作り、llm_calls を1件書いてから閉じる */
function seed(): void {
  const store = openStore(dbPath);
  try {
    store.upsertGoal({
      version: 1,
      goal: { id: "rows-goal", name: "サンプル", desired_state: "何かが完成している" },
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
        max_actor_runs: 1,
        max_reconciles: 1,
        max_wall_clock: "1h",
        max_consecutive_failures: 1,
        max_unchanged_reconciles: 1,
      },
    });
    store.recordLlmCall("rows-goal", {
      purpose: "decide",
      tokens: 10,
      logRef: ".goals/.state/llm/1.json",
      ok: true,
      calledAt: "2026-08-09T09:00:00.000Z",
    });
  } finally {
    store.close();
  }
}

describe("DB の行の検証", () => {
  it("正常な行はそのまま読める", () => {
    seed();

    const store = openStore(dbPath);
    try {
      const calls = store.listLlmCalls("rows-goal");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.logRef).toBe(".goals/.state/llm/1.json");
    } finally {
      store.close();
    }
  });

  it("列名が変わっていたら、undefined を通さずに落ちる", () => {
    seed();

    // 実際の壊れ方を作る。log_ref を log_path に改名すると、
    // 以前は logRef が undefined のまま LlmCall を名乗って外へ出ていた。
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE llm_calls RENAME COLUMN log_ref TO log_path");
    raw.close();

    const store = openStore(dbPath);
    try {
      expect(() => store.listLlmCalls("rows-goal")).toThrow(/DB の行が想定と違う/);
    } finally {
      store.close();
    }
  });

  it("あとから足した列が無い DB でも開ける", () => {
    // `goalRowSchema` は `abandon_reason` を必須の列として見る。migrate() が
    // 足す前の DB——Phase 2 から動き続けている実物がこれにあたる——を開いたときに
    // 列が無いままだと、`getState` が「DB の行が想定と違う」で落ちる。
    // 落ちる先は abandon だけではない。start も run も get も getState を通る。
    //
    // スキーマの主張だけ足して、足す前の経路を誰も通らないままにしない。
    seed();

    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE goals DROP COLUMN abandon_reason");
    raw.close();

    const store = openStore(dbPath);
    try {
      const state = store.getState("rows-goal");
      expect(state?.status).toBe("DRAFT");
      // 既定は null。空文字にすると「理由を書かずに降りた」と
      // 「そもそも降りていない」が同じ形になる。
      expect(state?.abandonReason).toBeNull();
    } finally {
      store.close();
    }
  });

  it("型が変わっていたら落ちる", () => {
    seed();

    // tokens に文字列が入っている状態。数値として使われるので、
    // 通すと予算の計算が黙って壊れる。
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE llm_calls SET tokens = 'ten'");
    raw.close();

    const store = openStore(dbPath);
    try {
      expect(() => store.listLlmCalls("rows-goal")).toThrow(/DB の行が想定と違う/);
    } finally {
      store.close();
    }
  });
});
