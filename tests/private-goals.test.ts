import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitInfoExcludePath, gitWorktree } from "../src/adapters/local.js";
import { agentContextPayload, main, parseCommand } from "../src/cli.js";
import { CONFIG_FILENAME } from "../src/domain/goal-config.js";

/**
 * 宣言部を git に載せずに ent を回す（`ent init --private-goals`）。
 *
 * チームのリポジトリで個人が ent を回すと、`.goals/` を commit したくない。
 * だが `.goals/` を無視すると2つ壊れる。
 *
 * - 無視の行を tracked な `.gitignore` に足すと、それ自体がチームのリポジトリへの
 *   変更になる。避けたいのがまさにそれになる
 * - `git worktree add` が持ってくるのは tracked なファイルだけなので、宣言部が
 *   Actor の作業ツリーに現れない。レビュー役は worktree の中の
 *   `.goals/<id>.yaml` を読めと指示されているので、読む材料が消える
 *
 * 前者は書き先を `info/exclude` にして、後者は controller が配って解く。ここでは
 * **無視されているものだけを配る**という条件を軸に固定する。無視されていない
 * パスに置くと、触ってもいない Actor が `protected_path_touched` で止まり、
 * `add --all` がそれを PR の diff に入れる。
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

const GOAL_YAML = "version: 1\ngoal:\n  id: sample-goal\n";
const CONFIG_YAML = "version: 1\nrepository:\n  owner: acme\n";

let root: string;
let repoRoot: string;
let worktreeRoot: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ent-private-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");

  mkdirSync(repoRoot, { recursive: true });
  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# sample\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "init"]);

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "sample-goal.yaml"), GOAL_YAML);
  writeFileSync(join(repoRoot, ".goals", CONFIG_FILENAME), CONFIG_YAML);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `.goals/` をこの checkout だけで無視する。`--private-goals` が書くのと同じ形 */
function excludeGoals(): void {
  const path = gitInfoExcludePath(repoRoot);
  appendFileSync(path ?? "", "\n.goals/\n");
}

describe("宣言部を worktree へ配る", () => {
  it("無視されていれば、Goal と config の両方を置く", async () => {
    excludeGoals();
    const port = gitWorktree(repoRoot, worktreeRoot);

    const worktree = await port.ensure("sample-goal", "main", "sample-goal");

    expect(readFileSync(join(worktree.path, ".goals", "sample-goal.yaml"), "utf8")).toBe(GOAL_YAML);
    expect(readFileSync(join(worktree.path, ".goals", CONFIG_FILENAME), "utf8")).toBe(CONFIG_YAML);
  });

  it("配ったものは git から見えない", async () => {
    // ここが崩れると、触ってもいない Actor が `protected_path_touched` で止まり、
    // `add --all` が宣言部を PR の diff に入れる。
    excludeGoals();
    const port = gitWorktree(repoRoot, worktreeRoot);

    await port.ensure("sample-goal", "main", "sample-goal");

    expect(await port.changedPaths("sample-goal", "main")).toEqual([]);
    expect(await port.commit("sample-goal", "配ったものだけなら commit しない")).toBe(false);
  });

  it("無視されていなければ配らない", async () => {
    // `.goals/` を commit している構成では、worktree が base から持ってくる。
    // ここで上書きすると、その差分が Actor の編集として関門に並ぶ。
    const port = gitWorktree(repoRoot, worktreeRoot);

    const worktree = await port.ensure("sample-goal", "main", "sample-goal");

    expect(existsSync(join(worktree.path, ".goals", "sample-goal.yaml"))).toBe(false);
    expect(await port.changedPaths("sample-goal", "main")).toEqual([]);
  });

  it("goalId を渡さなければ何もしない", async () => {
    excludeGoals();
    const port = gitWorktree(repoRoot, worktreeRoot);

    const worktree = await port.ensure("sample-goal", "main");

    expect(existsSync(join(worktree.path, ".goals"))).toBe(false);
  });

  it("2度目の ensure でも配り直す", async () => {
    // 無視されている＝関門から見えないので、Actor は配られた写しを書き換えられる。
    // 役を起動するたびに置き直せば、レビュー役が読むのは controller の写しになる。
    excludeGoals();
    const port = gitWorktree(repoRoot, worktreeRoot);
    const worktree = await port.ensure("sample-goal", "main", "sample-goal");
    writeFileSync(join(worktree.path, ".goals", "sample-goal.yaml"), "version: 1\n# 書き換えた\n");

    await port.ensure("sample-goal", "main", "sample-goal");

    expect(readFileSync(join(worktree.path, ".goals", "sample-goal.yaml"), "utf8")).toBe(GOAL_YAML);
  });
});

