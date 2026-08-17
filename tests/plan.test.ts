import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_SLUG } from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import { MAX_LLM_RETRIES } from "../src/domain/llm-call.js";
import {
  type ExistingGoal,
  type PlanProbes,
  type PlanRequest,
  planGoals,
} from "../src/usecase/plan.js";

/**
 * `ent plan` が書き出す前に、集合まるごとを検証していること。
 *
 * ここで守りたいのは1つ——**1件でも落ちたら1本も書かない**。半分だけ書かれた
 * `.goals/` は、次に叩く人が何を直せばよいのか判断できない。落ちる理由は
 * スキーマ違反・id 衝突・依存の不在・循環と別々だが、書かないという結果は同じになる。
 */

/** LLM が返す1本分。テストごとに必要な部分だけ差し替える */
function proposedGoal(id: string, dependsOn: string[] = []): Record<string, unknown> {
  return {
    id,
    name: `goal ${id}`,
    desired_state: `${id} is finished.`,
    depends_on: dependsOn,
    setup: [],
    acceptance_criteria: [
      { id: "ac-1", description: "the tests pass", verification: { type: "command", run: "true" } },
    ],
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
  /** planner に渡ったプロンプト。再試行のたびに増える */
  prompts: string[];
}

function harness(responses: readonly unknown[], existing: readonly ExistingGoal[] = []): Harness {
  const written = new Map<string, string>();
  const prompts: string[] = [];
  let call = 0;
  return {
    written,
    prompts,
    probes: {
      planner: {
        propose: async (prompt) => {
          prompts.push(prompt);
          const response = responses[Math.min(call, responses.length - 1)];
          call += 1;
          if (response instanceof Error) {
            throw response;
          }
          return response;
        },
      },
      repository: () => ({
        kind: "resolved",
        owner: "slashkiko",
        name: "entelecheia",
        defaultBranch: "main",
      }),
      existingGoals: () => existing,
      writeGoalFile: (slug, body) => {
        written.set(slug, body);
        return `.goals/${slug}.yaml`;
      },
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    },
  };
}

const REQUEST: PlanRequest = { desire: "add plan to the CLI", max: 5, dryRun: false, json: true };

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("ent plan", () => {
  it("妥当な分解は、依存の順序ごと書き出される", async () => {
    const { probes, written } = harness([
      proposal([proposedGoal("alpha"), proposedGoal("bravo", ["alpha"])]),
    ]);

    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha", "bravo"]);

    // 書き出したものは、そのまま `ent start` に渡せる宣言になっている。
    const bravo = parseGoal(written.get("bravo") ?? "", "bravo");
    expect(bravo.goal.depends_on).toEqual(["alpha"]);
    expect(bravo.repository).toMatchObject({
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    });
  });

  it("config を id にした提案は、1本も書かずに断る", async () => {
    // `existingGoals` は `.goals/config.yaml` を Goal に数えないので、id 衝突の
    // 検査は素通りする。名指しで弾かないと `writeGoalFile` の EEXIST まで落ちて、
    // 何が起きたのかが読めない。
    const { probes, written } = harness([
      proposal([proposedGoal(CONFIG_SLUG), proposedGoal("alpha")]),
    ]);

    expect(await planGoals(REQUEST, probes)).not.toBe(0);
    expect(written.size).toBe(0);
  });

  it("関門の入力は LLM ではなく ent が埋める", async () => {
    const { probes, written } = harness([proposal([proposedGoal("alpha")])]);
    await planGoals(REQUEST, probes);

    const alpha = parseGoal(written.get("alpha") ?? "", "alpha");
    // 雛形と同じ6ゲート。書かなかったゲートは「許可」として効くので、
    // 生成した Goal だけが緩いところから始まる形を作らない。
    expect(alpha.policies.require_human_approval).toEqual([
      "merge",
      "force_push",
      "push_to_default_branch",
      "deploy",
      "secret_access",
      "external_send",
    ]);
    // 下限は宣言が空でも必ず混ざる。
    expect(alpha.policies.protected_paths).toContain("src/controller/**");
    expect(alpha.policies.protected_paths).toContain(".goals/**");
  });

  it("LLM が repository / policies / budget を書いてきたら採用しない", async () => {
    // 書ける形にしていないので、足された時点で strictObject が落とす。
    // ここが通ると、関門の入力を生成側が書ける経路ができる。
    const { probes, written } = harness([
      proposal([{ ...proposedGoal("alpha"), policies: { protected_paths: [] } }]),
    ]);

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
  });

  it("既存の宣言と id が衝突したら、1本も書かない", async () => {
    const { probes, written } = harness(
      [proposal([proposedGoal("alpha"), proposedGoal("bravo")])],
      [{ slug: "alpha", dependsOn: [] }],
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    // 衝突していない bravo も書かれない。半分だけ書かれた状態を作らない。
    expect(written.size).toBe(0);
  });

  it("depends_on の指す先が無ければ、1本も書かない", async () => {
    const { probes, written } = harness([proposal([proposedGoal("alpha", ["nowhere"])])]);

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
  });

  it("集合の中で循環していたら、1本も書かない", async () => {
    const { probes, written } = harness([
      proposal([proposedGoal("alpha", ["bravo"]), proposedGoal("bravo", ["alpha"])]),
    ]);

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
  });

  it("既存の Goal を経由して輪が閉じる場合も、1本も書かない", async () => {
    // 人間が先に `depends_on: [alpha]` と書いていて（doctor では「不在」）、
    // plan がその alpha を書き、alpha が既存を指す——集合の中だけを見ると気づけない。
    const { probes, written } = harness(
      [proposal([proposedGoal("alpha", ["charlie"])])],
      [{ slug: "charlie", dependsOn: ["alpha"] }],
    );

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
  });

  it("--max を超える本数は採用しない", async () => {
    const { probes, written } = harness([
      proposal([proposedGoal("alpha"), proposedGoal("bravo"), proposedGoal("charlie")]),
    ]);

    expect(await planGoals({ ...REQUEST, max: 2 }, probes)).toBe(1);
    expect(written.size).toBe(0);
  });

  it("落ちた理由を添えて投げ直し、通れば書き出す", async () => {
    const { probes, written, prompts } = harness([
      proposal([proposedGoal("alpha", ["nowhere"])]),
      proposal([proposedGoal("alpha")]),
    ]);

    expect(await planGoals(REQUEST, probes)).toBe(0);
    expect([...written.keys()]).toEqual(["alpha"]);
    // 2回目のプロンプトには、1回目が落ちた理由が入っている。入っていないと
    // 同じものが返るだけで、再試行が回数を使うだけになる。
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("nowhere");
  });

  it("再試行を使い切ったら、1本も書かずに断る", async () => {
    const { probes, written, prompts } = harness([proposal([proposedGoal("alpha", ["nowhere"])])]);

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
    expect(prompts).toHaveLength(MAX_LLM_RETRIES + 1);
  });

  it("planner を呼べなかったら、投げ直さずに降りる", async () => {
    const { probes, written, prompts } = harness([new Error("not logged in")]);

    expect(await planGoals(REQUEST, probes)).toBe(1);
    expect(written.size).toBe(0);
    // 呼べない状態は投げ直しても直らない。フルセッション分のトークンを捨てない。
    expect(prompts).toHaveLength(1);
  });

  it("--dry-run では、検証まで済ませて1本も書かない", async () => {
    const { probes, written } = harness([
      proposal([proposedGoal("alpha"), proposedGoal("bravo", ["alpha"])]),
    ]);

    expect(await planGoals({ ...REQUEST, dryRun: true }, probes)).toBe(0);
    expect(written.size).toBe(0);
  });

  it(".goals/ が無ければ、planner を呼ばずに断る", async () => {
    const { probes, prompts } = harness([proposal([proposedGoal("alpha")])]);
    const withoutGoalsDir: PlanProbes = { ...probes, existingGoals: () => null };

    expect(await planGoals(REQUEST, withoutGoalsDir)).toBe(1);
    // 書けないと分かっている状態でトークンを使わない。
    expect(prompts).toHaveLength(0);
  });

  it("対象リポジトリが決まらなければ、planner を呼ばずに断る", async () => {
    const { probes, prompts } = harness([proposal([proposedGoal("alpha")])]);
    const unresolved: PlanProbes = {
      ...probes,
      repository: () => ({ kind: "unresolved", reason: "pass --repo <owner>/<name>" }),
    };

    expect(await planGoals(REQUEST, unresolved)).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  it("プロンプトには、実在する観測キーと既存の id が載る", async () => {
    const { probes, prompts } = harness(
      [proposal([proposedGoal("alpha")])],
      [{ slug: "charlie", dependsOn: [] }],
    );
    await planGoals(REQUEST, probes);

    const prompt = prompts[0] ?? "";
    // キーの一覧はコード側にしか無い。渡さないと当てられず、再試行を使い切る。
    expect(prompt).toContain("github.pr.unresolved_threads");
    expect(prompt).toContain("charlie");
    expect(prompt).toContain("add plan to the CLI");
  });
});
