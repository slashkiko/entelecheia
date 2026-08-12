import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandRunner,
  ghAuthToken,
  gitBranch,
  gitWorktree,
  localRepo,
} from "../src/adapters/local.js";

/**
 * ローカル Port を実際の git に対して回す。
 *
 * ここだけはテストダブルを使わない。README が挙げた3つの断線のうち2つ
 * （`git branch --format` の引用符、VERIFY の実行ディレクトリ）はこの層にあり、
 * Port を注入するテストは原理的に通してしまう。実際に走らせないと
 * 「配管が繋がっている」は確かめられない（design.md §8）。
 */

const run = promisify(execFile);

/** テスト用の git。コミットには identity が要るので毎回渡す */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    { cwd },
  );
  return stdout.trim();
}

let root: string;
let repoRoot: string;
let originPath: string;
let worktreeRoot: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ent-local-"));
  originPath = join(root, "origin.git");
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");

  await run("git", ["init", "--bare", "-b", "main", originPath]);
  await run("git", ["clone", originPath, repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# sample\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["push", "-u", "origin", "main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("gitWorktree", () => {
  it("作業ツリーを作り、同じ名前で2回呼んでも同じものを返す", async () => {
    const port = gitWorktree(repoRoot, worktreeRoot);

    const first = await port.ensure("sample-goal", "main");
    writeFileSync(join(first.path, "work.txt"), "1\n");
    const second = await port.ensure("sample-goal", "main");

    expect(second).toEqual(first);
    expect(first.branch).toBe("entelecheia/sample-goal");
    // 作り直すと前ティックの差分が消える。
    expect(existsSync(join(second.path, "work.txt"))).toBe(true);
  });

  it("ブランチだけ残っている状態から作り直せる", async () => {
    // `git branch --list --format=%(refname:short)` をシェル経由で流していたころ、
    // 括弧を sh が解釈して syntax error になり、worktree の作成が
    // Phase 2 からずっと失敗していた。ACT はどのティックでも起動していなかった。
    const port = gitWorktree(repoRoot, worktreeRoot);
    const created = await port.ensure("sample-goal", "main");
    writeFileSync(join(created.path, "work.txt"), "1\n");
    await git(created.path, ["add", "."]);
    await git(created.path, ["commit", "-m", "作業"]);

    // 作業ツリーだけ消し、ブランチは残す。
    await git(repoRoot, ["worktree", "remove", "--force", created.path]);
    expect(existsSync(created.path)).toBe(false);

    const again = await port.ensure("sample-goal", "main");

    expect(again.branch).toBe("entelecheia/sample-goal");
    // 既存ブランチを checkout し直すので、前の commit が残っている。
    expect(existsSync(join(again.path, "work.txt"))).toBe(true);
  });

  describe("changedPaths", () => {
    it("作業ツリーがまだ無ければ空", async () => {
      const port = gitWorktree(repoRoot, worktreeRoot);

      expect(await port.changedPaths("sample-goal", "main")).toEqual([]);
    });

    it("未 commit の変更を返す", async () => {
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      writeFileSync(join(worktree.path, "README.md"), "# changed\n");

      expect(await port.changedPaths("sample-goal", "main")).toEqual(["README.md"]);
    });

    it("未追跡ファイルも1件ずつ返す", async () => {
      // -uall を付けないとディレクトリ名だけが1行で出る。
      // `src/controller/` としか出なければ、glob が一致しない。
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      await run("mkdir", ["-p", join(worktree.path, "src", "controller")]);
      writeFileSync(join(worktree.path, "src", "controller", "index.ts"), "//\n");

      expect(await port.changedPaths("sample-goal", "main")).toEqual(["src/controller/index.ts"]);
    });

    it("commit 済みの変更も返す", async () => {
      // commit したら status からは消える。ここを落とすと、違反した編集が
      // commit された次のティックで検知できなくなる。
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      writeFileSync(join(worktree.path, "added.ts"), "//\n");
      await git(worktree.path, ["add", "."]);
      await git(worktree.path, ["commit", "-m", "足す"]);

      expect(await port.changedPaths("sample-goal", "main")).toEqual(["added.ts"]);
    });

    it("Bash 相当の書き込みも git からは見える", async () => {
      // Edit / Write を通らない書き込みは Run.artifacts に現れない（design.md §10-6）。
      // 保護パスの検査を自己申告に載せている限り、この経路は素通りする。
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      await run("sh", [
        "-c",
        `echo '// touched' >> ${JSON.stringify(join(worktree.path, "README.md"))}`,
      ]);

      expect(await port.changedPaths("sample-goal", "main")).toContain("README.md");
    });

    it("base の ref が消えていたら握り潰さずに throw する", async () => {
      // Actor は `git update-ref -d refs/heads/main` を実行できた。
      // 違反を commit してから base の ref を消すと、未 commit の変更は無く、
      // diff は fatal になる。以前はそれを catch{} で畳んでいたので
      // changedPaths が空を返し、guard は「触っていない」と読んだ。
      // origin/main は残るので push だけ通り、違反が PR に流れた。
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      writeFileSync(join(worktree.path, "README.md"), "# pwned\n");
      await git(worktree.path, ["add", "."]);
      await git(worktree.path, ["commit", "-m", "違反を commit する"]);
      // origin/main も消し、fallback も効かない状態にする。
      await git(repoRoot, ["update-ref", "-d", "refs/heads/main"]);
      await git(repoRoot, ["update-ref", "-d", "refs/remotes/origin/main"]);

      await expect(port.changedPaths("sample-goal", "main")).rejects.toThrow();
    });

    it("ローカルの base が消えていても origin から見る", async () => {
      const port = gitWorktree(repoRoot, worktreeRoot);
      const worktree = await port.ensure("sample-goal", "main");
      writeFileSync(join(worktree.path, "README.md"), "# pwned\n");
      await git(worktree.path, ["add", "."]);
      await git(worktree.path, ["commit", "-m", "違反を commit する"]);
      await git(repoRoot, ["update-ref", "-d", "refs/heads/main"]);

      expect(await port.changedPaths("sample-goal", "main")).toEqual(["README.md"]);
    });

    it("worktree の外への書き込みは changedPaths には出ない", async () => {
      // `git worktree add` で分けた本体側は別の作業ツリーなので、
      // worktree の中で git status を回しても1件も出ない。
      // ここが空になることが repoDirtyState を足した理由そのもの。
      const port = gitWorktree(repoRoot, worktreeRoot);
      await port.ensure("sample-goal", "main");
      writeFileSync(join(repoRoot, "README.md"), "# pwned\n");

      expect(await port.changedPaths("sample-goal", "main")).toEqual([]);
    });
  });

  describe("repoDirtyState", () => {
    it("本体リポジトリ側の変更を絶対パスと中身の指紋で返す", async () => {
      const port = gitWorktree(repoRoot, worktreeRoot);
      await port.ensure("sample-goal", "main");
      // Actor が Bash で隔離の外を書いた状態。
      await run("sh", ["-c", `echo '// pwned' > ${JSON.stringify(join(repoRoot, "README.md"))}`]);

      const state = await port.repoDirtyState();
      expect([...state.keys()]).toEqual([join(repoRoot, "README.md")]);
      // 中身を書き換えたら指紋も変わる。パス名だけでは上書きを見分けられない。
      const before = state.get(join(repoRoot, "README.md"));
      writeFileSync(join(repoRoot, "README.md"), "// pwned again\n");
      expect((await port.repoDirtyState()).get(join(repoRoot, "README.md"))).not.toBe(before);
    });

    it("汚れていなければ空", async () => {
      const port = gitWorktree(repoRoot, worktreeRoot);
      await port.ensure("sample-goal", "main");

      expect(await port.repoDirtyState()).toEqual(new Map());
    });

    it("削除も変更として出る", async () => {
      // 関門が読むファイルを消すのも書き換えと同じ攻撃になる。
      // 指紋は読めなかったことを値にするので、消える前との差が出る。
      const port = gitWorktree(repoRoot, worktreeRoot);
      await port.ensure("sample-goal", "main");
      unlinkSync(join(repoRoot, "README.md"));

      const state = await port.repoDirtyState();
      expect([...state.keys()]).toEqual([join(repoRoot, "README.md")]);
    });

    it("gitignore されたパスは見えない", async () => {
      // controller 自身が `.goals/.state/` に毎ティック書くので、
      // `--ignored` を付けると自分の書き込みが毎回違反として並ぶ。
      // 無視されたパスは関門の射程外になる（design.md §10-6）。
      const port = gitWorktree(repoRoot, worktreeRoot);
      await port.ensure("sample-goal", "main");
      writeFileSync(join(repoRoot, ".gitignore"), "state/\n");
      await git(repoRoot, ["add", ".gitignore"]);
      await git(repoRoot, ["commit", "-m", "ignore"]);
      mkdirSync(join(repoRoot, "state"));
      writeFileSync(join(repoRoot, "state", "ent.db"), "pwned\n");

      expect(await port.repoDirtyState()).toEqual(new Map());
    });

    it("repoRoot の中に worktree を置いても、その中身は数えない", async () => {
      // 既定では .goals/.state/ の下で gitignore されるので出てこないが、
      // 追跡外の場所に置く構成では未追跡ファイルとして並び、
      // ACT のたびに「隔離の外を書いた」と読んでしまう。
      const inside = join(repoRoot, "worktrees");
      const port = gitWorktree(repoRoot, inside);
      const worktree = await port.ensure("sample-goal", "main");
      writeFileSync(join(worktree.path, "work.txt"), "1\n");

      expect(await port.repoDirtyState()).toEqual(new Map());
    });
  });
});

