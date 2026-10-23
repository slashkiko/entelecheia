import { describe, expect, it } from "vitest";
import type { LlmPort } from "../src/decide/index.js";
import type { Fact, VerifiedFact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import { type ReconcileDeps, type ReconcileTarget, reconcile } from "../src/reconcile/index.js";

/**
 * 観測できなかったティックで WAIT を消さない。
 *
 * WAIT を外す条件は「レビュー役が `changes_requested` を返し、その commit が
 * **まだ HEAD のまま**」になる。前半は時間が経っても腐らない——commit X を読んだ
 * レビューが変更を求めた、という事実は後からひっくり返らない——が、後半は腐る。
 * HEAD は Actor が push するたびに動く。
 *
 * **VERIFIED であることと、「このティックで確かめられた」ことは別になる。**
 * `reconcile` は前ティックの Fact を土台にして今ティックの観測で上書きするので、
 * `LocalRepoPort.snapshot()` が落ちたティックには前ティックの `local.head_sha` が
 * VERIFIED のまま残る（`expireStaleFacts` が繰り越しから落とすのは `github.ci.*`
 * だけになる）。繰り越した値を「いま HEAD はこれだ」と読むと、確かめられなかった
 * ことが「そうなっている」に化ける（design.md §3.1）。
 *
 * しかもこの穴は構造的になる。1ティックは OBSERVE → ACT の順なので、実装役が
 * 走ったティックの `review.reviewed_sha` と `local.head_sha` は同じ sha を指す。
 * 次のティックで local の観測さえ落ちれば、繰り越した head は必ず reviewed_sha と
 * 一致する。そのティックで選びたい行動は `WAIT(observation_failed)` なのに、
 * WAIT が選択肢から消えていれば、待つ手段が両側とも塞がる。
 *
 * 直す先は `decide()` に渡す材料になる。`ReconcileResult.observedFacts`——引き継ぎを
 * 含まない、このティックの OBSERVE だけが作った Fact——を `DecideTarget` に足し、
 * `local.head_sha` はそちらから読む。**`decide()` を直接叩くテストではこの穴を
 * 踏めない。** 手で組んだ `DecideTarget` は `reconcile` が何を渡すかを何も言わない
 * ので、ここは `reconcile` を通して確かめる。
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
const HEAD = "e".repeat(40);

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプル",
    desired_state: "何かが完成している",
    depends_on: [],
  },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [
    {
      id: "ac-6",
      description: "レビュー役が approved を返している",
      verification: { type: "fact", key: "review.verdict", equals: "approved" },
    },
  ],
  context: { background: "背景", constraints: [], references: [] },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

/** レビュー役の最終メッセージ。observe がここから Fact を作る */
function reviewMessage(sha: string, verdict: string): string {
  return [`reviewed_sha: ${sha}`, "", "1. 指摘がある", "", `verdict: ${verdict}`].join("\n");
}

/**
 * 前ティックまでに得た Fact。
 *
 * 実装役が走ったティックの観測なので、`local.head_sha` はレビュー役が読んだ
 * commit と同じ sha を指す。ここが繰り越されると、次のティックで local を
 * 観測できなくても「レビュー済みの commit が HEAD のまま」が成立してしまう。
 */
function carried(): Fact[] {
  const at = "2026-08-12T02:00:00.000Z";
  const fact = (key: string, value: unknown, source: string, detail: string): VerifiedFact => ({
    key,
    value,
    observedAt: at,
    confidence: "VERIFIED",
    evidence: { source, detail },
  });

  return [
    fact("local.branch", "entelecheia/x", "LocalRepoPort.snapshot()", "branch=entelecheia/x"),
    fact("local.head_sha", HEAD, "LocalRepoPort.snapshot()", `head_sha=${HEAD}`),
    fact("local.dirty", false, "LocalRepoPort.snapshot()", "dirty=false"),
  ];
}

/** LLM が返す行動を固定し、渡されたプロンプトを覚えておく */
function llmReturning(action: unknown): LlmPort & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    chooseAction: async (prompt: string) => {
      prompts.push(prompt);
      return action;
    },
  };
}

