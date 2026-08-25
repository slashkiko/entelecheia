import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { GoalConfig } from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import { MAX_LLM_RETRIES } from "../src/domain/llm-call.js";
import { type PlanProbes, type PlanRequest, planGoals } from "../src/usecase/plan.js";

/**
 * `ent plan` が書いた宣言が、**手で直さなくても使える**こと。
 *
 * `tests/plan.test.ts` が見ているのは「落ちる提案を1本も書かない」という集合の扱いで、
 * ここで見るのはその手前——**書かれた1本の中身が、既存の手書きの宣言と同じ性質を
 * 持っているか**になる。2026-08-25 に生成した `calculate-metered-cost-from-raw-logs`
 * が持っていなかったものが、そのまま2つの describe になっている。
 *
 * 1. `setup: []` を書き出したせいで `.goals/config.yaml` の setup が打ち消され、
 *    worktree で `mise trust` も依存インストールも走らなかった
 * 2. criteria が `type: command` だけだったので、誰のレビューも経ずに COMPLETED
 *    になった（PR #7）
 *
 * **どちらもプロンプトの文言では見ない。** planner に頼んで得られるのは確認できない
 * 遵守でしかない（design.md 10-11）ので、見るのは書き出した YAML そのものと、
 * 提案を落とす検証の側になる。プロンプトに何が書いてあるかを assert すると、
 * 文言を足しただけで緑になるテストになり、この Goal が塞ごうとしているものを
 * テスト自身が素通りさせる。
 */

/** 1本分の提案。既定では `setup` を書かない——planner が省いた形になる */
function proposedGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alpha",
    name: "goal alpha",
    desired_state: "alpha is finished.",
    depends_on: [],
    acceptance_criteria: [
      { id: "ac-1", description: "the tests pass", verification: { type: "command", run: "true" } },
      {
        id: "ac-2",
        description: "a person read the result",
        verification: { type: "human", prompt: "confirm the output is what you wanted" },
      },
    ],
    context: { background: "why", constraints: ["do not touch tests"], references: [] },
    ...overrides,
  };
}

function proposal(goals: Record<string, unknown>[]): Record<string, unknown> {
  return { rationale: "split by layer", goals };
}

interface Harness {
  probes: PlanProbes;
  /** `writeGoalFile` が呼ばれた分。slug → 本文 */
  written: Map<string, string>;
  /** stderr に出たもの。断った理由が人間に届いているかを、ここで読む */
  stderr(): string;
}

