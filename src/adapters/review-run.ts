import { readFile } from "node:fs/promises";
import { errorMessage } from "../domain/error-message.js";
import { PortError } from "../domain/port-error.js";
import type { Run } from "../domain/run.js";
import { finalMessageIn } from "../domain/run-log.js";
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
 * そこにある。**本文を切り出す規則は `src/domain/run-log.ts` にある。** 生ログは
 * ent 自身が書いた形なので、解析は I/O を持たない純粋な文字列処理になる。読み手が
 * 2つに増えた（もう1つは試行台帳のビューを配る usecase）ので、規則だけをドメインへ
 * 出した。ここに残すのは「どの Run を選ぶか」と「ファイルを開く」の2つになる。
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
        throw new PortError(
          "unavailable",
          `could not read the list of Runs: ${errorMessage(error)}`,
        );
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
          `Run ${run.id} of the review role has no raw-log location recorded`,
        );
      }

      const read = options.readLog ?? ((path: string) => readFile(path, "utf8"));
      let contents: string;
      try {
        contents = await read(logRef);
      } catch (error) {
        throw new PortError(
          "unavailable",
          `could not read the raw log of Run ${run.id} of the review role (${logRef}): ${errorMessage(error)}`,
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
