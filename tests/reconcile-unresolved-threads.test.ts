import { describe, expect, it } from "vitest";
import type { LlmPort } from "../src/decide/index.js";
import type { Fact, VerifiedFact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import { type ReconcileDeps, type ReconcileTarget, reconcile } from "../src/reconcile/index.js";

/**
 * 引き継いだ `github.pr.unresolved_threads` を、読めなかったティックで失効させる。
 *
 * `github.pr.unresolved_threads` は「数え切れなければ Fact を作らない」で書いてある。
 * 1ティックだけを見れば、Fact が無ければ criterion は埋まらないので収束の側には倒れない。
 * **2ティック目以降はそうならない。** reconcile は前ティックの Fact を土台にして
 * 今ティックの観測で上書きするので、上書きの来ないキーは前の値が VERIFIED のまま残る。
 *
 *   ティック N   GraphQL が成功して unresolved_threads=0 を観測する
 *   ティック N+1 bot が新しいスレッドを立て、同じティックで GraphQL が落ちる
 *   → 前ティックの 0 が生き残り、`equals: 0` の criterion が passed になる
 *
 * これは `github.ci.*` の引き継ぎとは性質が違う。CI の conclusion は head sha に
 * 紐づくので、同じ sha なら不変で、引き継いでも「今の値」であり続ける。スレッドの
 * 件数は sha に紐づかない。**bot は新しいコミットが無くてもスレッドを立てられる**ので、
 * 1時間前の件数を今の件数として使うのは §3.1 が禁じている「捏造した観測」にあたる。
 * しかも件数の読み取りは unobserved を積まないので、WAIT でも止まらない。
 *
 * そこで失効の条件を1本足す。**「PR そのものは今ティックで読めたのに、件数だけ
 * 読めなかった」ときだけ**、引き継いだ件数を落とす。PR ごと読めなかったティックでは
 * 落とさない（`github.ci.*` と同じく、確かめられなかったことを「変わった」と読まない）。
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
/** head_sha は据え置く。bot は新しいコミットが無くてもスレッドを立てられる */
const SHA = "c".repeat(40);

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプル",
    desired_state: "レビューの指摘が残っていない",
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
      id: "ac-1",
      description: "未解決のレビュースレッドが残っていない",
      verification: { type: "fact", key: "github.pr.unresolved_threads", equals: 0 },
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

/** ティック N の観測。GraphQL が成功して 0 件と数えられた状態 */
function carried(): Fact[] {
  const at = "2026-08-12T02:00:00.000Z";
  const source = "CodeProviderPort.getPullRequest(7)";
  const fact = (key: string, value: unknown, detail: string): VerifiedFact => ({
    key,
    value,
    observedAt: at,
    confidence: "VERIFIED",
    evidence: { source, detail },
  });

  return [
    fact("github.pr.number", 7, "number=7"),
    fact("github.pr.head_sha", SHA, `head_sha=${SHA}`),
    fact("github.pr.unresolved_threads", 0, "unresolved_threads=0"),
  ];
}

function pullRequest(unresolvedThreads: number | null) {
  return {
    number: 7,
    state: "open" as const,
    mergeable: true,
    headSha: SHA,
    reviewDecision: null,
    requestedReviewers: [],
    title: "サンプル PR",
    body: "本文",
    unresolvedThreads,
  };
}

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const llm: LlmPort = { chooseAction: async () => ({ type: "VERIFY" }) };
  return {
    review: { latest: async () => null },
    code: {
      // ティック N+1。GraphQL が落ちたので件数は null になり、observe は
      // Fact も unobserved も作らない。他の github.pr.* は埋まったまま返る。
      getPullRequest: async () => pullRequest(null),
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "entelecheia/x", headSha: SHA, dirty: false }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    llm,
    now: () => NOW,
    ...over,
  };
}

function target(over: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    goal: GOAL,
    observe: { prNumber: 7, issueNumber: null },
    carriedFacts: carried(),
    usage: {
      actorRuns: 0,
      reconciles: 1,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: null, count: 0 },
    },
    ...over,
  };
}

describe("引き継いだ未解決スレッド件数の失効", () => {
  it("PR は読めたのに件数だけ読めなかったら、引き継いだ件数を落とす", async () => {
    const result = await reconcile(target(), deps());

    expect(result.facts.find((f) => f.key === "github.pr.unresolved_threads")).toBeUndefined();
  });

  it("前ティックの 0 で criterion を passed にしない", async () => {
    const result = await reconcile(target(), deps());

    expect(result.assessment.satisfied).toBe(false);
    expect(result.decision.action.type).not.toBe("COMPLETE");
    expect(result.unresolved.some((u) => u.key === "criteria.ac-1.passed")).toBe(true);
  });

  it("落とすのは件数だけで、同じティックで観測し直した Fact は残る", async () => {
    const result = await reconcile(target(), deps());

    expect(result.facts.find((f) => f.key === "github.pr.number")?.value).toBe(7);
    expect(result.facts.find((f) => f.key === "github.pr.state")?.value).toBe("open");
  });

  it("件数を観測できたティックでは、今ティックの値がそのまま残る", async () => {
    const result = await reconcile(
      target(),
      deps({
        code: {
          getPullRequest: async () => pullRequest(2),
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
      }),
    );

    expect(result.facts.find((f) => f.key === "github.pr.unresolved_threads")?.value).toBe(2);
  });

  it("PR そのものを読めなかったティックでは落とさない", async () => {
    // 確かめられなかったことを「変わった」と読むと、観測の失敗が確定した事実を消す。
    // ここは WAIT(observation_failed) で待つ側にいるので、件数は残してよい。
    const result = await reconcile(
      target(),
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
      }),
    );

    expect(result.facts.find((f) => f.key === "github.pr.unresolved_threads")?.value).toBe(0);
  });
});
