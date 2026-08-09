import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

/**
 * `ent` を実際のリポジトリと実際の SQLite に対して一周させる。
 *
 * `main()` の配線には長らくテストが無く、テストがあったのは `parseCommand` /
 * `showPayload` / `listPayload` だけだった。README が挙げた3つの断線のうち
 * 「`Store.setObserveTarget()` に本番の呼び出し元が無い」も、この層にあった。
 * Port を注入するテストは配線そのものを見ない（design.md §8）。
 *
 * criteria を `exit 0` の1本にしてあるので、guard が COMPLETE を選ぶ経路を通り、
 * LlmPort も ActorPort も GitHub も呼ばれない。ネットワークにも Agent SDK にも
 * 触れずに、observe → verify → assess → decide → 永続化 → 状態遷移が繋がって
 * いることを確かめられる。
 */

const run = promisify(execFile);

const GOAL_YAML = `version: 1
goal:
  id: smoke-goal
  name: 通しで1周する
  desired_state: |
    ent start から ent run までが一周する。
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
setup: []
acceptance_criteria:
  - id: ac-1
    description: 何もしなくても通る検証
    verification:
      type: command
      run: exit 0
context:
  background: |
    CLI の配線を実物で確かめる。
  constraints: []
  references: []
policies:
  require_human_approval:
    - merge
  protected_paths:
    - src/controller/**
budget:
  max_actor_runs: 5
  max_reconciles: 10
  max_wall_clock: 1h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

let repoRoot: string;
let cwd: string;
let stdout: string[];

/** main() の標準出力を集める。JSON を1本吐くので、そのまま parse できる */
function lastJson(): unknown {
  return JSON.parse(stdout.at(-1) ?? "null");
}

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-cli-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# smoke\n");
  await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], {
    cwd: repoRoot,
  });
  await run(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"],
    {
      cwd: repoRoot,
    },
  );

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "smoke-goal.yaml"), GOAL_YAML);

  // GitHub を観測させない。トークンがあると Port が実際に叩きに行く。
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

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

describe("ent の一周", () => {
  it("start で ACTIVE になり、状態がファイルに残る", async () => {
    expect(await main(["start", "smoke-goal"])).toBe(0);

    expect(stdout.at(-1)).toContain("smoke-goal: ACTIVE");
    // .goals/.state/ は ent start を最初に叩いたときに作られる（README）。
    expect(existsSync(join(repoRoot, ".goals", ".state", "goals.db"))).toBe(true);
  });

  it("run が1ティック回して COMPLETED まで進む", async () => {
    await main(["start", "smoke-goal"]);
    expect(await main(["run", "smoke-goal"])).toBe(0);

    // criteria が全部 VERIFIED で満たされ、結論の出ていない対象も無いので
    // guard が COMPLETE を選ぶ。LLM は呼ばれない（design.md §3.1）。
    expect(lastJson()).toMatchObject({
      ran: true,
      skipped: null,
      status: "COMPLETED",
      action: { type: "COMPLETE" },
      run: null,
    });
  });

  it("get が宣言部と実行時状態をまとめて出す", async () => {
    await main(["start", "smoke-goal"]);
    await main(["run", "smoke-goal"]);
    expect(await main(["get", "smoke-goal"])).toBe(0);

    const payload = lastJson() as {
      goal: { id: string };
      state: { status: string } | null;
      snapshot: { facts: unknown[] } | null;
      verifications: { criterionId: string; result: string }[];
      decision: { action: { type: string } } | null;
    };

    expect(payload.goal.id).toBe("smoke-goal");
    expect(payload.state?.status).toBe("COMPLETED");
    // 観測は実際の git から取れている。local.* の Fact が空なら配線が切れている。
    expect(payload.snapshot?.facts.length).toBeGreaterThan(0);
    expect(payload.verifications).toEqual([
      expect.objectContaining({ criterionId: "ac-1", result: "passed" }),
    ]);
    expect(payload.decision?.action.type).toBe("COMPLETE");
  });

  it("list が登録済みの Goal を出す", async () => {
    await main(["start", "smoke-goal"]);
    await main(["run", "smoke-goal"]);
    expect(await main(["list"])).toBe(0);

    expect(lastJson()).toEqual([
      expect.objectContaining({ id: "smoke-goal", status: "COMPLETED" }),
    ]);
  });

  it("終端の Goal は start し直せない", async () => {
    // COMPLETED を後から取り消せると、§9 の完了判定そのものが意味を失う。
    await main(["start", "smoke-goal"]);
    await main(["run", "smoke-goal"]);

    // 1 を返す。2 は「引数が不正。stderr に有効値が並ぶ」なので、argv が妥当で
    // 打ち直せる値も無いこの経路には当てはまらない。2 を返していたころは、
    // SKILL.md に従うエージェントが argv を変えて再試行し続けられた。
    expect(await main(["start", "smoke-goal"])).toBe(1);

    await main(["list"]);
    expect(lastJson()).toEqual([
      expect.objectContaining({ id: "smoke-goal", status: "COMPLETED" }),
    ]);
  });

  it("終端の Goal は run しても回さない", async () => {
    await main(["start", "smoke-goal"]);
    await main(["run", "smoke-goal"]);
    await main(["run", "smoke-goal"]);

    expect(lastJson()).toMatchObject({ ran: false, status: "COMPLETED" });
  });

  it("知らないサブコマンドは終了コード 2", async () => {
    expect(await main(["nope"])).toBe(2);
  });
});
