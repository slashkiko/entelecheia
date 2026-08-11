import { describe, expect, it } from "vitest";
import { type Fact, observeResultSchema, verifiedOnly } from "../src/domain/fact.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
} from "../src/observe/index.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");

function deps(over: {
  code?: Partial<CodeProviderPort>;
  local?: Partial<LocalRepoPort>;
}): ObserveDeps {
  return {
    // レビュー役はまだ走っていない。Fact も unobserved も作らない側の既定。
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
      ...over.code,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
      ...over.local,
    },
    now: () => NOW,
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

describe("observe", () => {
  it("ローカル repo の状態を VERIFIED な Fact として返す", async () => {
    const result = await observe(
      { prNumber: null, issueNumber: null },
      deps({
        local: {
          snapshot: async () => ({ branch: "feat/observe", headSha: "b".repeat(40), dirty: true }),
        },
      }),
    );

    expect(byKey(result.facts, "local.branch")?.value).toBe("feat/observe");
    expect(byKey(result.facts, "local.head_sha")?.value).toBe("b".repeat(40));
    expect(byKey(result.facts, "local.dirty")?.value).toBe(true);
    for (const f of result.facts) {
      expect(f.confidence).toBe("VERIFIED");
    }
  });

  it("PR の状態とレビュー判定を Fact にする", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => ({
            number: 12,
            state: "open",
            mergeable: true,
            headSha: "c".repeat(40),
            reviewDecision: "CHANGES_REQUESTED",
            requestedReviewers: ["pr-author"],
          }),
        },
      }),
    );

    expect(byKey(result.facts, "github.pr.state")?.value).toBe("open");
    expect(byKey(result.facts, "github.pr.mergeable")?.value).toBe(true);
    expect(byKey(result.facts, "github.pr.review_decision")?.value).toBe("CHANGES_REQUESTED");
  });

  it("CI 失敗時は失敗ジョブ名とログ URL まで Fact に含める", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => ({
            number: 12,
            state: "open",
            mergeable: null,
            headSha: "d".repeat(40),
            reviewDecision: null,
            requestedReviewers: [],
          }),
          getLatestCiRun: async () => ({
            headSha: "d".repeat(40),
            status: "completed",
            conclusion: "failure",
            failedJobs: [{ name: "typecheck", logUrl: "https://example.test/logs/1" }],
            failedJobCount: 1,
          }),
        },
      }),
    );

    expect(byKey(result.facts, "github.ci.conclusion")?.value).toBe("failure");

    const failed = byKey(result.facts, "github.ci.failed_jobs");
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed?.value)).toContain("typecheck");
    expect(JSON.stringify(failed?.value)).toContain("https://example.test/logs/1");
  });

  it("観測できなかった対象の Fact は作らない", async () => {
    const result = await observe({ prNumber: 99, issueNumber: null }, deps({}));

    expect(byKey(result.facts, "github.pr.state")).toBeUndefined();
    expect(byKey(result.facts, "github.ci.conclusion")).toBeUndefined();
    // ローカルは観測できているので残る
    expect(byKey(result.facts, "local.branch")).toBeDefined();
  });

  it("外部から取得した Fact はすべて evidence を持つ", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => ({
            number: 12,
            state: "open",
            mergeable: true,
            headSha: "e".repeat(40),
            reviewDecision: "APPROVED",
            requestedReviewers: [],
          }),
        },
      }),
    );

    for (const f of verifiedOnly(result.facts)) {
      expect(f.evidence.source.length).toBeGreaterThan(0);
    }
  });

  it("戻り値が ObserveResult スキーマを通る", async () => {
    const result = await observe({ prNumber: null, issueNumber: null }, deps({}));
    expect(() => observeResultSchema.parse(result)).not.toThrow();
    expect(result.observedAt).toBe(NOW.toISOString());
  });

  it("Issue を観測して Fact にする", async () => {
    // Phase 0 では issueNumber が全テストで null だったため、getIssue の経路は
    // 実装しても未実装でも AC が緑になっていた。
    const result = await observe(
      { prNumber: null, issueNumber: 7 },
      deps({
        code: {
          getIssue: async () => ({
            number: 7,
            state: "open",
            labels: ["enhancement", "phase-1"],
            linkedPr: 12,
          }),
        },
      }),
    );

    expect(byKey(result.facts, "github.issue.state")?.value).toBe("open");
    expect(byKey(result.facts, "github.issue.linked_pr")?.value).toBe(12);
    expect(JSON.stringify(byKey(result.facts, "github.issue.labels")?.value)).toContain(
      "enhancement",
    );
    expect(result.unobserved).toEqual([]);
  });

  it("CI 実行中は conclusion の Fact を作らない", async () => {
    // 運用では最頻出の状態だが、Phase 0 のテストは completed かつ failure しか見ていなかった。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => ({
            number: 12,
            state: "open",
            mergeable: null,
            headSha: "f".repeat(40),
            reviewDecision: null,
            requestedReviewers: [],
          }),
          getLatestCiRun: async () => ({
            headSha: "f".repeat(40),
            status: "in_progress",
            conclusion: null,
            failedJobs: [],
            // 回っている最中は数が確定しない。conclusion と同じく Fact にしない。
            failedJobCount: null,
          }),
        },
      }),
    );

    expect(byKey(result.facts, "github.ci.status")?.value).toBe("in_progress");
    expect(byKey(result.facts, "github.ci.conclusion")).toBeUndefined();
    // 「まだ結論が出ていない」は観測できた状態なので、未観測としては積まない
    expect(result.unobserved).toEqual([]);
  });

  it("Port が throw しても observe 全体は落ちず、他方の観測は残る", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
        },
      }),
    );

    expect(byKey(result.facts, "local.branch")).toBeDefined();
    expect(byKey(result.facts, "github.pr.state")).toBeUndefined();
  });

  it("取得に失敗した対象は unobserved に理由付きで残る", async () => {
    // 「PR が存在しない」と「PR を取得できなかった」を Fact の不在に畳むと、
    // GitHub の障害を「PR は無い」と読んだ ASSESS が誤った DECIDE をする。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getPullRequest: async () => {
            throw new Error("502 Bad Gateway");
          },
        },
      }),
    );

    const failed = result.unobserved.find((u) => u.key.startsWith("github.pr"));
    expect(failed).toBeDefined();
    expect(failed?.reason).toBe("port_failed");
    expect(failed?.detail).toContain("502");
  });

  it("対象が存在しないだけなら unobserved に積まない", async () => {
    // Port が null を返すのは「存在しないと観測できた」なので、取得失敗とは区別する。
    const result = await observe({ prNumber: 99, issueNumber: null }, deps({}));

    expect(byKey(result.facts, "github.pr.state")).toBeUndefined();
    expect(result.unobserved).toEqual([]);
  });

  it("ローカル repo の観測に失敗しても unobserved に残る", async () => {
    const result = await observe(
      { prNumber: null, issueNumber: null },
      deps({
        local: {
          snapshot: async () => {
            throw new Error("not a git repository");
          },
        },
      }),
    );

    expect(result.facts).toEqual([]);
    const failed = result.unobserved.find((u) => u.key.startsWith("local"));
    expect(failed?.reason).toBe("port_failed");
    expect(failed?.detail).toContain("not a git repository");
  });
});
