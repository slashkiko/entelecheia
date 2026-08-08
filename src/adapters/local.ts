import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Worktree, WorktreePort } from "../act/index.js";
import type { LocalRepoPort } from "../observe/index.js";
import type { ApprovalPort, CommandResult, CommandRunnerPort } from "../verify/index.js";

/**
 * ローカル環境に対する Port の実装。
 *
 * GitHub（octokit）と Actor（Claude Agent SDK）はここに含めない。次の Goal で足す。
 * ここにあるのは node:child_process だけで書けるもので、依存パッケージが要らない。
 */

const run = promisify(exec);

/** シェルコマンドを実行する。起動そのものに失敗したときだけ throw する */
export function commandRunner(cwd: string): CommandRunnerPort {
  return {
    async run(command): Promise<CommandResult> {
      try {
        const { stdout, stderr } = await run(command, { cwd, maxBuffer: 32 * 1024 * 1024 });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        // 終了コードが 0 以外なら reject されるが、これは「検証できた不合格」なので
        // throw に畳まない。起動できなかった場合だけ throw する。
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        if (typeof failure.code === "number") {
          return {
            exitCode: failure.code,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
        throw error;
      }
    },
  };
}

export function localRepo(cwd: string): LocalRepoPort {
  return {
    async snapshot() {
      const git = async (args: string): Promise<string> => {
        const { stdout } = await run(`git ${args}`, { cwd });
        return stdout.trim();
      };
      const [branch, headSha, status] = await Promise.all([
        git("rev-parse --abbrev-ref HEAD"),
        git("rev-parse HEAD"),
        git("status --porcelain"),
      ]);
      return { branch, headSha, dirty: status.length > 0 };
    },
  };
}

/**
 * git worktree による隔離。同じ name で2回呼んでも同じものを返す。
 * ティックをまたいで同じ作業ツリーに差分を積み上げる。
 */
export function gitWorktree(repoRoot: string, root: string): WorktreePort {
  return {
    async ensure(name, baseBranch): Promise<Worktree> {
      const path = `${root}/${name}`;
      const branch = `entelecheia/${name}`;
      const git = async (args: string): Promise<string> => {
        const { stdout } = await run(`git ${args}`, { cwd: repoRoot });
        return stdout.trim();
      };

      const existing = await git("worktree list --porcelain");
      if (existing.includes(`worktree ${path}`)) {
        return { path, branch };
      }

      const branches = await git("branch --list --format=%(refname:short)");
      const exists = branches.split("\n").includes(branch);
      // 既にブランチがあれば checkout し直す。作り直すと前ティックの差分が消える。
      await git(
        exists
          ? `worktree add ${path} ${branch}`
          : `worktree add -b ${branch} ${path} ${baseBranch}`,
      );
      return { path, branch };
    },
  };
}

/**
 * 人間の承認。
 *
 * 承認をどの signal で検知するかは未決（design.md §10）。GitHub の
 * `review_decision` は自分が作った PR に Approve を押せないので使えない。
 * 決まるまでは常に未承認（pending）を返す。捏造した承認を作らないため。
 */
export function pendingApproval(): ApprovalPort {
  return { getApproval: async () => null };
}
