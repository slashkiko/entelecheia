import { describe, expect, it } from "vitest";
import { githubCodeProvider } from "../src/adapters/github.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * テストから実際の GitHub を叩かない。fetch を注入して octokit の下を差し替える。
 * ネットワークに出るテストは CI で不安定になり、検証の意味が消える。
 */

interface Route {
  /** URL に含まれていればこのルートを使う */
  match: string;
  status?: number;
  body?: unknown;
  /** ETag。conditional request の検証に使う */
  etag?: string;
}

interface FakeFetch {
  fetch: typeof fetch;
  /** 実際に飛んだリクエスト。ETag の検証に使う */
  calls: { url: string; ifNoneMatch: string | null }[];
}

function fakeFetch(routes: Route[]): FakeFetch {
  const calls: { url: string; ifNoneMatch: string | null }[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const ifNoneMatch = headers.get("if-none-match");
    calls.push({ url, ifNoneMatch });

    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // ETag が一致したら 304。GitHub はこのときレート制限を消費しない。
    if (route.etag !== undefined && ifNoneMatch === route.etag) {
      return new Response(null, { status: 304, headers: { etag: route.etag } });
    }

    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (route.etag !== undefined) {
      responseHeaders.etag = route.etag;
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: responseHeaders,
    });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

function provider(routes: Route[]) {
  const fake = fakeFetch(routes);
  return {
    code: githubCodeProvider({
      owner: "slashkiko",
      repo: "entelecheia",
      token: "ghp_test",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

const OPEN_PR = {
  match: "/pulls/12",
  body: {
    number: 12,
    state: "open",
    merged: false,
    mergeable: true,
    head: { sha: "a".repeat(40) },
    requested_reviewers: [{ login: "alice" }],
  },
};

const NO_REVIEWS = { match: "/pulls/12/reviews", body: [] };

describe("githubCodeProvider", () => {
  describe("getPullRequest", () => {
    it("PR を snapshot に変換する", async () => {
      const { code } = provider([NO_REVIEWS, OPEN_PR]);
      const pr = await code.getPullRequest(12);

      expect(pr).toMatchObject({
        number: 12,
        state: "open",
        mergeable: true,
        headSha: "a".repeat(40),
        requestedReviewers: ["alice"],
      });
    });

    it("存在しない PR は null。throw しない", async () => {
      // 「対象が無い」と「確かめられなかった」を混ぜると、observe が
      // unobserved に積めなくなる（design.md §3.1）。
      const { code } = provider([]);
      expect(await code.getPullRequest(999)).toBeNull();
    });

    it("マージ済みの PR は merged になる", async () => {
      const merged = {
        match: "/pulls/12",
        body: { ...OPEN_PR.body, state: "closed", merged: true },
      };
      const { code } = provider([NO_REVIEWS, merged]);

      expect((await code.getPullRequest(12))?.state).toBe("merged");
    });

    it("承認済みなら review_decision は APPROVED", async () => {
      const reviews = {
        match: "/pulls/12/reviews",
        body: [
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-08-09T00:00:00Z" },
        ],
      };
      const { code } = provider([reviews, OPEN_PR]);

      expect((await code.getPullRequest(12))?.reviewDecision).toBe("APPROVED");
    });

    it("変更要求は承認より優先する", async () => {
      // 1人でも変更を求めていればマージできない。
      const reviews = {
        match: "/pulls/12/reviews",
        body: [
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-08-09T00:00:00Z" },
          {
            user: { login: "bob" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-08-09T01:00:00Z",
          },
        ],
      };
      const { code } = provider([reviews, OPEN_PR]);

      expect((await code.getPullRequest(12))?.reviewDecision).toBe("CHANGES_REQUESTED");
    });

    it("レビュー待ちなら REVIEW_REQUIRED", async () => {
      const { code } = provider([NO_REVIEWS, OPEN_PR]);
      expect((await code.getPullRequest(12))?.reviewDecision).toBe("REVIEW_REQUIRED");
    });

    it("レビューを求めていなければ null", async () => {
      const noReviewers = {
        match: "/pulls/12",
        body: { ...OPEN_PR.body, requested_reviewers: [] },
      };
      const { code } = provider([NO_REVIEWS, noReviewers]);

      expect((await code.getPullRequest(12))?.reviewDecision).toBeNull();
    });

    it("2回目は If-None-Match を送る", async () => {
      // ETag を使えばポーリングでレート制限をほぼ消費しない（design.md §3.4）。
      const { code, calls } = provider([
        { ...NO_REVIEWS, etag: 'W/"rev"' },
        { ...OPEN_PR, etag: 'W/"pr"' },
      ]);

      await code.getPullRequest(12);
      await code.getPullRequest(12);

      const conditional = calls.filter((c) => c.ifNoneMatch !== null);
      expect(conditional.length).toBeGreaterThan(0);
    });

    it("304 が返っても前回の値を返す", async () => {
      const { code } = provider([
        { ...NO_REVIEWS, etag: 'W/"rev"' },
        { ...OPEN_PR, etag: 'W/"pr"' },
      ]);

      const first = await code.getPullRequest(12);
      const second = await code.getPullRequest(12);

      expect(second).toEqual(first);
    });

    it("認証に失敗したら PortError(unavailable) を投げる", async () => {
      // 待っても直るとは限らないので、null に畳まず throw する。
      const { code } = provider([{ match: "/pulls/12", status: 401, body: { message: "Bad" } }]);

      await expect(code.getPullRequest(12)).rejects.toBeInstanceOf(PortError);
    });
  });

  describe("getLatestCiRun", () => {
    const sha = "a".repeat(40);

    it("最新の run を snapshot に変換する", async () => {
      const runs = {
        match: "/actions/runs",
        body: {
          workflow_runs: [{ id: 7, head_sha: sha, status: "completed", conclusion: "success" }],
        },
      };
      const { code } = provider([runs]);

      expect(await code.getLatestCiRun(sha)).toMatchObject({
        headSha: sha,
        status: "completed",
        conclusion: "success",
        failedJobs: [],
      });
    });

    it("run が無ければ null", async () => {
      const { code } = provider([{ match: "/actions/runs", body: { workflow_runs: [] } }]);
      expect(await code.getLatestCiRun(sha)).toBeNull();
    });

    it("失敗したら失敗ジョブ名とログ URL まで取る", async () => {
      // 「CI が落ちた」だけでは次の ACT に渡す材料がない（design.md §4.3）。
      const runs = {
        match: "/actions/runs?",
        body: {
          workflow_runs: [{ id: 7, head_sha: sha, status: "completed", conclusion: "failure" }],
        },
      };
      const jobs = {
        match: "/actions/runs/7/jobs",
        body: {
          jobs: [
            { name: "check", conclusion: "failure", html_url: "https://github.com/j/1" },
            { name: "lint", conclusion: "success", html_url: "https://github.com/j/2" },
          ],
        },
      };
      const { code } = provider([jobs, runs]);

      expect((await code.getLatestCiRun(sha))?.failedJobs).toEqual([
        { name: "check", logUrl: "https://github.com/j/1" },
      ]);
    });

    it("実行中の run は conclusion が null", async () => {
      const runs = {
        match: "/actions/runs",
        body: {
          workflow_runs: [{ id: 7, head_sha: sha, status: "in_progress", conclusion: null }],
        },
      };
      const { code } = provider([runs]);

      expect((await code.getLatestCiRun(sha))?.conclusion).toBeNull();
    });
  });

  describe("getIssue", () => {
    it("Issue を snapshot に変換する", async () => {
      const issue = {
        match: "/issues/3",
        body: { number: 3, state: "open", labels: [{ name: "bug" }, { name: "p1" }] },
      };
      const { code } = provider([issue]);

      expect(await code.getIssue(3)).toEqual({
        number: 3,
        state: "open",
        labels: ["bug", "p1"],
        linkedPr: null,
      });
    });

    it("存在しない Issue は null", async () => {
      const { code } = provider([]);
      expect(await code.getIssue(999)).toBeNull();
    });

    it("PR にリンクしていれば番号を取る", async () => {
      const issue = {
        match: "/issues/3",
        body: {
          number: 3,
          state: "closed",
          labels: [],
          pull_request: { html_url: "https://github.com/slashkiko/entelecheia/pull/12" },
        },
      };
      const { code } = provider([issue]);

      expect((await code.getIssue(3))?.linkedPr).toBe(12);
    });
  });
});
