import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";
import { nothingToDo, type StartProbes } from "../src/usecase/start.js";
import type { CommandResult, CommandRunnerPort } from "../src/verify/index.js";

/**
 * `ent start` が、**着手した時点でやることが残っていない Goal を ACTIVE にしない**こと。
 *
 * `ent plan` は同じ判定を持っている（`tests/plan-refuses-nothing-to-do.test.ts`）が、
 * あれが見るのは plan が書いた提案だけになる。手で書いた Goal と、plan が書いたあとに
 * 人間が criteria を足した Goal を受け持つのはこちらになる。落ちる criterion が1本も
 * 無い状態で start すると、DECIDE は Gap が無いので COMPLETE を選び
 * （`src/decide/index.ts`）、何もしないまま COMPLETED が終端として残る。
 *
 * 見たいのは向きの違う4つになる。
 *
 * 1. 全部通る Goal を start しないこと
 * 2. **実行できないものを「通った」に数えないこと。** `type: fact` と `type: human`、
 *    それに起動そのものに失敗したコマンドがこれにあたる。数えると、まだ誰も手を
 *    付けていない Goal が入口で止まる。`--force` は無いので、誤って断られた側には
 *    宣言を書き換える以外の逃げ道が無い
 * 3. 断ったティックで状態を残さないこと。DRAFT の行が残ると `ent run` の
 *    「登録されていない」を抜けて、start が拒んだ Goal をそのまま走らせられる
 * 4. 走り出したあとの Goal では検査しないこと。収束の途中では criteria が全部
 *    通るのが正常で、そこで断ると正しく進んでいる Goal ほど start し直せない
 */

const passes: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const fails: CommandResult = { exitCode: 1, stdout: "", stderr: "not implemented" };

function command(id: string, run: string): AcceptanceCriterion {
  return { id, description: `${run} passes`, verification: { type: "command", run } };
}

function human(id: string): AcceptanceCriterion {
  return {
    id,
    description: "a person read the result",
    verification: { type: "human", prompt: "confirm the output is what you wanted" },
  };
}

function fact(id: string): AcceptanceCriterion {
  return {
    id,
    description: "CI is green",
    verification: { type: "fact", key: "github.ci.failed_job_count", equals: 0 },
  };
}

interface Harness {
  probes: StartProbes;
  /** `criterionProbe` に渡ったコマンド。呼ばれた順に積む */
  probed: string[];
}