function deps(llm: LlmPort, over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    // レビュー役は既に走っており、今ティックも同じ Run を読み直せる。
    // 落ちるのは local の観測だけにして、原因を1つに絞る。
    review: {
      latest: async () => ({
        runId: "run-9",
        finalMessage: reviewMessage(HEAD, "changes_requested"),
      }),
    },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "entelecheia/x", headSha: HEAD, dirty: false }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    llm,
    now: () => NOW,
    ...over,
  };
}

/** `LocalRepoPort.snapshot()` が落ちたティック。head は繰り越しにしか無い */
const LOCAL_DOWN: Partial<ReconcileDeps> = {
  local: {
    snapshot: async () => {
      throw new Error("git: 128 fatal: not a git repository");
    },
  },
};

function target(over: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    goal: GOAL,
    observe: { prNumber: null, issueNumber: null },
    carriedFacts: carried(),
    usage: {
      actorRuns: 1,
      reconciles: 2,
      consecutiveFailures: 0,
      elapsedSeconds: 600,
      trailingDigest: { digest: null, count: 0 },
    },
    ...over,
  };
}

const WAIT_ACTION = { type: "WAIT", reason: "observation_failed" };

describe("観測できなかったティックの WAIT", () => {
  it("local を観測できなければ WAIT は選択肢に残る", async () => {
    const llm = llmReturning(WAIT_ACTION);
    const result = await reconcile(target(), deps(llm, LOCAL_DOWN));

    expect(result.decision.action).toMatchObject({ type: "WAIT" });
    expect(result.decision.decidedBy).toBe("llm");
  });

  it("プロンプトからも WAIT の書式を消さない", async () => {
    const llm = llmReturning(WAIT_ACTION);
    await reconcile(target(), deps(llm, LOCAL_DOWN));

    expect(llm.prompts[0]).toContain('"type":"WAIT"');
  });

  it("local を観測できなければレビュー役の ACT も選択肢に残る", async () => {
    // `reviewedHeadOf` も同じ材料を読む。片方だけ今ティックの観測に寄せると、
    // `local.head_sha` の出どころが関数ごとに違う状態になる。
    const llm = llmReturning({ type: "ACT", role: "review", intent: "読み直す" });
    const result = await reconcile(target(), deps(llm, LOCAL_DOWN));

    expect(result.decision.action).toMatchObject({ type: "ACT", role: "review" });
  });

  it("今ティックで HEAD を観測できていれば、これまでどおり WAIT を外す", async () => {
    // 直したのは「確かめられなかったティック」だけで、確かめられたティックの
    // 判定は動かさない。issue #61 の本体はこちらになる。
    const llm = llmReturning(WAIT_ACTION);
    const result = await reconcile(target(), deps(llm));

    expect(llm.prompts[0]).not.toContain('"type":"WAIT"');
    expect(result.decision.action).toEqual({ type: "ESCALATE", reason: "invalid_decision" });
  });

  it("繰り越した head を今の HEAD として渡さない", async () => {
    // 上の3本は decide の出力から間接に見ている。渡している材料そのものも
    // 確かめておく。`observedFacts` は今ティックの OBSERVE だけが作った Fact で、
    // local が落ちたティックには `local.*` が1つも無い。
    const result = await reconcile(target(), deps(llmReturning(WAIT_ACTION), LOCAL_DOWN));

    expect(result.observedFacts.some((f) => f.key === "local.head_sha")).toBe(false);
    // 引き継ぎ込みの側には残る。落としているのではなく、読む先を分けている。
    expect(result.facts.find((f) => f.key === "local.head_sha")?.value).toBe(HEAD);
  });
});
