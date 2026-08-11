import { readFile } from "node:fs/promises";
import { z } from "zod";
import { errorMessage } from "../domain/error-message.js";
import { PortError } from "../domain/port-error.js";
import type { Run } from "../domain/run.js";
import type { ReviewPort, ReviewRunSnapshot } from "../observe/index.js";

/**
 * レビュー役の Run の生ログから、最終メッセージを取り出す Adapter。
 *
 * `ActorPort` が返すのは `exitCode` / `logRef` / `artifacts` だけで、Actor の
 * 最終メッセージは戻り値に載らない。載せるには `src/act/` と `src/adapters/claude.ts`
 * の両方に口が要るが、後者は `PROTECTED_PATH_FLOOR` の中にあって触れない。
 *
 * 一方 Actor Adapter は実行イベントを1件ずつ
 * `.goals/.state/runs/<run-id>/log.jsonl` に書いており、レビュー役の最終メッセージも
 * そこにある。Claude Code は `type: "result"`、Codex は
 * `type: "item.completed"` の `agent_message` に本文を入れる。生ログの形に
 * 依存する知識はこの Adapter に閉じ込める。
 *
 * ここが返すのは「どの Run の、どの本文か」までになる。本文を Fact にしてよいかを
 * 決めるのは observe の側で、確かめられなければ Fact を作らない（design.md §3.1）。
 */

export interface ReviewRunOptions {
  /** その Goal の Run 一覧。並び順は問わない */
  listRuns: () => readonly Run[];
  /** 生ログを読む。テストから差し替える */
  readLog?: (path: string) => Promise<string>;
}

export function reviewRunLog(options: ReviewRunOptions): ReviewPort {
  return {
    latest: async (): Promise<ReviewRunSnapshot | null> => {
      // Run の一覧そのものが読めないティックは、観測の失敗になる。
      // 「まだレビューを回していない」（null）と混ぜない。
      let runs: readonly Run[];
      try {
        runs = options.listRuns();
      } catch (error) {
        throw new PortError("unavailable", `Run の一覧を読めなかった: ${errorMessage(error)}`);
      }

      const run = latestReviewRun(runs);
      if (run === null) {
        return null;
      }

      // 走ったのにログの置き場所が残っていない。読めば分かることを
      // 「レビューしていない」と読み替えないよう、失敗として上げる。
      const logRef = run.logRef;
      if (logRef === null) {
        throw new PortError(
          "unavailable",
          `レビュー役の Run ${run.id} に生ログの置き場所が残っていない`,
        );
      }

      const read = options.readLog ?? ((path: string) => readFile(path, "utf8"));
      let contents: string;
      try {
        contents = await read(logRef);
      } catch (error) {
        throw new PortError(
          "unavailable",
          `レビュー役の Run ${run.id} の生ログを読めなかった（${logRef}）: ${errorMessage(error)}`,
        );
      }

      // 本文が無い（途中で切れた Run）ときも空文字で返す。observe が
      // 「verdict の行を決められなかった」として pending に残すので、
      // ここで Fact の可否を先取りしない。
      return { runId: run.id, finalMessage: finalMessageIn(contents) ?? "" };
    },
  };
}

/**
 * 直近の、完了したレビュー役の Run。1件も無ければ null。
 *
 * **出どころを role で絞る。** `investigate` 役はレビュー役と同じツールで走るので、
 * 絞らないと調べただけの実行の本文から `verdict:` を拾いうる。プロンプトが違うので
 * 本来出ないが、出どころの側でも塞いでおく。
 *
 * 完了した Run に限るのは、走行中（starting）や中断された Run の本文を
 * 結論として読まないため。失敗した Run も同じで、そこに結論は無い。
 * 選ぶのは `startedAt` が最も新しいもので、同時刻なら一覧の後ろを採る
 * （`listRuns` は id の昇順で返る）。
 */
function latestReviewRun(runs: readonly Run[]): Run | null {
  let latest: Run | null = null;
  for (const run of runs) {
    if (run.role !== "review" || run.status !== "completed") {
      continue;
    }
    if (latest === null || run.startedAt >= latest.startedAt) {
      latest = run;
    }
  }
  return latest;
}

/** 生ログの1行。読みたいのは本文だけなので、他のフィールドは見ない */
const resultLineSchema = z.object({
  type: z.literal("result"),
  result: z.string().optional(),
});

const codexAgentMessageSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("agent_message"),
    text: z.string().optional(),
  }),
});

/**
 * JSON Lines から最終メッセージを取り出す。見つからなければ null。
 *
 * 後ろから探す。`type: "result"` は1回の実行に1件だが、壊れた行が混ざっても
 * 最後に確定した本文を採れるようにしておく。JSON として読めない行は飛ばす——
 * ログは追記で書かれるので、末尾が切れた行が残りうる。
 */
function finalMessageIn(contents: string): string | null {
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const claude = resultLineSchema.safeParse(parsed);
    if (claude.success) {
      return claude.data.result ?? null;
    }
    const codex = codexAgentMessageSchema.safeParse(parsed);
    if (codex.success) {
      return codex.data.item.text ?? null;
    }
  }
  return null;
}