function harness(response: unknown): Harness {
  const written = new Map<string, string>();
  const errors: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });

  return {
    written,
    stderr: () => errors.join(""),
    probes: {
      // 同じものを返し続ける。落ちる提案は `MAX_LLM_RETRIES` 回まで投げ直されるので、
      // 直らない提案がどう断られるかは、使い切った後の出力に出る。
      planner: { propose: async () => response },
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

/**
 * `.goals/config.yaml` にあたるもの。**キーの有無で敷かれるかが決まる**側の相手役。
 *
 * `setup` を書き出したかどうかは、YAML のキーを見れば分かる。ただし本当に困るのは
 * キーの見た目ではなく「repo スコープの setup が届かない」ことなので、そこまで
 * 実際に通す（`mergeGoalConfig`）。
 */
const CONFIG: GoalConfig = { version: 1, setup: ["mise trust", "pnpm install"] };

/** 書き出された YAML を、生のオブジェクトとして読む */
function raw(body: string): Record<string, unknown> {
  return parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("ent plan が書き出す setup", () => {
  it("planner が提案しなければ、setup キーごと書かない", async () => {
    const { probes, written } = harness(proposal([proposedGoal()]));

    expect(await planGoals(REQUEST, probes)).toBe(0);
    const body = written.get("alpha") ?? "";

    // `setup: []` が残っていると、`mergeGoalConfig` はそれを「書いた」と読む。
    // キーの有無でしか区別が付かないので、値ではなくキーを見る。
    expect(Object.hasOwn(raw(body), "setup")).toBe(false);
    expect(body).not.toContain("setup:");

    // 見た目だけでなく、repo スコープの宣言が実際に下へ敷けること。ここが
    // 通らないと、生成された Goal の worktree でだけ何も走らない状態に戻る。
    expect(parseGoal(body, "alpha", CONFIG).setup).toEqual(["mise trust", "pnpm install"]);
  });

  it("明示的な [] は書き出され、config の setup を敷かせない", async () => {
    const { probes, written } = harness(proposal([proposedGoal({ setup: [] })]));

    expect(await planGoals(REQUEST, probes)).toBe(0);
    const body = written.get("alpha") ?? "";

    // 「空にしたつもり」を尊重する既存の意味は変えない。空だから落とす、にすると
    // 書いた覚えのないコマンドが config から生えてくる。
    expect(Object.hasOwn(raw(body), "setup")).toBe(true);
    expect(raw(body).setup).toEqual([]);
    expect(parseGoal(body, "alpha", CONFIG).setup).toEqual([]);
  });

  it("提案された setup は、そのまま書き出される", async () => {
    const { probes, written } = harness(
      proposal([proposedGoal({ setup: ["pnpm install --frozen-lockfile"] })]),
    );

    expect(await planGoals(REQUEST, probes)).toBe(0);
    const body = written.get("alpha") ?? "";

    expect(raw(body).setup).toEqual(["pnpm install --frozen-lockfile"]);
    expect(parseGoal(body, "alpha", CONFIG).setup).toEqual(["pnpm install --frozen-lockfile"]);
  });
});

describe("ent plan が求める type: human", () => {
  /** `type: human` を持たない criteria。VERIFY が自力で全部満たせる形になる */
  const withoutHuman = [
    { id: "ac-1", description: "the tests pass", verification: { type: "command", run: "true" } },
    {
      id: "ac-2",
      description: "CI is green",
      verification: { type: "fact", key: "github.ci.failed_job_count", equals: 0 },
    },
  ];

  it("type: human を1つも持たない提案は、1本も書かない", async () => {
    const { probes, written, stderr } = harness(
      proposal([proposedGoal({ acceptance_criteria: withoutHuman })]),
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);

    // 「何が足りないか」と「どう直すか」の両方が出ていること。`type: human` と
    // だけ出して終わると、読んだ人はどのキーをどこへ足すのかを当てることになる。
    const message = stderr();
    expect(message).toContain("alpha");
    expect(message).toContain("type: human");
    expect(message).toContain('"prompt"');
    expect(message).toContain("COMPLETED");
  });

  it("集合の1本でも欠けていれば、揃っている側も書かない", async () => {
    const { probes, written, stderr } = harness(
      proposal([proposedGoal(), proposedGoal({ id: "bravo", acceptance_criteria: withoutHuman })]),
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    // 半分だけ書かれた `.goals/` を作らないのは、他の検証と同じ扱いになる。
    expect(written.size).toBe(0);
    // 名指しするのは欠けている側だけ。全部を挙げると、どれを直すのか分からない。
    expect(stderr()).toContain("bravo");
  });

  it("落ちた提案は、投げ直しを使い切ってから断る", async () => {
    let calls = 0;
    const { probes, written } = harness(
      proposal([proposedGoal({ acceptance_criteria: withoutHuman })]),
    );
    const counted: PlanProbes = {
      ...probes,
      planner: {
        propose: async (prompt) => {
          calls += 1;
          return probes.planner.propose(prompt);
        },
      },
    };

    expect(await planGoals(REQUEST, counted)).toBe(1);
    expect(written.size).toBe(0);
    // スキーマ違反や依存の不在と同じ扱いにする。落ちた理由を添えて投げ直せば
    // 直せる種類のものなので、1回で降りない。
    expect(calls).toBe(MAX_LLM_RETRIES + 1);
  });

  it("type: human が1本あれば、通って書き出される", async () => {
    const { probes, written } = harness(proposal([proposedGoal()]));

    expect(await planGoals(REQUEST, probes)).toBe(0);
    const goal = parseGoal(written.get("alpha") ?? "", "alpha", CONFIG);

    // 書き戻した宣言にも残っていること。検証を通っただけで、書き出す側が
    // criteria を落としていたら意味が無い。
    expect(goal.acceptance_criteria.map((criterion) => criterion.verification.type)).toContain(
      "human",
    );
  });
});
