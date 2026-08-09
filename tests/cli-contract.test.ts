import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

/**
 * CLI が文書で宣言している契約を、実物で確かめる。
 *
 * `.claude/skills/ent/SKILL.md` と `.goals/agent-friendly-cli.yaml` が
 * 約束していることのうち、`main()` の層でしか壊れないものを見る。
 * Port を注入するテストは `tick()` までしか通らないので、CLI が tick の前後で
 * 何を書いているかは、どのテストからも見えていなかった。
 *
 * criteria は `exit 0` の1本にしてある。guard が COMPLETE を選ぶ経路を通るので
 * LLM も Actor も GitHub も呼ばれない。
 */

const run = promisify(execFile);

function goalYaml(id: string): string {
  return `version: 1
goal:
  id: ${id}
  name: 契約の確認
  desired_state: |
    CLI が宣言どおりに振る舞う。
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
    CLI の契約を実物で確かめる。
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
}

const GIT_IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

let repoRoot: string;
let cwd: string;
let stdout: string[];

function lastJson(): unknown {
  return JSON.parse(stdout.at(-1) ?? "null");
}

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-contract-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# contract\n");
  await run("git", [...GIT_IDENTITY, "add", "."], { cwd: repoRoot });
  await run("git", [...GIT_IDENTITY, "commit", "-m", "init"], { cwd: repoRoot });

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "contract-goal.yaml"), goalYaml("contract-goal"));

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

describe("--dry-run は書かない", () => {
  it("--dry-run --pr が観測対象を書き換えない", async () => {
    // SKILL.md:「Actor の起動と PR への書き込みは起きない。snapshot /
    // verifications / decision / status も書かない」。
    //
    // だが setObserveTarget は tick() の前、dry-run の分岐の外で呼ばれている。
    // prNumber は GoalState の一部で ent get が出すので、覗いたつもりの一回が
    // 次の本番ティックの観測先を恒久的に差し替えてしまう。
    await main(["start", "contract-goal"]);

    expect(await main(["run", "contract-goal", "--dry-run", "--pr", "42"])).toBe(0);

    await main(["get", "contract-goal"]);
    const payload = lastJson() as { state: { prNumber: number | null } | null };

    expect(payload.state?.prNumber ?? null).toBeNull();
  });

  it("--dry-run は DB を作らない", async () => {
    // start していない Goal に --dry-run を掛けたとき、状態の入れ物ごと
    // 出来てしまうと「覗くだけ」ではなくなる。
    expect(await main(["run", "contract-goal", "--dry-run"])).toBe(0);

    expect(existsSync(join(repoRoot, ".goals", ".state", "goals.db"))).toBe(false);
  });
});

describe("start していない Goal は回らない", () => {
  it("start 前の run は Goal を ACTIVE にしない", async () => {
    // design.md:「Goal YAML のレビューがそのまま承認ゲートを担うので、
    // ent start は DRAFT から ACTIVE に直行する」。
    // start を挟まない run がそのゲートを飛ばせるなら、ゲートは無い。
    //
    // controller 側には「Goal が登録されていない」で止まる分岐があるが、
    // cli.ts が tick() の前に upsert するので本番では到達しない。
    expect(await main(["run", "contract-goal"])).toBe(0);

    expect(lastJson()).toMatchObject({ ran: false });

    await main(["list"]);
    const listed = lastJson() as { id: string; status: string }[];
    expect(listed.map((entry) => entry.status)).not.toContain("COMPLETED");
    expect(listed.map((entry) => entry.status)).not.toContain("ACTIVE");
  });
});

describe("slug は .goals/ の外を指せない", () => {
  it("相対パスを含む slug を受け付けない", async () => {
    // slug はそのまま join(repoRoot, ".goals", `${slug}.yaml`) に入る。
    // id の一致はローダーが見るが、それはファイル名だけでディレクトリは
    // 縛らない。ツリー外の Goal を読めると、その setup / verification.run が
    // そのままシェルで走る。
    mkdirSync(join(repoRoot, "outside"), { recursive: true });
    writeFileSync(join(repoRoot, "outside", "escape-goal.yaml"), goalYaml("escape-goal"));

    expect(await main(["start", "../outside/escape-goal"])).toBe(2);

    // 読めていないことを、状態が出来ていないことで見る。
    expect(existsSync(join(repoRoot, ".goals", ".state", "goals.db"))).toBe(false);
  });
});
