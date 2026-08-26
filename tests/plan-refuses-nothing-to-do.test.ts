import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LLM_RETRIES } from "../src/domain/llm-call.js";
import { type PlanProbes, type PlanRequest, planGoals } from "../src/usecase/plan.js";
import type { CommandResult } from "../src/verify/index.js";

/**
 * `ent plan` が、**宣言時点で既にやることが無い Goal を書かない**こと。
 *
 * 2026-08-25 に生成された `calculate-metered-cost-from-raw-logs` の ac-1 は
 * `mise run verify` 1本だった。無変更のチェックアウトで既に通る。DECIDE は Gap が
 * 無ければ COMPLETE を選ぶ（`src/decide/index.ts`）ので、`ent start` すると何もせず
 * 1ティック目で完了扱いになる。頼んで得られるのは確認できない遵守でしかない
 * （design.md 10-11）ので、プロンプトの文言ではなく**実際に走らせた結果**で見る。
 *
 * ここで見たいのは向きの違う2つで、順番も意味を持つ。
 *
 * 1. 全部通る提案を書かないこと
 * 2. **実行できないものを「通った」に数えないこと。** `type: fact` と `type: human` は
 *    plan には判定できない。数えると、その2つだけで書かれた提案が「全部通っている」と
 *    誤判定され、まだ誰も手を付けていない Goal が黙って消える。落とす側の誤りより
 *    落とさない側の誤りのほうが害が小さい（余分に書かれた Goal は人間が消せるが、
 *    書かれなかった Goal は消えたことにすら気づけない）
 */

/** `type: command` の criterion 1本 */
function command(id: string, run: string): Record<string, unknown> {
  return { id, description: `${run} passes`, verification: { type: "command", run } };
}

/** `type: human` の criterion 1本。これが無い提案は別の検査で落ちる */
function human(id: string): Record<string, unknown> {
  return {
    id,
    description: "a person read the result",
    verification: { type: "human", prompt: "confirm the output is what you wanted" },
  };
}

/** `type: fact` の criterion 1本。OBSERVE の結果が要るので plan には判定できない */
function fact(id: string): Record<string, unknown> {
  return {
    id,
    description: "CI is green",
    verification: { type: "fact", key: "github.ci.failed_job_count", equals: 0 },
  };
}

function proposedGoal(id: string, criteria: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id,
    name: `goal ${id}`,
    desired_state: `${id} is finished.`,
    depends_on: [],
    setup: [],
    acceptance_criteria: criteria,
    context: { background: "why", constraints: ["do not touch tests"], references: [] },
  };
}

function proposal(goals: Record<string, unknown>[]): Record<string, unknown> {
  return { rationale: "split by layer", goals };
}

interface Harness {
  probes: PlanProbes;
  /** `writeGoalFile` が呼ばれた分。slug → 本文 */
  written: Map<string, string>;
  /** `criterionProbe` に渡ったコマンド。呼ばれた順に積む */
  probed: string[];
  /** planner が呼ばれた回数。投げ直しのたびに増える */
  proposals(): number;
  /** stderr に出たもの。断った理由が人間に届いているかを、ここで読む */
  stderr(): string;
}

const passes: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const fails: CommandResult = { exitCode: 1, stdout: "", stderr: "not implemented" };

/**
 * `outcome` は criterion のコマンド1本に対する応答。`Error` を返せば
 * 「実行そのものに失敗した」——`CommandRunnerPort` はそこで throw すると決めている。
 */
function harness(
  response: unknown,
  outcome: (command: string) => CommandResult | Error = () => passes,
): Harness {
  const written = new Map<string, string>();
  const probed: string[] = [];
  const errors: string[] = [];
  let calls = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });

  return {
    written,
    probed,
    proposals: () => calls,
    stderr: () => errors.join(""),
    probes: {
      // 同じものを返し続ける。落ちる提案は `MAX_LLM_RETRIES` 回まで投げ直されるので、
      // 直らない提案がどう断られるかは、使い切った後の出力に出る。
      planner: {
        propose: async () => {
          calls += 1;
          return response;
        },
      },
      criterionProbe: {
        run: async (command: string) => {
          probed.push(command);
          const result = outcome(command);
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
      },
      repository: () => ({
        kind: "resolved",
        owner: "slashkiko",
        name: "entelecheia",
        defaultBranch: "main",
      }),
      existingGoals: () => [],
      writeGoalFile: (slug, body) => {
        written.set(slug, body);
        return `.goals/${slug}.yaml`;
      },
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    },
  };
}

