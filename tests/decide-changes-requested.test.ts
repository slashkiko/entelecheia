import { describe, expect, it } from "vitest";
import {
  type BudgetUsage,
  type DecideDeps,
  type DecideTarget,
  decide,
  type LlmPort,
} from "../src/decide/index.js";
import { type Action, actionSchema } from "../src/domain/action.js";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { Assessment } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";
import { nextStatus } from "../src/domain/goal-state.js";

/**
 * `changes_requested` を受け取ったティックで、DECIDE が WAIT に居着かない（issue #61）。
 *
 * レビュー役が `changes_requested` を返しても、DECIDE は実装役に戻らず
 * `WAIT(review_pending)` を選び続けていた。1つの Goal を収束させる間、19 ティック中
 * 6ティックがそれで、うち数ティックは command 系の criteria が全部通っており
 * 「レビュー指摘を直す」以外にやることが無い局面だった。動いたのは、人間が
 * criterion を1本足したときだけになる。**実質のハンドルが「criteria を足すこと」に
 * なっていて、宣言を書き換えずに収束させるという使い方ができない。**
 *
 * ここが決めるのは2つ。
 *
 * 1. レビュー役が `changes_requested` を返し、その commit がまだ HEAD のままなら、
 *    LLM に見せる選択肢から WAIT を外す。`reviewActionLines` が既に使っている
 *    「起動できないティックには形を見せない」と同じ手になる。**外す条件は
 *    プロンプトだけに置かない。** 受け取り側にも同じ条件を置き、外したはずの
 *    WAIT を返してきた出力は採用しない
 * 2. 人間を待つ WAIT を `human_review_pending` と名指しする。`review_pending` は
 *    「人間の承認待ち」と「controller 自身のレビュー役の結論」の両方に読めた。
 *    controller のレビュー役に待つ状態は無い（レビュー役は ACT で同期に走る）ので、
 *    後者に与える語は無く、1 のとおり WAIT そのものを外す形で表す
 *
 * guard は増やさない。決めるのは LLM に渡す行動の範囲だけで、完了判定の境界には
 * 触れない（`decide()` の 1〜4 は変わらず5つのまま）。
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
const HEAD = "c".repeat(40);
const OLDER = "d".repeat(40);

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
  // detail に verdict の値を書かない。この文字列がプロンプトに現れるのは、
  // 「WAIT を外した理由」を書いたときだけにしておく。
  gaps: [{ criterionId: "ac-6", kind: "unmet", detail: "ac-6 がまだ満たされていない" }],
  satisfied: false,
};

function fact(key: string, value: unknown, confidence: Fact["confidence"] = "VERIFIED"): Fact {
  const observedAt = NOW.toISOString();
  if (confidence === "INFERRED") {
    return { key, value, observedAt, confidence: "INFERRED" };
  }
  return {
    key,
    value,
    observedAt,
    confidence: "VERIFIED",
    evidence: { source: "test", detail: "" },
  };
}

/** レビュー役が変更を求め、その commit がまだ HEAD のまま。ここで WAIT を外す */
const CHANGES_REQUESTED: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "changes_requested"),
  fact("review.reviewed_sha", HEAD),
];

/** 変更を求められた後に実装が進んだ。読み直せば結論が変わりうるので WAIT は残す */
const MOVED_ON: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "changes_requested"),
  fact("review.reviewed_sha", OLDER),
];

/** 現在の HEAD が承認されている。指摘は残っていないので WAIT は残す */
const APPROVED: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "approved"),
  fact("review.reviewed_sha", HEAD),
];

/** 結論を確かめられていない。推論で選択肢を消さない（design.md §3.1） */
const NOT_VERIFIED: Fact[] = [
  fact("local.head_sha", HEAD),
  fact("review.verdict", "changes_requested", "INFERRED"),
  fact("review.reviewed_sha", HEAD),
];

/** レビューが1度も走っていない */
const NEVER_REVIEWED: Fact[] = [fact("local.head_sha", HEAD)];

