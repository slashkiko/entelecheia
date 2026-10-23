import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitWorktree } from "../src/adapters/local.js";

/**
 * index の隠しビットで関門の観測を潰せた経路を塞いだことを固定する。
 *
 * 関門の一次入力は `git status --porcelain -uall` と `<base>...HEAD` の diff で、
 * **`status` は `assume-unchanged` と `skip-worktree` を尊重する。**
 * 作業ツリーの中から
 *
 *   git -C ../../../.. update-index --assume-unchanged src/controller/index.ts
 *
 * を1回叩いてから本体側のファイルを書き換えると、`git status` も `git diff` も
 * 空になり、**違反ゼロで通過する。** そのあと `tsc` は index ではなく
 * ファイルシステムから読むので、改変された controller がそのまま次のティックで走る。
 *
 * design.md §10-6 の既知の穴 (c) と (e) は「1度は人間に届く」を保証として残して
 * いるが、この経路は一度も鳴らない。拒否リスト（`ALWAYS_DENIED`）にも同じ動詞を
 * 足したが、あれは先頭からのグロブなので `git -C . update-index ...` や環境変数の
 * 前置で外れうる。**観測を潰す形は、観測する側でも見る。**
 *
 * 本物の git に対して回す。index のビットはファイルの中身にも `git status` の
 * 出力にも現れないので、テストダブルでは再現できない。
 */

const run = promisify(execFile);

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
let worktreeRoot: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ent-index-hidden-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  mkdirSync(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  mkdirSync(join(repoRoot, "src", "controller"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "controller", "index.ts"), "export const ok = true;\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "init"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("index の隠しビット", () => {
  it("assume-unchanged を立てると git status からは消える（再現）", async () => {
    // 塞いだ側だけを見ていると、`git status` の挙動が変わった日に
    // 「塞げている」ではなく「そもそも隠せない」で緑になる。
    await git(repoRoot, ["update-index", "--assume-unchanged", "src/controller/index.ts"]);
    writeFileSync(join(repoRoot, "src", "controller", "index.ts"), "PWNED\n");

    expect(await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("本体リポジトリ側で隠されたパスが repoDirtyState に出る", async () => {
    const port = gitWorktree(repoRoot, worktreeRoot);
    const before = await port.repoDirtyState();

    // Actor が作業ツリーの中から本体側の index を触る形。
    await git(repoRoot, ["update-index", "--assume-unchanged", "src/controller/index.ts"]);
    writeFileSync(join(repoRoot, "src", "controller", "index.ts"), "PWNED\n");

    const after = await port.repoDirtyState();
    const hidden = join(repoRoot, "src", "controller", "index.ts");
    expect(before.has(hidden)).toBe(false);
    expect(after.has(hidden)).toBe(true);
  });

  it("skip-worktree も同じように出る", async () => {
    // 動詞が同じなので、片方だけ見ていると綴りを変えるだけで抜けられる。
    const port = gitWorktree(repoRoot, worktreeRoot);
    const before = await port.repoDirtyState();

    await git(repoRoot, ["update-index", "--skip-worktree", "src/controller/index.ts"]);
    writeFileSync(join(repoRoot, "src", "controller", "index.ts"), "PWNED\n");

    const after = await port.repoDirtyState();
    expect(before.size).toBe(0);
    expect([...after.keys()]).toEqual([join(repoRoot, "src", "controller", "index.ts")]);
  });

  it("値は中身の指紋ではなく印にする。既に隠されていたファイルの編集で鳴らない", async () => {
    // `assume-unchanged` は「ローカル専用の変更を status から外す」ために人間も
    // 使う。中身を値にすると、そのファイルを人間が編集するたびに ACT の前後で
    // 値が動き、毎ティック `protected_path_touched` になる（穴 (d) の拡大）。
    // 印にしておけば、差に出るのは **ACT の窓の中でビットが立った/消えたとき**だけ。
    const port = gitWorktree(repoRoot, worktreeRoot);
    await git(repoRoot, ["update-index", "--assume-unchanged", "src/controller/index.ts"]);

    const before = await port.repoDirtyState();
    writeFileSync(join(repoRoot, "src", "controller", "index.ts"), "human edit\n");
    const after = await port.repoDirtyState();

    expect(after).toEqual(before);
  });

  it("作業ツリーの中で隠されたパスは changedPaths に出る", async () => {
    const port = gitWorktree(repoRoot, worktreeRoot);
    const created = await port.ensure("sample-goal", "main");
    expect(await port.changedPaths("sample-goal", "main")).toEqual([]);

    await git(created.path, ["update-index", "--assume-unchanged", "src/controller/index.ts"]);
    writeFileSync(join(created.path, "src", "controller", "index.ts"), "PWNED\n");

    expect(await port.changedPaths("sample-goal", "main")).toEqual(["src/controller/index.ts"]);
  });
});
