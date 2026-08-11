import { describe, expect, it } from "vitest";
import type { LlmPort } from "../src/decide/index.js";
import type { Fact, VerifiedFact } from "../src/domain/fact.js";
import type { Goal } from "../src/domain/goal.js";
import { type ReconcileDeps, type ReconcileTarget, reconcile } from "../src/reconcile/index.js";

/**
 * 陳腐化した Fact を引き継がない。
 *
 * reconcile は前ティックの Fact を土台にして今ティックの観測で上書きするが、
 * 上書きは「同じキーが来たとき」しか起きない。CI が実行中のあいだ observe は
 * `github.ci.conclusion` の Fact を作らない（conclusion が null なので未観測扱い）ので、
 * 前のコミットで観測した `conclusion=success` が head_sha の変わったあとも生き残る。
 *
 * ティックの順序は reconcile → act なので、Actor が push した次のティックでは
 * 「head_sha は新しいのに conclusion は古い success」という状態が必ず一度できる。
 * このとき `type: fact, key: github.ci.conclusion, equals: success` の criterion は
 * 古い evidence で passed になり、新しいコミットの CI を待たずに COMPLETE が出る。
 *
 * 「捏造した観測を作らない」（design.md §3.1）を守るなら、古い観測を今の観測として
 * 使うこの経路も塞ぐ必要がある。CI の Fact は head sha に紐づくので、
 * head_sha が違う値で観測されたら、引き継いだ `github.ci.*` は落とす。
 *
 * 落とす条件を「head_sha を違う値で観測できた」に限るのは、確かめられなかったことを
 * 「変わった」と読まないため。PR の Port が落ちたティックで CI の結論まで捨てると、
 * 観測の失敗が既に確かめた事実を消すことになる。
 */

const NOW = new Date("2026-08-09T03:00:00.000Z");
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

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
      id: "ac-1",
      description: "変更を載せた PR の CI が成功している",
      verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
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

/** 前ティックで観測した Fact。evidence が古い sha を指していることに意味がある */
function carried(): Fact[] {
  const at = "2026-08-09T02:00:00.000Z";
  const fact = (key: string, value: unknown, source: string, detail: string): VerifiedFact => ({
    key,
    value,
    observedAt: at,
    confidence: "VERIFIED",
    evidence: { source, detail },
  });

  return [
    fact(
      "github.pr.head_sha",
      OLD_SHA,
      `CodeProviderPort.getPullRequest(7)`,
      `head_sha=${OLD_SHA}`,
    ),
    fact(
      "github.ci.status",
      "completed",
      `CodeProviderPort.getLatestCiRun(${OLD_SHA})`,
      "status=completed",
    ),
    fact(
      "github.ci.conclusion",
      "success",
      `CodeProviderPort.getLatestCiRun(${OLD_SHA})`,
      "conclusion=success",
    ),
  ];
}

function pullRequest(headSha: string) {
  return {
    number: 7,
    state: "open" as const,
    mergeable: true,
    headSha,
    reviewDecision: null,
    requestedReviewers: [],
  };
}

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const llm: LlmPort = { chooseAction: async () => ({ type: "VERIFY" }) };
  return {
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => pullRequest(NEW_SHA),
      // 新しい sha の CI はまだ走っている。conclusion が null なので Fact にならない。
      getLatestCiRun: async () => ({
        headSha: NEW_SHA,
        status: "in_progress" as const,
        conclusion: null,
        failedJobs: [],
      }),
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "entelecheia/x", headSha: NEW_SHA, dirty: false }),
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

describe("陳腐化した Fact の失効", () => {
  it("head_sha が変わったら、引き継いだ github.ci.* を落とす", async () => {
    const result = await reconcile(target(), deps());

    expect(result.facts.find((f) => f.key === "github.ci.conclusion")).toBeUndefined();
  });

  it("落とすのは github.ci.* だけで、他の Fact は引き継ぐ", async () => {
    const result = await reconcile(target(), deps());

    // 今ティックで観測し直したものは新しい値になる
    expect(result.facts.find((f) => f.key === "github.pr.head_sha")?.value).toBe(NEW_SHA);
    // 今ティックの CI 観測が作った Fact は残る。落とすのは引き継いだ分だけ
    expect(result.facts.find((f) => f.key === "github.ci.status")?.value).toBe("in_progress");
  });

  it("古い CI の結論で criterion を passed にしない", async () => {
    const result = await reconcile(target(), deps());

    expect(result.assessment.satisfied).toBe(false);
    expect(result.decision.action.type).not.toBe("COMPLETE");
    expect(result.unresolved.some((u) => u.key === "criteria.ac-1.passed")).toBe(true);
  });

  it("head_sha が同じなら引き継いだ CI の結論を落とさない", async () => {
    // CI の観測そのものが落ちても、既に確かめた結論は残る。
    const result = await reconcile(
      target({ carriedFacts: carried() }),
      deps({
        code: {
          getPullRequest: async () => pullRequest(OLD_SHA),
          getLatestCiRun: async () => {
            throw new Error("502 Bad Gateway");
          },
          getIssue: async () => null,
        },
      }),
    );

    expect(result.facts.find((f) => f.key === "github.ci.conclusion")?.value).toBe("success");
  });

  it("head_sha を確かめられなかったティックでは落とさない", async () => {
    // 「確かめられなかった」を「変わった」と読むと、観測の失敗が確定した事実を消す。
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

    expect(result.facts.find((f) => f.key === "github.ci.conclusion")?.value).toBe("success");
  });
});