const REQUEST: PlanRequest = { desire: "add plan to the CLI", max: 5, dryRun: false, json: true };

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("宣言時点で全部通る提案", () => {
  it("type: command が全部通る Goal は、1本も書かれない", async () => {
    const { probes, written, probed, stderr } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")])]),
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
    // 提案オブジェクトを読んだだけでは分からない。実際に走らせて判定していること。
    expect(probed).toContain("mise run verify");

    // 何が起きたのかと、どう直すのかの両方が出ていること。id を出さずに断ると、
    // 集合のどれが「やることが無い」のかを読んだ人が当てることになる。
    const message = stderr();
    expect(message).toContain("alpha");
    expect(message).toContain("already passes");
    expect(message).toContain("COMPLETED");
  });

  it("1本でも落ちれば、その Goal は書き出される", async () => {
    // 「やることが残っている」の側。ここが緑でないと、検査は plan を丸ごと
    // 使えなくしているだけになる。
    const { probes, written } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "pnpm exec vitest run"), human("ac-2")])]),
      () => fails,
    );

    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
  });

  it("通る criterion と落ちる criterion が混ざっていれば、書き出される", async () => {
    const { probes, written } = harness(
      proposal([
        proposedGoal("alpha", [
          command("ac-1", "mise run verify"),
          command("ac-2", "pnpm exec vitest run tests/new.test.ts"),
          human("ac-3"),
        ]),
      ]),
      (run) => (run === "mise run verify" ? passes : fails),
    );

    // 全部通ったときだけ「やることが無い」。1本でも落ちれば、その Goal には
    // 収束させる先がある。
    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
  });

  it("集合の1本でも「やることが無い」なら、残りも書かない", async () => {
    const { probes, written, stderr } = harness(
      proposal([
        proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")]),
        proposedGoal("bravo", [command("ac-1", "pnpm exec vitest run"), human("ac-2")]),
      ]),
      (run) => (run === "mise run verify" ? passes : fails),
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    // 半分だけ書かれた `.goals/` を作らないのは、他の検証と同じ扱いになる。
    expect(written.size).toBe(0);
    // 名指しするのは「やることが無い」側だけ。全部を挙げると、どれを直すのか分からない。
    expect(stderr()).toContain("alpha");
    expect(stderr()).not.toContain("bravo");
  });

  it("落ちた提案は、投げ直しを使い切ってから断る。同じコマンドは1度しか走らせない", async () => {
    const { probes, written, probed, proposals } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")])]),
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
    // 他の検証と同じ扱いにする。落ちた理由を添えて投げ直せば直せる種類のものなので、
    // 1回で降りない。
    expect(proposals()).toBe(MAX_LLM_RETRIES + 1);
    // plan は最後まで何も書かないので、同じチェックアウトで同じコマンドを2度
    // 走らせても答えは変わらない。`mise run verify` は20秒前後かかる。
    expect(probed).toEqual(["mise run verify"]);
  });

  it("--dry-run でも同じ判定が出る。書く前に分かるほうが直しやすい", async () => {
    const { probes, written, probed } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")])]),
    );

    expect(await planGoals({ ...REQUEST, dryRun: true }, probes)).toBe(1);
    expect(probed).toContain("mise run verify");
    // `--dry-run` はもともと書かないが、通っていれば「would write」を出して 0 で
    // 終わる。ここは断る側なので、そこへ行き着かないことまで見る。
    expect(written.size).toBe(0);
  });

  it("--dry-run で「やることが残っている」提案は、これまでどおり 0 で終わる", async () => {
    const { probes, written } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "pnpm exec vitest run"), human("ac-2")])]),
      () => fails,
    );

    // 検査を足したせいで `--dry-run` の意味が変わっていないこと。
    expect(await planGoals({ ...REQUEST, dryRun: true }, probes)).toBe(0);
    expect(written.size).toBe(0);
  });
});

describe("実行できないものを「通った」に数えない", () => {
  it("fact と human だけの提案は、「全部通っている」と読まれない", async () => {
    const { probes, written, probed } = harness(
      proposal([proposedGoal("alpha", [fact("ac-1"), human("ac-2")])]),
    );

    // `type: command` が空集合。それを「全部通った」と読むのが、この Goal が
    // 塞ごうとしている誤判定そのものになる。
    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
    // fact も human も plan には判定できない。シェルに渡す先が無い。
    expect(probed).toEqual([]);
  });

  it("fact と human は、通ったコマンドの数に足されない", async () => {
    const { probes, written, probed } = harness(
      proposal([
        proposedGoal("alpha", [
          command("ac-1", "pnpm exec vitest run tests/new.test.ts"),
          fact("ac-2"),
          human("ac-3"),
        ]),
      ]),
      () => fails,
    );

    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
    // 走らせるのは `type: command` の `run` だけ。fact の key や human の prompt が
    // シェルへ渡っていない。
    expect(probed).toEqual(["pnpm exec vitest run tests/new.test.ts"]);
  });

  it("fact と human だけの Goal が混じっても、命令の側の判定は変わらない", async () => {
    const { probes, written, stderr } = harness(
      proposal([
        proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")]),
        proposedGoal("bravo", [fact("ac-1"), human("ac-2")]),
      ]),
    );

    // 落ちるのは alpha だけ。bravo が巻き込まれて名指しされると、次の投げ直しで
    // planner は判定できない criteria を直そうとする。
    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
    expect(stderr()).toContain("alpha");
    expect(stderr()).not.toContain("bravo");
  });

  it("実行できなかったコマンドも「通った」に数えない", async () => {
    const { probes, written, probed } = harness(
      proposal([proposedGoal("alpha", [command("ac-1", "mise run verify"), human("ac-2")])]),
      () => new Error("spawn failed: mise not found"),
    );

    // 確かめられなかったことは、確かめられなかったとして扱う（design.md 3.1 が
    // Fact でやっている「観測できなかったものは Fact にしない」と同じ分け方）。
    // 「通った」に倒すと、まだ何もしていない Goal が書かれずに消える。
    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
    expect(probed).toContain("mise run verify");
  });

  it("実行できなかった1本があるだけで、残りが通っていても数えない", async () => {
    const { probes, written } = harness(
      proposal([
        proposedGoal("alpha", [
          command("ac-1", "mise run verify"),
          command("ac-2", "mise run lint"),
          human("ac-3"),
        ]),
      ]),
      (run) => (run === "mise run lint" ? new Error("spawn failed") : passes),
    );

    // 「1本は通った、もう1本は分からない」は「全部通った」ではない。
    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
  });
});
