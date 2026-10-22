import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

/**
 * VERIFY が worktree の中でコマンドを流していることを、実物で確かめる。
 *
 * README が挙げた4つの断線のうち「VERIFY が worktree ではなく controller 自身の
 * リポジトリでコマンドを流していた」だけが、いまだにテストで塞がれていない。
 * tests/local-adapter.test.ts は `commandRunner(cwd)` が渡された cwd を尊重する
 * ことを確かめているが、そこは壊れていなかった。壊れていたのは呼び出し側が
 * どの cwd を渡すかで、それを決める `verifyRoot()` の worktree 側の分岐は
 * どのテストからも通っていない（実測: src/cli.ts の branch coverage 74.26%）。
 *
 * `verifyRoot()` を無条件 `process.cwd()` に戻しても既存の 495 本は全部緑のまま
 * だったので、退行を検知するものが本当に無い。
 *
 * ここでは criteria を「worktree の中にしか無いファイルを見る」ものにする。
 * controller 自身のリポジトリで流れたら、そのファイルは無いので落ちる。
 * Port は一切注入せず、実 git・実 SQLite・実 main() を通す。
 *
 * 実際に `verifyRoot()` を無条件 `process.cwd()` に書き換えて、この1本が落ちる
 * ことを確かめてある。落ち方は環境で変わる。criteria が unmet になると guard は
 * COMPLETE を選べず DECIDE が LLM を呼ぶので、資格情報があればタイムアウトで、
 * 無ければ LLM が使えず status が COMPLETED にならない assert で落ちる。
 * どちらでも落ちるが、タイムアウト側は理由が読めないので、この注記を残す。
 */

const run = promisify(execFile);

/** marker は worktree の中にだけ置く。repoRoot 側には同名のファイルを作らない */
const GOAL_YAML = `version: 1
goal:
  id: worktree-goal
  name: VERIFY が worktree で流れる
  desired_state: |
    criteria のコマンドが worktree の中で実行される。
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
setup: []
acceptance_criteria:
  - id: ac-1
    description: worktree の中にしか無いファイルが見える
    verification:
      type: command
      run: test -f only-in-worktree
context:
  background: |
    VERIFY の cwd を実物で確かめる。
  constraints: []
  references: []
policies:
  require_human_approval:
    - merge
  protected_paths: []
budget:
  max_actor_runs: 5
  max_reconciles: 10
  max_wall_clock: 1h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

const GIT_IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

let repoRoot: string;
let cwd: string;
let stdout: string[];

function lastJson(): unknown {
  return JSON.parse(stdout.at(-1) ?? "null");
}

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-verify-root-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# worktree\n");
  await run("git", [...GIT_IDENTITY, "add", "."], { cwd: repoRoot });
  await run("git", [...GIT_IDENTITY, "commit", "-m", "init"], { cwd: repoRoot });

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "worktree-goal.yaml"), GOAL_YAML);

  // 空文字は「渡さないと決めた」の意味になる。delete だと `gh auth token` に
  // 落ちて、対話ログインした gh があるマシンでは実物のトークンで GitHub を叩く。
  process.env.GITHUB_TOKEN = "";
  process.env.GH_TOKEN = "";

  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * ACT を待たずに worktree を用意する。
 *
 * 実際には ACT が作るが、この検査で見たいのは「worktree があるとき VERIFY が
 * そこで流れるか」だけなので、Actor は動かさずに同じ場所へ実物を置く。
 * 置き場所は `verifyRoot()` と同じ `.goals/.state/worktrees/<goal.id>`。
 */
async function addWorktree(): Promise<string> {
  const worktree = join(repoRoot, ".goals", ".state", "worktrees", "worktree-goal");
  await run(
    "git",
    [...GIT_IDENTITY, "worktree", "add", "-b", "entelecheia/worktree-goal", worktree],
    {
      cwd: repoRoot,
    },
  );
  writeFileSync(join(worktree, "only-in-worktree"), "");
  return worktree;
}

describe("VERIFY の実行場所", () => {
  it("worktree があれば criteria は worktree の中で流れる", async () => {
    expect(await main(["start", "worktree-goal"])).toBe(0);
    const worktree = await addWorktree();

    // この検査が空振りでないことの根拠。marker は worktree にしか無いので、
    // ac-1 が passed になる道は「VERIFY が worktree で流れた」以外に無い。
    //
    // 反対側（worktree が無ければ落ちる）を main() から確かめることはできない。
    // criteria が落ちると guard は COMPLETE を選べず DECIDE が LLM を呼ぶので、
    // 資格情報の無い環境ではそこで止まる。ここは存在の非対称で代える。
    expect(existsSync(join(worktree, "only-in-worktree"))).toBe(true);
    expect(existsSync(join(repoRoot, "only-in-worktree"))).toBe(false);

    expect(await main(["run", "worktree-goal"])).toBe(0);

    // ac-1 が passed になるのは、worktree の中にしか無い only-in-worktree が
    // 見えたときだけ。controller のリポジトリで流れたら unmet になり、
    // COMPLETE は選ばれない。
    expect(lastJson()).toMatchObject({
      ran: true,
      status: "COMPLETED",
      action: { type: "COMPLETE" },
    });

    await main(["get", "worktree-goal"]);
    const payload = lastJson() as {
      verifications: { criterionId: string; result: string }[];
      snapshot: { facts: { key: string; value: unknown }[] } | null;
    };

    expect(payload.verifications).toEqual([
      expect.objectContaining({ criterionId: "ac-1", result: "passed" }),
    ]);

    // 観測側も同じ根に向いていることを見る。local.branch が main のままなら、
    // 未 commit の関門（design.md §10-11）は本番で一度も発火しない。
    expect(payload.snapshot?.facts).toContainEqual(
      expect.objectContaining({ key: "local.branch", value: "entelecheia/worktree-goal" }),
    );
  });
});
