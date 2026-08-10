import { describe, expect, it } from "vitest";
import {
  type BudgetUsage,
  type DecideDeps,
  type DecideTarget,
  decide,
  type LlmPort,
} from "../src/decide/index.js";
import type { Fact } from "../src/domain/fact.js";
import type { Assessment } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";

/**
 * レビュー役を起動する経路（.goals/start-the-review-we-wired.yaml の 1・3・4）。
 *
 * `actionSchema` の ACT は `role` を optional で持っているので、Zod は最初から
 * 通る。足りないのは DECIDE のプロンプトで、選べる行動の説明に role が1文字も
 * 出てこない。**書いていないものは選ばれない。**
 *
 * guard は増やさない。レビューをいつ起動するかを guard の決定論に置くと、
 * 「レビューを通れ」という条件を完了判定の手前に足したのと同じことになる
 * （.goals/collaborate-in-separate-worktrees.yaml の 10）。criteria に
 * `review.verdict` を書いた Goal では Fact ができるまで Gap が残るので、
 * 行動はどのみち LLM に渡る。起動されない経路は criteria の側で塞ぐ。
 *
 * 同じ commit を2度レビューさせないのは予算のため。Actor を起動してから
 * 「読む対象が前回と同じだった」と気づく形だと、1回分の予算を使ってから止まる。
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

const BUDGET: Budget = {
  max_actor_runs: 12,
  max_reconciles: 28,
  max_wall_clock: "5h",
  max_consecutive_failures: 3,
  max_unchanged_reconciles: 4,
};

const FRESH: BudgetUsage = {
  actorRuns: 1,
  reconciles: 2,
  consecutiveFailures: 0,
  elapsedSeconds: 600,
  trailingDigest: { digest: null, count: 0 },
};

const CRITERIA: AcceptanceCriterion[] = [
  {
    id: "ac-1",
    description: "テストが通る",
    verification: { type: "command", run: "mise run test" },
  },
  {
    id: "ac-6",
    description: "レビュー役が approved を返している",
    verification: { type: "fact", key: "review.verdict", equals: "approved" },
  },
];

const ASSESSMENT: Assessment = {
  assessedAt: NOW.toISOString(),
  gaps: [
    { criterionId: "ac-6", kind: "unknown", detail: "criteria.ac-6.passed の結論が出ていない" },
  ],
  satisfied: false,
};

function fact(key: string, value: unknown): Fact {
  return {
    key,
    value,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "test", detail: "" },
  };
}

/** 実装が進んだ状態。直近のレビューは1つ前の commit を読んでいる */
const MOVED_ON: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "changes_requested"),
  fact("review.reviewed_sha", OLDER),
];

/** 実装が1行も進んでいない状態。レビュー済みの commit がそのまま HEAD */
const UNCHANGED: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "changes_requested"),
  fact("review.reviewed_sha", HEAD),
];

/** レビューがまだ1度も走っていない状態 */
const NEVER_REVIEWED: Fact[] = [fact("local.head_sha", HEAD)];

function target(facts: readonly Fact[]): DecideTarget {
  return {
    criteria: CRITERIA,
    facts,
    assessment: ASSESSMENT,
    unresolved: [],
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: FRESH,
  };
}

function llmReturning(...actions: unknown[]): LlmPort & { prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    chooseAction: async (prompt: string) => {
      prompts.push(prompt);
      const action = actions[Math.min(call, actions.length - 1)];
      call += 1;
      return action;
    },
  };
}

function deps(llm: LlmPort): DecideDeps {
  return { llm, now: () => NOW };
}

const REVIEW_ACT = { type: "ACT", role: "review", intent: "実装を読んでレビューする" };

describe("レビュー役を起動する", () => {
  it("プロンプトに、レビュー役として ACT を起動できることが書いてある", async () => {
    const llm = llmReturning({ type: "VERIFY" });
    await decide(target(MOVED_ON), deps(llm));

    expect(llm.prompts[0]).toContain('"role":"review"');
  });

  it("レビューを1度も回していないときも、レビュー役を起動できる", async () => {
    const llm = llmReturning({ type: "VERIFY" });
    await decide(target(NEVER_REVIEWED), deps(llm));

    expect(llm.prompts[0]).toContain('"role":"review"');
  });

  it("LLM が選んだレビュー役の ACT を、そのまま採用する", async () => {
    const decision = await decide(target(MOVED_ON), deps(llmReturning(REVIEW_ACT)));

    expect(decision.action).toMatchObject({ type: "ACT", role: "review" });
    expect(decision.decidedBy).toBe("llm");
  });

  it("role を書かない ACT はこれまでどおり通る", async () => {
    const decision = await decide(
      target(MOVED_ON),
      deps(llmReturning({ type: "ACT", intent: "指摘を直す" })),
    );

    expect(decision.action).toMatchObject({ type: "ACT" });
    expect(decision.decidedBy).toBe("llm");
  });
});

describe("同じ commit を2度レビューしない", () => {
  it("レビュー済みの commit が HEAD のままなら、選択肢からレビュー役を外す", async () => {
    const llm = llmReturning({ type: "VERIFY" });
    await decide(target(UNCHANGED), deps(llm));

    expect(llm.prompts[0]).not.toContain('"role":"review"');
  });

  it("外した理由をプロンプトに書く。黙って消すと、なぜ選べないかが読めない", async () => {
    const llm = llmReturning({ type: "VERIFY" });
    await decide(target(UNCHANGED), deps(llm));

    expect(llm.prompts[0]).toContain(HEAD);
  });

  it("それでもレビュー役を返してきたら採用せず、理由を付けて再試行する", async () => {
    const llm = llmReturning(REVIEW_ACT, { type: "ACT", intent: "指摘を直す" });
    const decision = await decide(target(UNCHANGED), deps(llm));

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("採用されなかった理由");
    expect(decision.action).toMatchObject({ type: "ACT" });
    expect(decision.action).not.toHaveProperty("role", "review");
  });

  it("再試行を使い切っても同じなら、読める理由で止める", async () => {
    const decision = await decide(target(UNCHANGED), deps(llmReturning(REVIEW_ACT)));

    // invalid_decision に畳まない。出力の形が壊れているのではなく、実装が
    // 進まないままレビューだけを回そうとしている状態で、止めた理由を読む
    // 人間には別のものとして届く必要がある。
    expect(decision.action).toEqual({ type: "ESCALATE", reason: "review_not_converging" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("出力の形が壊れているだけなら、これまでどおり invalid_decision で止まる", async () => {
    const decision = await decide(target(UNCHANGED), deps(llmReturning({ type: "NOPE" })));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
  });
});

describe("完了判定の境界は動かさない", () => {
  it("レビューが通っていなくても、guard は COMPLETE を止めない", async () => {
    // Gap が無いティックは guard が COMPLETE を選ぶ。レビューの結論を見に行く
    // 判定を guard に足すと、criteria に review.verdict を書いていない Goal まで
    // レビュー待ちになる。
    const decision = await decide(
      {
        ...target(NEVER_REVIEWED),
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true },
      },
      deps(llmReturning({ type: "VERIFY" })),
    );

    expect(decision.action).toEqual({ type: "COMPLETE" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("LLM は COMPLETE も ESCALATE も選べないままにする", async () => {
    const decision = await decide(target(MOVED_ON), deps(llmReturning({ type: "COMPLETE" })));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    expect(decision.decidedBy).toBe("guard");
  });
});