function target(facts: readonly Fact[], patch: Partial<DecideTarget> = {}): DecideTarget {
  return {
    criteria: CRITERIA,
    facts,
    // 今ティックで観測できたことにする。この仕様が見ているのは「WAIT を外す条件」の
    // 中身で、繰り越しと今ティックの観測を取り違える側は
    // tests/reconcile-observed-head.test.ts が reconcile を通して固定している。
    observedFacts: facts,
    assessment: ASSESSMENT,
    unresolved: [],
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: FRESH,
    ...patch,
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

async function promptFor(facts: readonly Fact[]): Promise<string> {
  const llm = llmReturning({ type: "VERIFY" });
  await decide(target(facts), deps(llm));
  return llm.prompts[0] ?? "";
}

/** WAIT を選ばせる一文。外したティックにはこれも出さない */
const WAIT_INVITATION = "If you judge that a human must be waited for";

const WAIT_ACTION = { type: "WAIT", reason: "human_review_pending" };
const REVIEW_ACT = { type: "ACT", role: "review", intent: "実装を読んでレビューする" };
const IMPLEMENT_ACT = { type: "ACT", intent: "レビュー指摘を直す" };

describe("changes_requested のティックから WAIT を外す", () => {
  it("レビュー済みの commit が HEAD のままなら、WAIT の書式をプロンプトに出さない", async () => {
    const prompt = await promptFor(CHANGES_REQUESTED);

    expect(prompt).not.toContain('"type":"WAIT"');
  });

  it("WAIT を選ばせる一文も消す。形を消して誘い文句だけ残すと、そちらが読まれる", async () => {
    // `reviewActionLines` と同じ手を採る。「形だけ見せて選ぶなと添える」より
    // 「選べる形を1つ減らす」方が確実になる。誘い文句は形の一種なので一緒に消す。
    const prompt = await promptFor(CHANGES_REQUESTED);

    expect(prompt).not.toContain(WAIT_INVITATION);
  });

  it("外した理由を書く。黙って消すと、なぜ選べないかが読めない", async () => {
    const prompt = await promptFor(CHANGES_REQUESTED);

    expect(prompt).toContain(HEAD);
    expect(prompt).toContain("changes_requested");
  });

  it("レビューの後に実装が進んでいれば WAIT は残る", async () => {
    const prompt = await promptFor(MOVED_ON);

    expect(prompt).toContain('"type":"WAIT"');
    expect(prompt).toContain(WAIT_INVITATION);
  });

  it("現在の HEAD が approved なら WAIT は残る", async () => {
    const prompt = await promptFor(APPROVED);

    expect(prompt).toContain('"type":"WAIT"');
  });

  it("verdict が VERIFIED でなければ WAIT は残る。推論で選択肢を消さない", async () => {
    const prompt = await promptFor(NOT_VERIFIED);

    expect(prompt).toContain('"type":"WAIT"');
  });

  it("レビューが1度も走っていなければ WAIT は残る", async () => {
    const prompt = await promptFor(NEVER_REVIEWED);

    expect(prompt).toContain('"type":"WAIT"');
  });
});

describe("外した WAIT は受け取り側でも採用しない", () => {
  it("それでも WAIT を返してきたら採用せず、理由を付けて再試行する", async () => {
    const llm = llmReturning(WAIT_ACTION, IMPLEMENT_ACT);
    const decision = await decide(target(CHANGES_REQUESTED), deps(llm));

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("was not adopted");
    expect(decision.action).toMatchObject({ type: "ACT", intent: IMPLEMENT_ACT.intent });
    expect(decision.decidedBy).toBe("llm");
  });

  it("reason を変えても採用しない。外しているのは WAIT という行動そのもの", async () => {
    const llm = llmReturning({ type: "WAIT", reason: "ci_running" }, IMPLEMENT_ACT);
    const decision = await decide(target(CHANGES_REQUESTED), deps(llm));

    expect(decision.action).toMatchObject({ type: "ACT" });
  });

  it("再試行を使い切っても WAIT なら invalid_decision で止まる", async () => {
    // 新しい ESCALATE の理由は足さない。ここで起きているのは
    // 「選択肢に無い行動を返してきた」で、COMPLETE や ESCALATE を返してきたのと同じになる。
    const decision = await decide(target(CHANGES_REQUESTED), deps(llmReturning(WAIT_ACTION)));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("WAIT の拒否は review_not_converging に数えない", async () => {
    // `review_not_converging` は「実装が進まないままレビューだけを回そうとしている」
    // 状態を指す。WAIT の拒否を混ぜると、1度もレビュー役を返していない出力まで
    // その名前で止まり、止めた理由を読む人間が別のものを見ることになる。
    const llm = llmReturning(WAIT_ACTION, REVIEW_ACT, WAIT_ACTION);
    const decision = await decide(target(CHANGES_REQUESTED), deps(llm));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
  });

  it("レビュー役だけを返し続けたときは、これまでどおり review_not_converging", async () => {
    const decision = await decide(target(CHANGES_REQUESTED), deps(llmReturning(REVIEW_ACT)));

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "review_not_converging" });
  });

  it("実装に戻る ACT はそのまま採用する", async () => {
    const decision = await decide(target(CHANGES_REQUESTED), deps(llmReturning(IMPLEMENT_ACT)));

    expect(decision.action).toMatchObject({ type: "ACT" });
    expect(decision.decidedBy).toBe("llm");
  });

  it("VERIFY と REPLAN は残る。WAIT だけを外す", async () => {
    for (const action of [{ type: "VERIFY" }, { type: "REPLAN" }]) {
      const decision = await decide(target(CHANGES_REQUESTED), deps(llmReturning(action)));
      expect(decision.action).toEqual(action);
    }
  });

  it("WAIT を外していないティックでは、これまでどおり WAIT を採用する", async () => {
    const decision = await decide(target(MOVED_ON), deps(llmReturning(WAIT_ACTION)));

    expect(decision.action).toEqual({ ...WAIT_ACTION, resumeAfter: null });
    expect(decision.decidedBy).toBe("llm");
  });
});

describe("人間を待つ WAIT を名指しする", () => {
  const humanCriterion: AcceptanceCriterion = {
    id: "ac-7",
    description: "人間が確認する",
    verification: { type: "human", prompt: "確認してください" },
  };

  it("Gap は無いが人間の承認待ちが残っていれば WAIT(human_review_pending)", async () => {
    const unresolved: Unresolved[] = [
      { key: criterionFactKey("ac-7"), reason: "pending", detail: "承認待ち" },
    ];
    const decision = await decide(
      target(NEVER_REVIEWED, {
        criteria: [humanCriterion],
        unresolved,
        assessment: { assessedAt: NOW.toISOString(), gaps: [], satisfied: true },
      }),
      deps(llmReturning({ type: "VERIFY" })),
    );

    expect(decision.action).toMatchObject({ type: "WAIT", reason: "human_review_pending" });
    expect(decision.decidedBy).toBe("guard");
  });

  it("プロンプトの WAIT の選択肢に human_review_pending が載っている", async () => {
    const prompt = await promptFor(NEVER_REVIEWED);

    expect(prompt).toContain("human_review_pending");
    expect(prompt).toContain(`${WAIT_INVITATION}, choose WAIT(human_review_pending).`);
  });

  it("LLM が human_review_pending を返したら採用する", async () => {
    const decision = await decide(target(NEVER_REVIEWED), deps(llmReturning(WAIT_ACTION)));

    expect(decision.action).toEqual({ ...WAIT_ACTION, resumeAfter: null });
  });

  it("WAIT(human_review_pending) は WAITING_HUMAN になる", () => {
    const action: Action = { type: "WAIT", reason: "human_review_pending", resumeAfter: null };

    expect(nextStatus("ACTIVE", action)).toBe("WAITING_HUMAN");
  });

  it("過去に書いた review_pending の Decision も、読み直せて WAITING_HUMAN のまま", () => {
    // decisions テーブルは読むたびに actionSchema.parse を通る（`listDecisions`）。
    // 語を入れ替えるのではなく足すのは、既に走っている Goal の行がそこで落ちるため。
    const parsed = actionSchema.parse({ type: "WAIT", reason: "review_pending" });

    expect(parsed).toEqual({ type: "WAIT", reason: "review_pending", resumeAfter: null });
    expect(nextStatus("ACTIVE", parsed)).toBe("WAITING_HUMAN");
  });

  it("人間以外を待つ WAIT は、これまでどおり WAITING_EXTERNAL", () => {
    for (const reason of ["ci_running", "usage_limit", "observation_failed"] as const) {
      const action: Action = { type: "WAIT", reason, resumeAfter: null };
      expect(nextStatus("ACTIVE", action), reason).toBe("WAITING_EXTERNAL");
    }
  });
});
