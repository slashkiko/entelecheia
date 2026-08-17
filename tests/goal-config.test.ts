import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCommand } from "../src/cli.js";
import { PROTECTED_PATH_FLOOR } from "../src/domain/goal.js";
import {
  CONFIG_FILENAME,
  configTemplate,
  type GoalConfig,
  parseGoalConfig,
} from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";

/**
 * repo スコープの宣言（`.goals/config.yaml`）。
 *
 * `.goals/*.yaml` は31本あり、`repository` も `setup` も `policies` も同じ値の
 * 写しだった。どれも「この Goal で何を達成するか」ではなく「このリポジトリを
 * どう扱うか」で決まる値で、Goal ごとに変える理由が無い。
 *
 * ここで固定したいのは3つになる。
 *
 * - **置いても何も壊れない。** config が無ければ、これまでと1文字も変わらない
 * - **置いたら効く。** ただし Goal が書いた値は必ず残る
 * - **足す2つと置き換える残りが混ざらない。** `protected_paths` と
 *   `require_human_approval` は下限なので足す。他はキー単位で埋める
 */

const run = promisify(execFile);

/** 最小の Goal。`repository` も `policies` も書かない。config が埋める側になる */
const LEAN_GOAL = `version: 1
goal:
  id: lean-goal
  name: config から repo スコープの宣言を受け取る
  desired_state: |
    Goal 固有のことだけを書いた YAML が回る。
acceptance_criteria:
  - id: ac-1
    description: 何もしなくても通る検証
    verification:
      type: command
      run: exit 0
context:
  background: |
    config の検証用。
  constraints: []
  references: []
budget:
  max_actor_runs: 5
  max_reconciles: 10
  max_wall_clock: 1h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

/** repo スコープの値を全部自分で書く Goal。既存の31本がこの形になる */
const FULL_GOAL = `${LEAN_GOAL}repository:
  provider: github
  owner: goal-owner
  name: goal-repo
  default_branch: develop
setup:
  - echo goal-setup