describe("info/exclude の置き場", () => {
  it("git に聞いて絶対パスで返す", async () => {
    // `.git` はディレクトリとは限らない。worktree では gitdir を指すファイルになる。
    const path = gitInfoExcludePath(repoRoot);

    expect(path).not.toBeNull();
    expect(path).toContain("info");
  });

  it("linked worktree からも同じ行が効く", async () => {
    // 共通の `info/exclude` を読むので、1度書けば作業ツリー全部に効く。
    // ここが効かないと、配ったファイルが worktree 側で untracked として見える。
    excludeGoals();
    const port = gitWorktree(repoRoot, worktreeRoot);
    const worktree = await port.ensure("sample-goal", "main", "sample-goal");

    const { stdout } = await run("git", ["check-ignore", "-v", "--", ".goals/sample-goal.yaml"], {
      cwd: worktree.path,
    });

    expect(stdout).toContain("info/exclude");
  });
});

describe("ent init --private-goals", () => {
  let cwd: string;
  let home: string;
  let realHome: string | undefined;
  let stdout: string[];

  beforeEach(() => {
    cwd = process.cwd();
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "ent-private-home-"));
    process.env.HOME = home;
    process.chdir(repoRoot);

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
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("引数として受け取る", () => {
    expect(parseCommand(["init", "--private-goals"])).toMatchObject({
      kind: "init",
      privateGoals: true,
    });
    // 付けなければ既定のまま。いま init を叩いている側の形を変えない。
    expect(parseCommand(["init"])).toEqual({ kind: "init" });
  });

  it("agent-context に載る", () => {
    const flags = agentContextPayload().commands.find((c) => c.name === "init")?.flags ?? [];

    expect(flags.map((flag) => flag.name)).toContain("--private-goals");
  });

  it("tracked な .gitignore を1文字も触らない", async () => {
    // **これがこのモードの要点になる。** 1行足すだけでもチームのリポジトリへの
    // 変更になり、避けたいのがまさにそれになる。
    expect(await main(["init", "--private-goals"])).toBe(0);

    expect(existsSync(join(repoRoot, ".gitignore"))).toBe(false);
    expect(await git(repoRoot, ["status", "--porcelain"])).toBe("");
  });

  it("info/exclude に .goals/ を書く", async () => {
    await main(["init", "--private-goals"]);

    const path = gitInfoExcludePath(repoRoot) ?? "";
    expect(readFileSync(path, "utf8")).toContain(".goals/");
  });

  it("二重に足さない", async () => {
    await main(["init", "--private-goals"]);
    await main(["init", "--private-goals"]);

    const path = gitInfoExcludePath(repoRoot) ?? "";
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() === ".goals/");
    expect(lines).toHaveLength(1);
  });

  it("doctor の state_ignored は通る", async () => {
    // `.goals/` はその下の `.state/` も覆う。判定は `git check-ignore` なので、
    // 書いた行がそのままでなくても通る。
    await main(["init", "--private-goals"]);

    await main(["doctor"]);

    const checks = (
      JSON.parse(stdout.at(-1) ?? "null") as { checks: { name: string; result: string }[] }
    ).checks;
    expect(checks.find((check) => check.name === "state_ignored")?.result).toBe("ok");
  });

  it("付けなければ、これまでどおり .gitignore に書く", async () => {
    expect(await main(["init"])).toBe(0);

    expect(readFileSync(join(repoRoot, ".gitignore"), "utf8")).toContain(".goals/.state/");
  });
});
