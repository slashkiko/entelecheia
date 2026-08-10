import { appendFileSync } from "node:fs";
import type { TickResult } from "../controller/index.js";
import { errorMessage } from "../domain/error-message.js";
import type { ProgressSink } from "../publish/index.js";
import { truncationHint } from "../usecase/inspect.js";
import type { ReportTarget } from "./parse.js";

/**
 * 出力の整形。ティックの結果と進捗の宛先を、人間とエージェントが読む形にする。
 *
 * stdout は JSON 専用（gist 4.3）にする。診断や切り捨ての知らせは stderr へ回す。
 */

/**
 * 宛先に書いた結果を CLI 側で控える箱。
 *
 * `publish` は `PublishResult.report` に結果を載せるが、controller はそれを
 * `TickResult` に持ち上げない（通常のティックの出力の形は変えない）。stdout に
 * 出す本文と、書けなかった理由は、ここを通して JSON にする。
 */
export interface ReportRecord {
  /** 書いた本文。宛先が stdout のときだけ JSON に載せる */
  body: string | null;
  /** 書けなかった理由。書けたなら null */
  error: string | null;
}

/**
 * 進捗の宛先を作る。`publish` はここに書くだけで、場所のことは知らない。
 *
 * ファイルは**追記**する。ティックごとの進捗は積み上がるもので、PR コメントも
 * 同じく積む。上書きにすると、cron から回したときに最後の1ティックしか残らない。
 *
 * stdout はここでは書かない。`run` の stdout は JSON 専用（gist 4.3）なので、
 * 素の Markdown を混ぜると `ent run | jq` が壊れる。本文を控えるだけにして、
 * ティックが終わってから JSON の `report.body` に入れる。
 *
 * 書けなかったら throw する。`publish` がそれを握って結果に変えるので、
 * 通知の失敗でティック全体は落ちない。ここで理由も控えるのは、controller が
 * `PublishResult` を持ち上げないため。
 *
 * 宛先の妥当性は見ない。保護パス（`.goals/**` など）を指しても止めないが、関門は
 * すり抜けない——ここに書くのはティックの最後で、関門が前後を比べるのはそれより
 * 前になる。叩いたのは人間で、Agent がこのコマンドを打つ経路も無い。
 */
export function reportSink(target: ReportTarget, record: ReportRecord): ProgressSink {
  return {
    destination: target.kind === "stdout" ? "stdout" : "file",
    write: async (body: string): Promise<void> => {
      record.body = body;
      if (target.kind === "stdout") {
        return;
      }
      try {
        appendFileSync(target.path, `${body}\n\n`);
      } catch (error) {
        record.error = errorMessage(error);
        throw error;
      }
    },
  };
}

/**
 * `--report` を付けたときだけ JSON に足す枝。
 *
 * `written` を必ず持たせる。回らなかったティック（終端・寝ている・他のワーカーが
 * 処理中）では publish を通らないので、宛先には何も書かれない。そこが読めないと、
 * ファイルが空なのが「回らなかった」からなのか「書けなかった」からなのかが
 * 区別できない。
 *
 * 本文を載せるのは stdout のときだけにする。ファイルに出したものを JSON にも
 * 積むと、同じ本文が2箇所に出る。
 */
export function reportPayload(target: ReportTarget, record: ReportRecord): unknown {
  // 2つとも要る。`reportSink` は書きに行く**前**に本文を控えるので、body だけでは
  // 「書こうとした」と「書けた」を区別できない。error だけでも足りない——回らなかった
  // ティックでは書きに行かないので、どちらも null のまま残る。
  const written = record.body !== null && record.error === null;
  if (target.kind === "stdout") {
    return { destination: "stdout", written, error: record.error, body: record.body };
  }
  return { destination: "file", path: target.path, written, error: record.error };
}

export function summarize(result: TickResult): Record<string, unknown> {
  return {
    ran: result.ran,
    // 回さなかった理由。「寝ている」「他のワーカーが処理中」「終端」は
    // どれも ran: false になるので、これが無いと cron のログから区別できない。
    skipped: result.skipped,
    reclaimed: result.reclaimed,
    status: result.status,
    action: result.decision?.action ?? null,
    rationale: result.decision?.rationale ?? null,
    run: result.run === null ? null : { id: result.run.id, status: result.run.status },
    // dry-run は DB に残さないので、ここで出さなければ読む手段が無い。
    // 通常のティックでは増やさない。既存の呼び出しが読んでいる形を変えない。
    ...(result.dryRun === true
      ? {
          dryRun: true,
          wouldTransitionTo: result.wouldTransitionTo ?? null,
          observed: result.observed ?? null,
        }
      : {}),
  };
}

/**
 * 切り捨てが起きたときだけ、絞り込み方を stderr に出す。
 *
 * stdout は JSON 専用にする。診断を混ぜると、そのまま jq に渡せなくなる（gist 4.3）。
 */
export function writeTruncationHint(shown: number, total: number): void {
  const hint = truncationHint(shown, total, "--limit");
  if (hint !== null) {
    process.stderr.write(`${hint}\n`);
  }
}
