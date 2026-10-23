import { open, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage } from "@entelecheia/core/domain/error-message.js";
import { judge, observe, passed, runCheck } from "./check.js";
import { exitOnInterrupt } from "./cleanup.js";
import { MAX_OBSERVATIONS_BYTES, type Observations, observationsSchema } from "./observations.js";
import { type Command, parseCommand, USAGE } from "./parse.js";
import { CheckUnavailable } from "./run-task.js";

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
 *
 * `--observe` は verify を流して見たことだけを書く。verify が落ちても 0 で終わる（落ちたことは
 * 観測の一部になる）。分岐点が時間切れなら、観測を書かずに 3 で終わる。`--observations` は
 * verify を流さず、0 と 1 を同じ意味で返す。
 * SIGINT と SIGTERM で止められたときは、後始末をしてから 128 にシグナルの番号を足した値で
 * 終わる（`cleanup.ts`）。
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

  const stopListening = exitOnInterrupt();
  try {
    const result = await run(command);
    const json = `${JSON.stringify(result.json, null, 2)}\n`;
    process.stdout.write(json);
    if (command.out !== null) {
      try {
        await writeAtomically(command.out, json);
      } catch (error) {
        process.stderr.write(`ent-check: could not write --out: ${errorMessage(error)}\n`);
        return EXIT.unavailable;
      }
    }
    return result.passed ? EXIT.passed : EXIT.failed;
  } catch (error) {
    // 検査の不具合も「検査できなかった」に倒す。不合格にすると Actor に直させる作業が
    // 起き、合格にすると落ちるべき変更が通る。どちらでもないことを、終了コードで伝える。
    process.stderr.write(`ent-check: could not check: ${errorMessage(error)}\n`);
    return EXIT.unavailable;
  } finally {
    stopListening();
  }
}

async function run(
  command: Exclude<Command, { kind: "help" } | { kind: "error" }>,
): Promise<{ json: unknown; passed: boolean }> {
  const commits = {
    repoDir: resolve(command.dir ?? process.cwd()),
    base: command.base,
    head: command.head,
  };
  if (command.kind === "observe") {
    const observations = await observe({
      ...commits,
      task: command.task,
      timeoutMs: command.timeoutMinutes * 60_000,
    });
    return { json: observations, passed: true };
  }
  const judgeOptions = {
    ...commits,
    repo: command.repo,
    pr: command.pr,
    checkerSha: command.checkerSha,
    now: () => new Date(),
  };
  const report =
    command.kind === "judge"
      ? await judge(judgeOptions, await readObservations(command.observations))
      : await runCheck({
          ...judgeOptions,
          task: command.task,
          timeoutMs: command.timeoutMinutes * 60_000,
        });
  return { json: report, passed: passed(report) };
}

/**
 * 書き終えてから名前を付ける。途中で止められても、書きかけのファイルが `--out` の名前で
 * 残らない。ワークフローは、その名前のファイルがあれば ent-check の判断として扱う。
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  const partial = `${path}.${process.pid}.partial`;
  try {
    await writeFile(partial, text);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * `--observe` が書いた観測を読む。head のジョブが差し替えうるので、大きさと形を検める。
 * どちらが崩れていても、head の不合格ではなく検査できなかった側に倒す
 */
async function readObservations(path: string): Promise<Observations> {
  const file = await open(path);
  let text: string;
  try {
    const { size } = await file.stat();
    if (size > MAX_OBSERVATIONS_BYTES) {
      throw new CheckUnavailable(
        `${path} is ${size} bytes, larger than ${MAX_OBSERVATIONS_BYTES} bytes`,
      );
    }
    text = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CheckUnavailable(`${path} is not JSON: ${errorMessage(error)}`);
  }
  const parsed = observationsSchema.safeParse(json);
  if (!parsed.success) {
    throw new CheckUnavailable(`${path} is not observations: ${parsed.error.message}`);
  }
  return parsed.data;
}