policies:
  require_human_approval:
    - merge
  protected_paths:
    - only/this/goal/**
`;

const CONFIG = `version: 1
repository:
  provider: github
  owner: config-owner
  name: config-repo
  default_branch: main
  ci:
    exclude_workflows:
      - Waiting for review
setup:
  - echo config-setup
policies:
  require_human_approval:
    - deploy
  protected_paths:
    - repo/wide/**
`;

function config(source = CONFIG): GoalConfig {
  return parseGoalConfig(source);
}

describe("config が無いとき", () => {
  it("解析結果はこれまでと1文字も変わらない", () => {
    // 既存の31本を1本も書き換えずに入れられることが、この形の前提になる。
    const withoutConfig = parseGoal(FULL_GOAL, "lean-goal");
    const withNull = parseGoal(FULL_GOAL, "lean-goal", null);

    expect(withNull).toEqual(withoutConfig);
    expect(withoutConfig.repository.owner).toBe("goal-owner");
  });

  it("repo スコープの宣言を書いていない Goal は、config が無ければ落ちる", () => {
    // 黙って既定で埋めない。`repository` が無いまま回ると、観測先が
    // どこにも書かれていない状態で GitHub を叩くことになる。
    expect(() => parseGoal(LEAN_GOAL, "lean-goal")).toThrow();
  });
});

describe("config を敷く", () => {
  it("Goal が書いていないものを埋める", () => {
    const goal = parseGoal(LEAN_GOAL, "lean-goal", config());

    expect(goal.repository.owner).toBe("config-owner");
    expect(goal.repository.default_branch).toBe("main");
    expect(goal.setup).toEqual(["echo config-setup"]);
  });

  it("Goal が書いた値は必ず残る", () => {
    const goal = parseGoal(FULL_GOAL, "lean-goal", config());

    expect(goal.repository.owner).toBe("goal-owner");
    expect(goal.repository.default_branch).toBe("develop");
    // setup は置き換える。足すと pnpm install が2回走る。
    expect(goal.setup).toEqual(["echo goal-setup"]);
  });

  it("粒度はサブツリーではなくキーになる", () => {
    // **ここが効かないと config を置く意味がほとんど無い。** 既存の31本は
    // `repository` の中身を全部書いているので、サブツリー単位で上書きを決めると
    // config の `ci` はどの Goal にも永久に届かない。
    const goal = parseGoal(FULL_GOAL, "lean-goal", config());

    expect(goal.repository.owner).toBe("goal-owner");
    expect(goal.repository.ci?.exclude_workflows).toEqual(["Waiting for review"]);
  });

  it("protected_paths は足す。Goal が1行書いても repo 全体の保護は消えない", () => {
    const goal = parseGoal(FULL_GOAL, "lean-goal", config());

    expect(goal.policies.protected_paths).toContain("only/this/goal/**");
    expect(goal.policies.protected_paths).toContain("repo/wide/**");
    // 下限はこれまでどおり最後に効く。
    for (const path of PROTECTED_PATH_FLOOR) {
      expect(goal.policies.protected_paths).toContain(path);
    }
  });

  it("require_human_approval も足す。repo が閉じたゲートを Goal から開けられない", () => {
    const goal = parseGoal(FULL_GOAL, "lean-goal", config());

    expect(goal.policies.require_human_approval).toContain("merge");
    expect(goal.policies.require_human_approval).toContain("deploy");
  });

  it("重複は畳まれる", () => {
    const goal = parseGoal(FULL_GOAL, "lean-goal", config(`${CONFIG}    - only/this/goal/**\n`));
    const occurrences = goal.policies.protected_paths.filter(
      (path) => path === "only/this/goal/**",
    );

    expect(occurrences).toHaveLength(1);
  });

  it("slug の突き合わせは config を渡しても効く", () => {
    expect(() => parseGoal(LEAN_GOAL, "another-slug", config())).toThrow(/does not match/);
  });
});

describe("config に書けないもの", () => {
  it("budget は断る", () => {
    // 停止条件をリポジトリ側の既定に逃がすと、Goal YAML を読んだだけでは
    // その Goal がいつ止まるのか分からなくなる。
    expect(() => config("version: 1\nbudget:\n  max_actor_runs: 3\n")).toThrow();
  });

  it("Goal 固有のキーは断る", () => {
    expect(() => config("version: 1\ngoal:\n  id: x\n")).toThrow();
    expect(() => config("version: 1\nacceptance_criteria: []\n")).toThrow();
    expect(() => config("version: 1\ncontext:\n  background: x\n")).toThrow();
  });

  it("version が無ければ断る", () => {
    expect(() => config("repository:\n  owner: o\n")).toThrow();
  });
});

describe("進捗の宛先の宣言", () => {
  it("config だけに書いても効く", () => {
    const goal = parseGoal(
      LEAN_GOAL,
      "lean-goal",
      config(`${CONFIG}  progress:\n    report: stdout\n`),
    );

    expect(goal.policies.progress?.report).toBe("stdout");
  });

  it("空白だけの宛先は断る", () => {
    // 既定（pr）に畳むと、投稿しないつもりで書いた1行が黙って PR に出る。
    // `--report` も空白だけは error にしている。
    expect(() => config(`${CONFIG}  progress:\n    report: "   "\n`)).toThrow();
  });

  it("setup: を空で書いたら、config の setup を敷かない", () => {
    // `setup:` とだけ書くと YAML では null になる。書いていないものとして扱うと、
    // 空にしたつもりのところで config のコマンドが黙って走る。
    expect(() => parseGoal(`${LEAN_GOAL}setup:\n`, "lean-goal", config())).toThrow();
  });

  it("Goal 側の宣言が config より強い", () => {
    const goal = parseGoal(
      `${FULL_GOAL}  progress:\n    report: ./out.md\n`,
      "lean-goal",
      config(`${CONFIG}  progress:\n    report: stdout\n`),
    );

    expect(goal.policies.progress?.report).toBe("./out.md");
  });
});

describe("config.yaml という名前", () => {
  it("Goal の slug としては断る", () => {
    // SLUG には一致するので、名指しで断らないと goalSchema の「goal が無い」が出る。
    const command = parseCommand(["run", "config"]);

    expect(command.kind).toBe("error");
    expect(command.kind === "error" ? command.message : "").toContain(CONFIG_FILENAME);
  });

  it("どのサブコマンドでも断る", () => {
    for (const sub of ["start", "get", "abandon"]) {
      expect(parseCommand([sub, "config"]).kind).toBe("error");
    }
  });
});

describe("雛形", () => {
  it("init が置く2本は、重ねれば回せる", () => {
    const goal = parseGoal(
      // 雛形そのものは `tests/protected-floor.test.ts` が見る。ここでは
      // config 側が repository を配れることだけを確かめる。
      LEAN_GOAL,
      "lean-goal",
      parseGoalConfig(configTemplate({ owner: "acme", name: "widgets", defaultBranch: "trunk" })),
    );

    expect(goal.repository.owner).toBe("acme");
    expect(goal.repository.name).toBe("widgets");
    expect(goal.repository.default_branch).toBe("trunk");
    expect(goal.policies.require_human_approval).toContain("merge");
  });
});

describe("回してみる", () => {
  let repoRoot: string;
  let cwd: string;
  let stdout: string[];

  function lastJson(): Record<string, unknown> {
    return JSON.parse(stdout.at(-1) ?? "null") as Record<string, unknown>;
  }

  beforeEach(async () => {
    cwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), "ent-config-"));
    process.chdir(repoRoot);

    await run("git", ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# config\n");
    const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
    await run("git", [...identity, "add", "."], { cwd: repoRoot });
    await run("git", [...identity, "commit", "-m", "init"], { cwd: repoRoot });

    mkdirSync(join(repoRoot, ".goals"), { recursive: true });
    writeFileSync(join(repoRoot, ".goals", "lean-goal.yaml"), LEAN_GOAL);

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

  function writeConfig(body: string): void {
    writeFileSync(join(repoRoot, ".goals", CONFIG_FILENAME), body);
  }

  it("config が repository を配れば、Goal は repository を書かずに start できる", async () => {
    writeConfig(CONFIG);

    expect(await main(["start", "lean-goal"])).toBe(0);
  });

  it("config が壊れていたら、そのファイルを名指しして落ちる", async () => {
    // 素の zod の文言だけだと、`repository.owner` がどちらのファイルの話なのかが
    // 読めない。Goal の slug は打った引数に出ているが、config はどこにも出ない。
    writeConfig("version: 1\nrepository:\n  owner: 7\n");
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    expect(await main(["start", "lean-goal"])).not.toBe(0);
    expect(stderr.join("")).toContain(CONFIG_FILENAME);
  });

  it("doctor は config を壊れた Goal として報告しない", async () => {
    writeConfig(CONFIG);

    await main(["doctor"]);

    // 外さないと `config` が `goal` を持たない Goal として毎回1本 failed になる。
    const checks = (lastJson().checks ?? []) as { name: string; result: string; detail: string }[];
    const goals = checks.find((check) => check.name === "goals");
    expect(goals?.result).toBe("ok");
    expect(goals?.detail).toContain("1 declaration");
  });

  it("config に report: stdout を書けば、フラグ無しでも PR に投稿しない", async () => {
    writeConfig(`${CONFIG}  progress:\n    report: stdout\n`);
    await main(["start", "lean-goal"]);

    expect(await main(["run", "lean-goal"])).toBe(0);

    const report = lastJson().report as { destination: string; written: boolean };
    expect(report.destination).toBe("stdout");
    expect(report.written).toBe(true);
  });

  it("--report を付ければ config より勝つ", async () => {
    // 宣言は毎周に効き、フラグはその1周にしか効かない。逆向きにすると、
    // 宣言で stdout に倒してある Goal の進捗を手元のファイルに出せなくなる。
    writeConfig(`${CONFIG}  progress:\n    report: stdout\n`);
    await main(["start", "lean-goal"]);

    expect(await main(["run", "lean-goal", "--report", join(repoRoot, "out.md")])).toBe(0);

    const report = lastJson().report as { destination: string };
    expect(report.destination).toBe("file");
  });

  it("宣言も指定も無ければ、report の枝ごと出ない", async () => {
    // 宣言を書いていない既存の `.goals/*.yaml` を回している jq を壊さない。
    writeConfig(CONFIG);
    await main(["start", "lean-goal"]);

    expect(await main(["run", "lean-goal"])).toBe(0);
    expect(lastJson()).not.toHaveProperty("report");
  });
});
