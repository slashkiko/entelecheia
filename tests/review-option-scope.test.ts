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
 * レビュー役の選択肢を、criteria がレビューを求めている Goal だけに閉じる。
 *
 * tests/review-decide.test.ts は「criteria に `review.verdict` を書いた Goal で
 * レビュー役を選べること」を固定している。その裏——**書いていない Goal では
 * 選択肢に出ないこと**——を固定するのがここになる。
 *
 * 予算1回分の話にとどまらない。レビュー役の Run が1つできると、その最終メッセージが
 * 読めなかったティックは `review.*` が `pending` として `unresolved` に積まれる。
 * Gap がゼロの Goal では guard の3番目が WAIT を返して LLM が呼ばれず、
 * 「もう一度レビューを回す」という選択そのものができない。`ReviewPort.latest()` は
 * 同じ Run を返し続けるので pending は自力で消えず、予算が尽きるまで WAIT が続く。
 * criteria に書いた Goal は verdict が欠ければ Gap が立って回復できるので、
 * 書いていない Goal だけが COMPLETE に届かなくなる、という逆転になる。
 *
 * **これは guard の判定ではない。** guard は5つのままで、レビューの結論を1つも
 * 見ない。ここが決めるのは LLM に見せる選択肢の範囲だけになる。
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const HEAD = "a".repeat(40);

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

const TESTS_PASS: AcceptanceCriterion = {
  id: "ac-1",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

const CI_GREEN: AcceptanceCriterion = {
  id: "ac-5",
  description: "PR の CI が成功している",
  verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
};

const REVIEW_APPROVED: AcceptanceCriterion = {
  id: "ac-6",
  description: "レビュー役が approved を返している",
  verification: { type: "fact", key: "review.verdict", equals: "approved" },
};

const REVIEWED_SHA: AcceptanceCriterion = {
  id: "ac-6b",
  description: "レビューした commit が記録されている",
  verification: { type: "fact", key: "review.reviewed_sha", equals: HEAD },
};

const HUMAN_READS: AcceptanceCriterion = {
  id: "ac-7",
  description: "人間が差分を読む",
  verification: { type: "human", prompt: "境界が動いていないか読んでください" },
};

const ASSESSMENT: Assessment = {
  assessedAt: NOW.toISOString(),
  gaps: [{ criterionId: "ac-1", kind: "unmet", detail: "テストが落ちている" }],
  satisfied: false,
};

const HEAD_ONLY: Fact[] = [
  {
    key: "local.head_sha",
    value: HEAD,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "test", detail: "" },
  },
];

function target(criteria: readonly AcceptanceCriterion[]): DecideTarget {
  return {
    criteria,
    facts: HEAD_ONLY,
    // 今ティックで観測できたことにする。観測できなかったティックの側は
    // tests/reconcile-observed-head.test.ts が reconcile を通して固定している。
    observedFacts: HEAD_ONLY,
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
      // 最後の要素で打ち止めにする。1つだけ渡せば「毎回同じ出力を返す LLM」になる。
      const action = actions[Math.min(call, actions.length - 1)];
      call += 1;
      return action;
    },
  };
}

function deps(llm: LlmPort): DecideDeps {
  return { llm, now: () => NOW };
}

async function promptFor(criteria: readonly AcceptanceCriterion[]): Promise<string> {
  const llm = llmReturning({ type: "VERIFY" });
  await decide(target(criteria), deps(llm));
  return llm.prompts[0] ?? "";
}

describe("レビュー役を出すかどうかは criteria が決める", () => {
  it("criteria が review.verdict を求めていれば、選択肢に出る", async () => {
    expect(await promptFor([TESTS_PASS, REVIEW_APPROVED])).toContain('"role":"review"');
  });

  it("review.reviewed_sha を求めているだけでも出る", async () => {
    // 対にして使うキーなので、片方だけを書いた Goal も「レビューを求めている」に
    // 含める。書いた側のキーが Fact にならないまま Gap が残るのは同じになる。
    expect(await promptFor([TESTS_PASS, REVIEWED_SHA])).toContain('"role":"review"');
  });

  it("criteria がレビューの結論を求めていなければ、選択肢に出ない", async () => {
    const prompt = await promptFor([TESTS_PASS, CI_GREEN, HUMAN_READS]);

    expect(prompt).not.toContain('"role":"review"');
    // 外した理由すら書かない。あちらにはレビュー役という選択肢が最初から無く、
    // 「今回は選べない」と書けば「いつかは選べる」と読める。
    expect(prompt).not.toContain("レビュー役");
  });

  it("レビューを求めていない Goal でも、他の選べる行動はこれまでどおり出る", async () => {
    const prompt = await promptFor([TESTS_PASS, CI_GREEN]);

    expect(prompt).toContain('{"type":"ACT","intent"');
    expect(prompt).toContain('{"type":"VERIFY"}');
    expect(prompt).toContain('{"type":"REPLAN"}');
  });

  it("`type: human` の criterion を review.verdict と読み違えない", async () => {
    // human の verification は key を持たない。形の違う criterion を
    // 素通りさせずに、fact のものだけを見ているかを固定する。
    expect(await promptFor([HUMAN_READS])).not.toContain('"role":"review"');
  });
});

