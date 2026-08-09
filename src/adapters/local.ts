import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Worktree, WorktreePort } from "../act/index.js";
import type { LocalRepoPort } from "../observe/index.js";
import type { BranchPort, PushResult } from "../publish/index.js";
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

      // --format の値は引用符で囲む。exec はシェル経由なので、囲まないと
      // %(refname:short) の括弧を sh が解釈して syntax error になる。
      // 実 Actor を初めて起動するまで表面化しなかった（テストは Port を注入する）。
      const branches = await git("branch --list --format='%(refname:short)'");
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
 * worktree の差分を feature ブランチに push する。
 *
 * push 先は worktree が checkout しているブランチだけにする。base ブランチへ
 * 直接 push しない（design.md §7 の push_to_default_branch）。
 */
export function gitBranch(root: string): BranchPort {
  return {
    async push(name, baseBranch): Promise<PushResult> {
      const cwd = `${root}/${name}`;
      const git = async (args: string): Promise<string> => {
        const { stdout } = await run(`git ${args}`, { cwd });
        return stdout.trim();
      };

      const branch = await git("rev-parse --abbrev-ref HEAD");
      if (branch === baseBranch) {
        // ここを通すと controller が main を書き換えられる。設定ではなく実装で塞ぐ。
        throw new Error(`base ブランチには push しない: ${branch}`);
      }

      // base との差分が無ければ push しない。空の PR は通知にも検証にも使えない。
      const ahead = await git(`rev-list --count origin/${baseBranch}..HEAD`);
      if (ahead === "0") {
        return { branch, pushed: false };
      }

      // HEAD:<branch> の形にして、ローカルとリモートで名前がずれても同じ先に送る。
      await git(`push -u origin HEAD:${branch}`);
      return { branch, pushed: true };
    },
  };
}

/**
 * 人間の承認が常に未承認になる Port。
 *
 * PR がまだ無い Goal で使う。承認コメントの置き場所が無い状態を
 * 「承認された」と読まないため、捏造せずに null を返す。
 */
export function pendingApproval(): ApprovalPort {
  return { getApproval: async () => null };
}
