import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkEnv } from "./env.js";
import { parseJUnit, type TestCase } from "./junit.js";
import type { TaskOutcome } from "./rules.js";

/**
 * リポジトリの verify のタスクを流す。中身は各リポジトリの mise のタスクで、検査は
 * それを呼ぶだけになる。
 *
 * 流れるのは head のコード、つまり Actor が書いたものになる。環境変数は ent の VERIFY と
 * 同じ除去リストで落とす。再利用ワークフローには secret を渡さないが、手元で
 * `ent-check` を叩いたときに、叩いた人のトークンがテストへ引き継がれないようにする。
 *
 * 防げるのは引き継ぎまでになる。head のコードは同じユーザーで動くので、狙えば親の
 * ent-check の環境（`/proc/<pid>/environ` など）から落とした値を読める。トークンを
 * 持ったシェルから手で叩かない。
 */

export class CheckUnavailable extends Error {
  override readonly name = "CheckUnavailable";
}

export interface TaskRun {
  /** 切り出したリポジトリのルート */
  cwd: string;
  task: string;
  /** JUnit XML を書かせるディレクトリ。`ENT_CHECK_REPORT_DIR` で渡す */
  reportDir: string;
  timeoutMs: number;
}

/**
 * 切り出したリポジトリで `mise install` と `mise run <task>` を順に流す。
 *
 * 道具を入れるのは、base から書き戻した定義（`mise.toml` と `mise.lock`）に従わせるため。
 * head の定義で入れると、head が道具のバージョンや取得元を選べる。入れられなかったときは、
 * head の不合格ではなく検査できなかった側に倒す。
 */
export async function runTask(run: TaskRun): Promise<TaskOutcome> {
  const env = checkEnv({
    ENT_CHECK_REPORT_DIR: run.reportDir,
    // 切り出しは検査のたびに作るので、mise はその mise.toml をまだ信頼していない。
    // 中身は base から書き戻した定義なので、ここで信頼してよい。
    MISE_TRUSTED_CONFIG_PATHS: run.cwd,
  });
  const deadline = Date.now() + run.timeoutMs;
  // 時間の上限は、道具を入れる時間も含めて1回分になる。
  const install = await spawnMise(["install"], run.cwd, env, run.timeoutMs);
  if (install.type === "timed_out") {
    throw new CheckUnavailable(
      "mise install did not finish within the time limit (--timeout-minutes)",
    );
  }
  if (install.exitCode !== 0) {
    throw new CheckUnavailable("mise install failed with the base's tool definitions");
  }
  return spawnMise(["run", run.task], run.cwd, env, Math.max(deadline - Date.now(), 1));
}

function spawnMise(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<TaskOutcome> {
  return new Promise<TaskOutcome>((resolve, reject) => {
    // 子の出力は検査の stderr に流す。stdout は evidence.json のために空けておく。
    const child = spawn("mise", [...args], {
      cwd,
      env,
      stdio: ["ignore", 2, 2],
      // テストが子プロセスを残しても、時間切れでまとめて止められるようにする。
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      // mise が無い、cwd が無い。どちらも head の不合格ではなく、検査できなかった側になる。
      reject(new CheckUnavailable(`could not start mise: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // 終わったあとも、テストが残した子プロセスを止める。残すと次の実行と取り合う。
      killGroup(child.pid);
      if (timedOut) {
        resolve({ type: "timed_out" });
      } else {
        resolve({ type: "exited", exitCode: code ?? (signal === null ? 1 : 128) });
      }
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // もう居ない
  }
}

/**
 * ディレクトリの下の JUnit XML を全部読む。1つも無ければ null。
 *
 * 置き場は head のコードが書ける。`.xml` の名前のディレクトリや、権限を外した `.xml` を
 * 置かれても、読めないものは飛ばす（symlink はファイルとして読まない）。投げると検査全体が「検査できなかった」になり、
 * head の不合格を head の側で取り消せてしまう。
 */
export async function readReports(dir: string): Promise<TestCase[] | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".xml"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const cases: TestCase[] = [];
  let read = 0;
  for (const file of files) {
    try {
      const text = await readFile(file, "utf8");
      // JUnit のタグが無いファイルは報告ではない。数えると、中身の無い `.xml` を1つ置くだけで
      // 「報告がある」になる。
      if (!/<test(?:suites?|case)\b/.test(text)) continue;
      cases.push(...parseJUnit(text));
      read += 1;
    } catch {
      // 読めない報告は無かったものとして扱う
    }
  }
  return read === 0 ? null : cases;
}
