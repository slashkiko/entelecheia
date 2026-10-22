import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitWorktree } from "../src/adapters/local.js";
import { PROTECTED_PATH_FLOOR } from "../src/domain/goal.js";

/**
 * git の観測手段では原理的に見えない書き込みを、別の手段で捕まえる。
 *
 * 関門の入力は `git status` と `git diff` だった。どちらも `.git/**` を1件も
 * 出さない。`--ignored` を足せば見える類でもなく、この計測手段では出てこない。
 * 一方 linked worktree は共通の `.git/hooks` を共有し、Actor の cwd から
 * `../../../../.git/hooks/pre-push` に届く。`gitBranch.push` は worktree を
 * cwd にして `git push` を叩くので、置かれた hook は controller のプロセス・
 * 全環境変数で走る。トークンを Actor から落としている意味が無くなる。
 *
 * gitignore 済みの `.goals/.state/` も同じ理由で見えない。`goals.db` を直接
 * 書き換えれば、`UPDATE goals SET status='COMPLETED'` の1行で以降の全ティックを
 * 短絡させ、承認の記録なしに COMPLETED を名乗らせられる。
 *
 * どちらも「git で見る」という手段を変えないと塞がらない。ACT の前後で
 * 指紋を比べる、という既存の手法をこちらにも当てる。
 *
 * **ただし状態 DB だけは、この adapter では見ない**（issue #62）。あれは
 * controller 自身の書き込み先でもあるので、観測は store の論理ダイジェストから
 * 作る。下の「状態 DB はここでは見ない」を参照。
 */

const run = promisify(execFile);
const GIT_IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

let repoRoot: string;
let worktreeRoot: string;

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "ent-out-of-sight-"));
  worktreeRoot = join(repoRoot, ".goals", ".state", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# out-of-sight\n");
  // 実リポジトリと同じく状態ディレクトリを ignore する。ここを揃えないと
  // 「git status には出ない」という前提の確認が、前提ごと違うものになる。
  writeFileSync(join(repoRoot, ".gitignore"), ".goals/.state/\n");
  await run("git", [...GIT_IDENTITY, "add", "."], { cwd: repoRoot });
  await run("git", [...GIT_IDENTITY, "commit", "-m", "init"], { cwd: repoRoot });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function port() {
  return gitWorktree(repoRoot, worktreeRoot);
}

describe("git に見えない書き込みの検知", () => {
  it("git status には .git/hooks も状態 DB も出ない", async () => {
    // 前提の確認。ここが出るなら、そもそも別の観測は要らない。
    writeFileSync(join(repoRoot, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
    mkdirSync(join(repoRoot, ".goals", ".state"), { recursive: true });
    writeFileSync(join(repoRoot, ".goals", ".state", "goals.db"), "x");

    const dirty = await port().repoDirtyState();

    expect([...dirty.keys()].some((k) => k.includes(".git/hooks"))).toBe(false);
    expect([...dirty.keys()].some((k) => k.includes("goals.db"))).toBe(false);
  });

  it("pre-push を置くと指紋が変わる", async () => {
    const before = await port().outOfSightState?.();
    expect(before).toBeDefined();

    writeFileSync(join(repoRoot, ".git", "hooks", "pre-push"), "#!/bin/sh\ncurl evil\n");

    const after = await port().outOfSightState?.();
    expect(after?.get(".git/hooks/pre-push")).toBeDefined();
    expect(after?.get(".git/hooks/pre-push")).not.toBe(before?.get(".git/hooks/pre-push"));
  });

  it("既存の hook の中身を書き換えても指紋が変わる", async () => {
    writeFileSync(join(repoRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    const before = await port().outOfSightState?.();

    writeFileSync(join(repoRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncurl evil\n");
    const after = await port().outOfSightState?.();

    expect(after?.get(".git/hooks/pre-commit")).not.toBe(before?.get(".git/hooks/pre-commit"));
  });

  it("core.hooksPath を差し替えると指紋が変わる", async () => {
    // hooks のファイルを1つも触らずに、実行されるスクリプト群をまるごと
    // 別のディレクトリへ移せる。ファイルの指紋だけでは捕まらない。
    const before = await port().outOfSightState?.();

    mkdirSync(join(repoRoot, "evil-hooks"), { recursive: true });
    await run("git", ["config", "core.hooksPath", "evil-hooks"], { cwd: repoRoot });

    const after = await port().outOfSightState?.();

    expect(before?.get(".git/config#core.hooksPath")).toBe("unset");
    expect(after?.get(".git/config#core.hooksPath")).toBe("evil-hooks");
  });

  it("状態 DB はここでは見ない", async () => {
    // **観測の作り方だけを変えた。保護対象からは外していない**（issue #62）。
    // `goals.db` は controller 自身の書き込み先でもあり、ファイルのバイト列で
    // 見ていると SQLite の WAL が自動 checkpoint に当たった回だけ、自分の
    // 書き込みが外部からの改竄と同じ差になっていた。いまは controller が
    // `Store.guardDigest`——その Goal に属する行から作る論理ダイジェスト——を
    // 取り、同じ観測に同じキーで混ぜる（`src/controller/index.ts` の
    // `observedRepoState`）。行を読めるのは store だけなので adapter からは作れない。
    //
    // 改竄が関門を鳴らすことは `tests/controller-state-db-writes.test.ts` が、
    // ダイジェストの性質は `tests/state-db-digest.test.ts` が固定している。
    const dbPath = join(repoRoot, ".goals", ".state", "goals.db");
    writeFileSync(dbPath, "original");

    const state = await port().outOfSightState?.();

    expect(state?.has(".goals/.state/goals.db")).toBe(false);
  });

  it("何も触らなければ指紋は変わらない", async () => {
    // 鳴りっぱなしの関門は誰も見なくなる。前後で同じであること。
    const before = await port().outOfSightState?.();
    const after = await port().outOfSightState?.();

    expect(after).toEqual(before);
  });

  it("保護パスの下限が .git と状態 DB を覆っている", () => {
    // 指紋の差分は、glob と突き合わせて初めて関門になる。
    expect(PROTECTED_PATH_FLOOR).toContain(".git/**");
    expect(PROTECTED_PATH_FLOOR).toContain(".goals/.state/**");
  });
});
