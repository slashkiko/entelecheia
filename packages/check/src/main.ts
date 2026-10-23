import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage } from "@entelecheia/core/domain/error-message.js";
import { passed, runCheck } from "./check.js";
import { parseCommand, USAGE } from "./parse.js";

/**
 * `ent-check` の本体。bin の `src/cli.ts` から呼ぶ。テストは、プロセスを立てずにこれを呼ぶ。
 *
 * 検査は ent に依存しない（`packages/core/tests/architecture.test.ts` が確かめる）。
 * Actor の出力を扱う ent が壊れても、検査の判断が巻き込まれないようにするため。
 *
 * 終了コードは 0 合格、1 不合格、2 引数の誤り、3 検査できなかった。3 を不合格と分けるのは、
 * runner が来ない・mise が無いといった失敗を不合格に数えると、flaky の判定と revert の
 * 判断を誤らせるため。3 のときは evidence.json を書かない。`--out` に書けなかったときも 3 にする。
 * そのときも stdout には先に出してあるので、判断は失われない。
 */

const EXIT = { passed: 0, failed: 1, usage: 2, unavailable: 3 } as const;

export async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.passed;
  }
  if (command.kind === "error") {
    process.stderr.write(`ent-check: ${command.message}\n\n${USAGE}\n`);
    return EXIT.usage;
  }

  try {
    const report = await runCheck({
      repoDir: resolve(command.dir ?? process.cwd()),
      repo: command.repo,
      pr: command.pr,
      base: command.base,
      head: command.head,
      task: command.task,
      timeoutMs: command.timeoutMinutes * 60_000,
      checkerSha: command.checkerSha,
      now: () => new Date(),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(json);
    if (command.out !== null) {
      try {
        await writeFile(command.out, json);
      } catch (error) {
        process.stderr.write(`ent-check: could not write --out: ${errorMessage(error)}\n`);
        return EXIT.unavailable;
      }
    }
    return passed(report) ? EXIT.passed : EXIT.failed;
  } catch (error) {
    // 検査の不具合も「検査できなかった」に倒す。不合格にすると Actor に直させる作業が
    // 起き、合格にすると落ちるべき変更が通る。どちらでもないことを、終了コードで伝える。
    process.stderr.write(`ent-check: could not check: ${errorMessage(error)}\n`);
    return EXIT.unavailable;
  }
}