describe("選択肢に出さないだけでなく、返ってきても採用しない", () => {
  /**
   * プロンプトから消すのは「選ばれにくくする」であって「選べなくする」ではない。
   *
   * 同じファイルの `LLM_MAY_CHOOSE` が、その油断で一度焼かれた記録を残している。
   * ESCALATE をプロンプトに書かないまま `llmActionSchema` が COMPLETE だけを
   * 弾いていたところ、実走の2回目で `ESCALATE(loop_detected)` が返り、
   * ループしていないのに採用された。上の describe が固定しているのは
   * プロンプト文字列だけなので、受け取り側をここで固定する。
   */
  const REVIEW_ACT = { type: "ACT", role: "review", intent: "実装を読んでレビューする" };

  it("レビューを求めていない Goal が返してきた review の ACT を採用しない", async () => {
    const llm = llmReturning(REVIEW_ACT, { type: "ACT", intent: "テストを直す" });
    const decision = await decide(target([TESTS_PASS, CI_GREEN]), deps(llm));

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("採用されなかった理由");
    expect(decision.action).toMatchObject({ type: "ACT", intent: "テストを直す" });
    expect(decision.action).not.toHaveProperty("role", "review");
  });

  it("採用しなかった理由に、criteria が求めていないことを書く", async () => {
    // 黙って捨てると、LLM は次のティックでも同じ出力を返す。
    const llm = llmReturning(REVIEW_ACT, { type: "VERIFY" });
    await decide(target([TESTS_PASS, CI_GREEN]), deps(llm));

    expect(llm.prompts[1]).toContain("review.verdict");
  });

  it("再試行を使い切っても同じなら invalid_decision で止まる", async () => {
    // `review_not_converging` に畳まない。あちらは「実装が進まないまま
    // レビューだけを回す」形の名前で、レビューの往復が1周も無いこの Goal では
    // 起きているのは「選択肢に無い行動を返してきた」——COMPLETE や ESCALATE を
    // 返してきたのと同じこと——になる。
    const decision = await decide(target([TESTS_PASS, CI_GREEN]), deps(llmReturning(REVIEW_ACT)));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("レビューを求めている Goal では、これまでどおり採用する", async () => {
    // 受け取り側に足した条件が、求めている Goal まで塞いでいないか。
    // ここが落ちると tests/review-decide.test.ts と食い違う。
    const decision = await decide(
      target([TESTS_PASS, REVIEW_APPROVED]),
      deps(llmReturning(REVIEW_ACT)),
    );

    expect(decision.action).toMatchObject({ type: "ACT", role: "review" });
    expect(decision.decidedBy).toBe("llm");
  });

  it("role を書かない ACT は、レビューを求めていない Goal でも通る", async () => {
    // 絞っているのはレビュー役だけで、実装役の ACT に触っていないこと。
    const decision = await decide(
      target([TESTS_PASS, CI_GREEN]),
      deps(llmReturning({ type: "ACT", intent: "テストを直す" })),
    );

    expect(decision.action).toMatchObject({ type: "ACT" });
    expect(decision.decidedBy).toBe("llm");
  });
});

describe("選択肢を絞っても、guard の境界は動かない", () => {
  it("レビューを求めていない Goal でも、Gap がゼロなら COMPLETE のまま", async () => {
    const decision = await decide(
      {
        ...target([TESTS_PASS, CI_GREEN]),
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true },
      },
      deps(llmReturning({ type: "VERIFY" })),
    );

    expect(decision.action).toEqual({ type: "COMPLETE" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("レビューを求めている Goal でも、Gap がゼロなら COMPLETE のまま", async () => {
    // 選択肢の範囲を criteria に紐づけたことで、完了判定の側に
    // 「レビューを通れ」が漏れていないかを見る。
    const decision = await decide(
      {
        ...target([TESTS_PASS, REVIEW_APPROVED]),
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true },
      },
      deps(llmReturning({ type: "VERIFY" })),
    );

    expect(decision.action).toEqual({ type: "COMPLETE" });
    expect(decision.decidedBy).toBe("guard");
  });
});
