import { describe, expect, it } from "vitest";
import { reviewRunLog } from "../src/adapters/review-run.js";
import type { Run } from "../src/domain/run.js";

/**
 * レビュー役の結論の材料を、どの Run から取るか。
 *
 * `tests/review-observe.test.ts` は「本文をどう読むか」を固定しているが、
 * その本文が**どの実行のものか**は Port の側で決まる。ここを間違えると、
 * 読み方がどれだけ厳しくても、別の実行の出力が `review.verdict` になる。
 *
 * 固定するのは3つ。
 *
 * 1. 出どころを `role` で絞ること。`investigate` は同じツールで走るので、
 *    絞らなければ調べただけの実行から `verdict:` を拾いうる
 * 2. 完了した実行だけを読むこと。走行中・中断・失敗した実行に結論は無い
 * 3. 読めなかったときに null を返さないこと。「まだレビューを回していない」と
 *    「レビューの結果を読めなかった」を混ぜると、観測の失敗が
 *    「レビュー未実施」として静かに通る（design.md §3.1）
 */

function run(over: Partial<Run> = {}): Run {
  return {
    id: "1",
    intent: "実装を読む",
    actor: "claude-code",
    role: "review",
    worktree: "g-review",
    attempt: 1,
    startedAt: "2026-08-10T01:00:00.000Z",
    status: "completed",
    finishedAt: "2026-08-10T02:00:00.000Z",
    exitCode: 0,
    logRef: "/runs/1/log.jsonl",
    tokens: 100,
    artifacts: [],
    detail: null,
    ...over,
  };
}

/** `src/adapters/claude.ts` が書く生ログと同じ形（JSON Lines） */
function log(finalMessage: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: finalMessage }),
    "",
  ].join("\n");
}

function port(runs: Run[], logs: Record<string, string> = {}) {
  const read: string[] = [];
  return {
    read,
    review: reviewRunLog({
      listRuns: () => runs,
      readLog: async (path) => {
        read.push(path);
        const contents = logs[path];
        if (contents === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return contents;
      },
    }),
  };
}

describe("どの Run を読むか", () => {
  it("レビュー役の完了した Run の最終メッセージを返す", async () => {
    const { review } = port([run()], { "/runs/1/log.jsonl": log("verdict: approved") });

    expect(await review.latest()).toEqual({ runId: "1", finalMessage: "verdict: approved" });
  });

  it("レビュー役の Run が1件も無ければ null を返す", async () => {
    const { review } = port([run({ role: "implement" })]);

    // 「対象が無い」は取りこぼしではない。observe はこれを受けて
    // Fact も unobserved も作らない。
    expect(await review.latest()).toBeNull();
  });

  it("investigate 役の Run からは読まない", async () => {
    // プロンプトが違うので `verdict:` の行は本来出ないが、出どころの側でも塞ぐ。
    const { review } = port([run({ role: "investigate" })], {
      "/runs/1/log.jsonl": log("verdict: approved"),
    });

    expect(await review.latest()).toBeNull();
  });

  it("完了していない Run からは読まない", async () => {
    const { review } = port(
      [run({ id: "1", status: "starting" }), run({ id: "2", status: "interrupted" })],
      { "/runs/1/log.jsonl": log("verdict: approved") },
    );

    expect(await review.latest()).toBeNull();
  });

  it("複数あれば、最後に始まったレビューを読む", async () => {
    const { review } = port(
      [
        run({ id: "1", startedAt: "2026-08-10T01:00:00.000Z", logRef: "/runs/1/log.jsonl" }),
        run({ id: "2", startedAt: "2026-08-10T03:00:00.000Z", logRef: "/runs/2/log.jsonl" }),
      ],
      {
        "/runs/1/log.jsonl": log("verdict: changes_requested"),
        "/runs/2/log.jsonl": log("verdict: approved"),
      },
    );

    expect((await review.latest())?.runId).toBe("2");
  });
});

describe("読めなかったときに黙らない", () => {
  it("生ログを開けなければ throw する", async () => {
    const { review } = port([run()]);

    // null にすると「まだレビューを回していない」に化ける。observe は
    // これを port_failed として unobserved に残す。
    await expect(review.latest()).rejects.toThrow(/生ログを読めなかった/);
  });

  it("生ログの置き場所が残っていなければ throw する", async () => {
    const { review } = port([run({ logRef: null })]);

    await expect(review.latest()).rejects.toThrow(/生ログの置き場所/);
  });

  it("Run の一覧そのものを読めなければ throw する", async () => {
    const review = reviewRunLog({
      listRuns: () => {
        throw new Error("goals.db を開けない");
      },
    });

    await expect(review.latest()).rejects.toThrow(/Run の一覧を読めなかった/);
  });

  it("result の行が無い（途中で切れた）ログは空の本文として返す", async () => {
    // ここで Fact の可否を先取りしない。observe が「verdict の行を決められ
    // なかった」として pending に残す。
    const { review } = port([run()], {
      "/runs/1/log.jsonl": `${JSON.stringify({ type: "system", subtype: "init" })}\n`,
    });

    expect(await review.latest()).toEqual({ runId: "1", finalMessage: "" });
  });

  it("JSON として読めない行が混ざっていても、最後の result を拾う", async () => {
    const { review } = port([run()], {
      "/runs/1/log.jsonl": `${log("verdict: approved")}{"type":"assis`,
    });

    expect((await review.latest())?.finalMessage).toBe("verdict: approved");
  });
});