describe("gitBranch", () => {
  const pushable = async (name: string): Promise<string> => {
    const worktree = await gitWorktree(repoRoot, worktreeRoot).ensure(name, "main");
    writeFileSync(join(worktree.path, "work.txt"), "1\n");
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", "作業"]);
    return worktree.path;
  };

  it("差分があれば feature ブランチに push する", async () => {
    await pushable("sample-goal");

    const result = await gitBranch(worktreeRoot).push("sample-goal", "main");

    expect(result).toEqual({ branch: "entelecheia/sample-goal", pushed: true });
    const remote = await git(originPath, ["branch", "--list", "--format=%(refname:short)"]);
    expect(remote.split("\n")).toContain("entelecheia/sample-goal");
  });

  it("差分が無ければ push しない", async () => {
    await gitWorktree(repoRoot, worktreeRoot).ensure("sample-goal", "main");

    const result = await gitBranch(worktreeRoot).push("sample-goal", "main");

    expect(result).toEqual({ branch: "entelecheia/sample-goal", pushed: false });
  });

  it("base ブランチには push しない", async () => {
    // ここを通すと controller が base を書き換えられる。設定ではなく実装で塞ぐ。
    // main 自体は controller のリポジトリが checkout しているので、
    // worktree では別名の base を用意して同じ経路を通す。
    const worktree = await gitWorktree(repoRoot, worktreeRoot).ensure("sample-goal", "main");
    await git(worktree.path, ["checkout", "-b", "develop"]);

    await expect(gitBranch(worktreeRoot).push("sample-goal", "develop")).rejects.toThrow(
      "refusing to push to the base branch",
    );
  });

  it("シェルのメタ文字を含むブランチ名でコマンドが実行されない", async () => {
    // ブランチ名は worktree の中身なので Actor が完全に制御できる。git は
    // `;` や `$()` をブランチ名に許すので、テンプレート文字列を exec に
    // 渡していたころは、ブランチを1本作るだけで controller のプロセス上で
    // 任意コマンドが走った。隔離はファイルの置き場所の話でしかなかった。
    const worktreePath = await pushable("sample-goal");
    const marker = join(root, "PWNED");
    await git(worktreePath, ["checkout", "-b", `evil;touch\${IFS}${marker}`]);

    await expect(gitBranch(worktreeRoot).push("sample-goal", "main")).rejects.toThrow(
      "branch name is not usable as a push target",
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("commandRunner", () => {
  it("終了コードを返す。0 以外でも throw しない", async () => {
    // 「検証できた不合格」を throw に畳むと、捏造した不合格になる。
    const port = commandRunner(repoRoot);

    expect(await port.run("exit 3")).toMatchObject({ exitCode: 3 });
    expect(await port.run("echo ok")).toMatchObject({ exitCode: 0, stdout: "ok\n" });
  });

  it("渡した cwd で実行する", async () => {
    // VERIFY を repoRoot 固定で流していたころ、Actor は worktree の中で
    // 実装するのに criteria は controller 自身のリポジトリで確かめていた。
    const worktree = await gitWorktree(repoRoot, worktreeRoot).ensure("sample-goal", "main");
    writeFileSync(join(worktree.path, "only-here.txt"), "1\n");

    expect(await commandRunner(worktree.path).run("test -f only-here.txt")).toMatchObject({
      exitCode: 0,
    });
    expect(await commandRunner(repoRoot).run("test -f only-here.txt")).toMatchObject({
      exitCode: 1,
    });
  });
});

describe("localRepo", () => {
  it("ブランチ・HEAD・作業ツリーの汚れを返す", async () => {
    const port = localRepo(repoRoot);

    const clean = await port.snapshot();
    expect(clean.branch).toBe("main");
    expect(clean.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);

    writeFileSync(join(repoRoot, "README.md"), "# changed\n");
    expect((await port.snapshot()).dirty).toBe(true);
  });
});

/**
 * `gh auth token` からの読み取り。
 *
 * ここで確かめるのは値ではなく**落ち方**になる。gh が入っているか、ログイン
 * しているかは環境によって違い、CI では両方とも無いことがある。値を assert すると
 * 環境の差でテストが揺れるので、契約だけを固定する。
 *
 * 契約は2つ。throw しないことと、読めなければ null を返すこと。ここで throw すると、
 * token が無くても進められるローカルの観測・検証コマンド・Actor の実行まで巻き添えで
 * 止まる（`doctorPayload` が「入口で殺すと進められるものまで止まる」と書いている当のもの）。
 */
describe("ghAuthToken", () => {
  it("読めても読めなくても throw しない", () => {
    expect(() => ghAuthToken()).not.toThrow();
  });

  it("戻り値は token の文字列か null で、空文字は返さない", () => {
    const token = ghAuthToken();

    expect(token === null || typeof token === "string").toBe(true);
    expect(token).not.toBe("");
  });
});