/** `outcome` はコマンド1本に対する応答。`Error` を返せば起動に失敗した扱いになる */
function harness(outcome: (command: string) => CommandResult | Error): Harness {
  const probed: string[] = [];
  const criterionProbe: CommandRunnerPort = {
    run: async (command) => {
      probed.push(command);
      const result = outcome(command);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
  return { probes: { criterionProbe }, probed };
}

describe("着手検査", () => {
  it("type: command の criteria が全部通る Goal は断る", async () => {
    const { probes, probed } = harness(() => passes);

    const refusal = await nothingToDo(
      "nothing-left",
      [command("ac-1", "mise run verify"), command("ac-2", "mise run test")],
      probes,
    );

    expect(refusal).not.toBeNull();
    expect(probed).toEqual(["mise run verify", "mise run test"]);
  });

  it("断る理由に、通ってしまった criterion の id が並ぶ", async () => {
    const { probes } = harness(() => passes);

    const refusal = await nothingToDo(
      "nothing-left",
      [command("ac-1", "mise run verify"), human("ac-3")],
      probes,
    );

    // 断られた側が次に読むのはこの id で、どれを書き直せば着手できるかが
    // そこで決まる。id が出ないと、宣言を頭から読み直すことになる。
    expect(refusal).toContain("ac-1");
    expect(refusal).toContain("nothing-left");
  });

  it("1本でも落ちれば start してよい", async () => {
    const { probes } = harness((command) => (command === "mise run test" ? fails : passes));

    expect(
      await nothingToDo(
        "has-work",
        [command("ac-1", "mise run verify"), command("ac-2", "mise run test")],
        probes,
      ),
    ).toBeNull();
  });

  it("落ちた1本より後ろのコマンドは走らせない", async () => {
    const { probes, probed } = harness((command) => (command === "first" ? fails : passes));

    await nothingToDo("has-work", [command("ac-1", "first"), command("ac-2", "second")], probes);

    // 結論が変わらないコマンドに20秒を払わない。`ent start` は人間が対話的に
    // 叩くコマンドなので、待たせる長さそのものが挙動になる。
    expect(probed).toEqual(["first"]);
  });

  it("fact と human しか無い Goal は、コマンドを1本も走らせずに start してよい", async () => {
    const { probes, probed } = harness(() => passes);

    // 実行できるものが1本も無い。**空集合を「全部通った」と読まない。**
    // 読むと、まだ誰も手を付けていない Goal が入口で止まる。controller の
    // commit も同じ読み方で、`machineCriteriaSatisfied` は空集合に false を返す。
    expect(await nothingToDo("observed-only", [fact("ac-1"), human("ac-2")], probes)).toBeNull();
    expect(probed).toEqual([]);
  });

  it("コマンドの起動そのものに失敗したら、「通った」に数えない", async () => {
    const { probes } = harness((command) =>
      command === "mise run test" ? new Error("spawn ENOENT") : passes,
    );

    // 確かめられなかったことは確かめられなかったとして扱う（design.md §3.1）。
    // `setup` を流さないので、依存を入れていないチェックアウトでは起動に失敗する
    // criterion が出る。その失敗は着手を通す側に倒す。
    expect(
      await nothingToDo(
        "cannot-tell",
        [command("ac-1", "mise run verify"), command("ac-2", "mise run test")],
        probes,
      ),
    ).toBeNull();
  });
});

/**
 * ここから下は `main()` を実物のリポジトリと実物の SQLite に通す。
 *
 * 見たいのは「断ったときに状態を残さない」で、これは usecase 側には現れない。
 * `store.upsertGoal` が未登録の Goal に DRAFT の行を作り、`ent run` の承認ゲートは
 * その行の有無だけを見ているので、検査を upsert より後ろに置くと、start が拒んだ
 * Goal を run が拾って走らせられる。
 */

const run = promisify(execFile);

/** ac-1 が無変更のチェックアウトで通る。start は断るはず */
const NOTHING_TO_DO = `version: 1
goal:
  id: nothing-to-do-goal
  name: やることが残っていない Goal
  desired_state: |
    既に通る検証しか宣言していない。
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
    着手検査を実物で確かめる。
  constraints: []
  references: []
policies: {}
budget:
  max_actor_runs: 5
  max_reconciles: 10
  max_wall_clock: 1h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

/** ac-1 が着手時点で落ちる。start は通すはず */
const HAS_WORK = NOTHING_TO_DO.replace("nothing-to-do-goal", "has-work-goal").replace(
  "run: exit 0",
  "run: exit 1",
);

let repoRoot: string;
let cwd: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-start-gate-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# gate\n");
  const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
  await run("git", [...identity, "add", "."], { cwd: repoRoot });
  await run("git", [...identity, "commit", "-m", "init"], { cwd: repoRoot });

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "nothing-to-do-goal.yaml"), NOTHING_TO_DO);
  writeFileSync(join(repoRoot, ".goals", "has-work-goal.yaml"), HAS_WORK);

  // GitHub を観測させない。トークンがあると Port が実際に叩きに行く。
  process.env.GITHUB_TOKEN = "";
  process.env.GH_TOKEN = "";

  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("ent start の入口", () => {
  it("既に全部通る Goal は 1 で断り、理由を stderr に出す", async () => {
    expect(await main(["start", "nothing-to-do-goal"])).toBe(1);

    expect(stderr.join("")).toContain("ac-1");
    expect(stdout.join("")).not.toContain("ACTIVE");
  });

  it("断った Goal は登録されないので、ent run も拾わない", async () => {
    await main(["start", "nothing-to-do-goal"]);

    // 検査を `store.upsertGoal` より後ろに置くと、ここで DRAFT の行が残り、
    // run の「登録されていない」を抜ける。唯一の承認ゲートが飛ばせる形になる。
    expect(await main(["run", "nothing-to-do-goal"])).toBe(0);
    expect(stderr.join("")).toContain("is not registered");
  });

  it("着手時点で落ちる criterion があれば ACTIVE になる", async () => {
    expect(await main(["start", "has-work-goal"])).toBe(0);

    expect(stdout.at(-1)).toContain("has-work-goal: ACTIVE");
  });

  it("走り出したあとの Goal では検査しない", async () => {
    await main(["start", "has-work-goal"]);

    // criterion を「通る」側に書き換えても、2回目の start は断らない。
    // 収束の途中では criteria が全部通るのが正常な状態になる。
    writeFileSync(
      join(repoRoot, ".goals", "has-work-goal.yaml"),
      HAS_WORK.replace("run: exit 1", "run: exit 0"),
    );

    expect(await main(["start", "has-work-goal"])).toBe(0);
  });
});
