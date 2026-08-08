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
});
