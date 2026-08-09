import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { PortError } from "../domain/port-error.js";
import type {
  CiRunSnapshot,
  CodeProviderPort,
  IssueSnapshot,
  PullRequestSnapshot,
} from "../observe/index.js";
import type { CodeWriterPort } from "../publish/index.js";
import type { ApprovalPort } from "../verify/index.js";

/**
 * GitHub 向けの CodeProviderPort。octokit を使う。
 *
 * design.md §3.4 のとおり webhook は使わず、ETag による conditional request で
 * ポーリングする。304 が返ればレート制限をほぼ消費しない。
 */

export interface GitHubOptions {
  owner: string;
  repo: string;
  token: string;
  /**
   * テストから注入する fetch。実運用では省略して octokit の既定に任せる。
   * ここを口にしておくことで、テストが実際の GitHub を叩かずに済む。
   */
  fetch?: typeof fetch;
}

export function githubCodeProvider(options: GitHubOptions): CodeProviderPort {
  const Client = Octokit.plugin(retry, throttling);
  const octokit = new Client({
    auth: options.token,
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    throttle: {
      // レート制限に当たったら再試行せず、次のティックに任せる。
      // ここで待つと reconcile が有限時間で return しなくなる（design.md §3.6）。
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });

  /** ETag と前回の値。同じキーで2回目を引くときに If-None-Match を送る */
  const cache = new Map<string, { etag: string; value: unknown }>();

  /**
   * GET する。対象が無ければ null、取得に失敗したら throw。
   * この2つを混ぜると observe が unobserved に積めない（design.md §3.1）。
   */
  const get = async (route: string, params: Record<string, unknown>): Promise<unknown> => {
    const key = `${route} ${JSON.stringify(params)}`;
    const cached = cache.get(key);

    try {
      const response = await octokit.request(route, {
        owner: options.owner,
        repo: options.repo,
        ...params,
        headers: cached === undefined ? {} : { "if-none-match": cached.etag },
      });
      const etag = response.headers.etag;
      if (typeof etag === "string") {
        cache.set(key, { etag, value: response.data });
      }
      return response.data;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 304 は「前回から変わっていない」。レート制限を消費していない。
      if (status === 304 && cached !== undefined) {
        return cached.value;
      }
      if (status === 404) {
        return null;
      }
      throw new PortError("unavailable", `${describe(route, params, options)}: ${message(error)}`);
    }
  };

  return {
    async getPullRequest(prNumber) {
      const raw = await get("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        pull_number: prNumber,
      });
      if (raw === null) {
        return null;
      }
      const pr = pullRequestSchema.parse(raw);

      const rawReviews = await get("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        pull_number: prNumber,
        per_page: 100,
      });
      const reviews = rawReviews === null ? [] : reviewsSchema.parse(rawReviews);
      const requestedReviewers = (pr.requested_reviewers ?? []).map((r) => r.login);

      return {
        number: pr.number,
        state: pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open",
        mergeable: pr.mergeable ?? null,
        headSha: pr.head.sha,
        reviewDecision: reviewDecisionOf(reviews, requestedReviewers),
        requestedReviewers,
      } satisfies PullRequestSnapshot;
    },

    async getLatestCiRun(headSha) {
      const raw = await get("GET /repos/{owner}/{repo}/actions/runs", {
        head_sha: headSha,
        per_page: 1,
      });
      if (raw === null) {
        return null;
      }
      const run = runsSchema.parse(raw).workflow_runs[0];
      if (run === undefined) {
        return null;
      }

      // 失敗ジョブ名とログ URL まで取る。「CI が落ちた」だけでは
      // 次の ACT に渡す材料がない（design.md §4.3）。
      const failedJobs =
        run.conclusion === "failure" ? await failedJobsOf(get, run.id) : ([] as const);

      return {
        headSha: run.head_sha,
        status: statusOf(run.status),
        conclusion: conclusionOf(run.conclusion),
        failedJobs: [...failedJobs],
      } satisfies CiRunSnapshot;
    },

    async getIssue(issueNumber) {
      const raw = await get("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: issueNumber,
      });
      if (raw === null) {
        return null;
      }
      const issue = issueSchema.parse(raw);

      return {
        number: issue.number,
        state: issue.state === "closed" ? "closed" : "open",
        labels: issue.labels.map((label) => label.name),
        linkedPr: linkedPrOf(issue.pull_request?.html_url),
      } satisfies IssueSnapshot;
    },
  };
}

/**
 * 書き込み側。design.md §4.1 のとおり read と別のインターフェースにする。
 *
 * ETag のキャッシュは持たない。POST は conditional request が効かないうえ、
 * 「前回と同じだから作らない」判断は findPullRequest が担うため。
 */
export function githubCodeWriter(options: GitHubOptions): CodeWriterPort {
  const octokit = client(options);

  return {
    async findPullRequest(head) {
      // 作る前に必ず探す。2本目を立てるとどちらが正かを決められなくなる。
      const response = await request(octokit, "GET /repos/{owner}/{repo}/pulls", options, {
        // owner:branch の形にしないと、fork からの PR を取りこぼす。
        head: `${options.owner}:${head}`,
        state: "open",
        per_page: 1,
      });
      const found = openPullsSchema.parse(response)[0];
      return found?.number ?? null;
    },

    async createPullRequest(draft) {
      const response = await request(octokit, "POST /repos/{owner}/{repo}/pulls", options, {
        head: draft.head,
        base: draft.base,
        title: draft.title,
        body: draft.body,
      });
      // 捏造した番号を返さない。形が違えばここで throw する。
      return createdPullSchema.parse(response).number;
    },

    async addComment(prNumber, body) {
      await request(octokit, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments", options, {
        issue_number: prNumber,
        body,
      });
    },
  };
}

/**
 * PR コメントの定型文を人間の承認として読む。design.md §10-4 の未決を埋める。
 *
 * §4.3 のとおり `github.pr.review_decision` は使えない。GitHub は自分が作った
 * PR に Approve を押させないので、controller が Goal の所有者と同じアカウントで
 * PR を作る限り `APPROVED` にならない。
 *
 * 代わりに `/ent approve <criterion-id>` というコメントを signal にする。
 * ポーリングでそのまま拾え（§3.4）、承認が GitHub 上に監査記録として残る。
 *
 * PR がまだ無ければ常に未承認を返す。承認コメントの置き場所が無い状態を
 * 「承認された」と読まないため。
 */
export function githubApproval(options: GitHubOptions & { prNumber: number | null }): ApprovalPort {
  const octokit = client(options);

  return {
    async getApproval(criterionId) {
      if (options.prNumber === null) {
        return null;
      }

      const response = await request(
        octokit,
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        options,
        { issue_number: options.prNumber, per_page: 100 },
      );
      const comments = commentsSchema.parse(response);

      // 最初の1件を採る。同じ criterion を2回承認しても、最初の判断が残る。
      for (const comment of comments) {
        if (!approves(comment.body, criterionId)) {
          continue;
        }
        return {
          approvedBy: comment.user?.login ?? "unknown",
          approvedAt: comment.created_at,
        };
      }
      return null;
    },
  };
}

/**
 * `/ent approve <criterion-id>` を含むか。
 *
 * 行全体で照合する。引用した本文やコード例の中の同じ文字列を承認と読むと、
 * 捏造した承認が作れてしまう。行頭の空白だけは許す。
 */
function approves(body: string, criterionId: string): boolean {
  return body.split("\n").some((line) => line.trim() === `/ent approve ${criterionId}`);
}

/**
 * 書き込み側の octokit。read 側と違って retry プラグインを入れない。
 *
 * 500 で再試行すると、1回目が実際には成功していた場合に PR が2本立つ。
 * どちらが正かを決められなくなるより、失敗して次のティックに任せる方がよい
 * （reconcile はどのティックも有限時間で return する。design.md §3.6）。
 */
function client(options: GitHubOptions): Octokit {
  const Client = Octokit.plugin(throttling);
  return new Client({
    auth: options.token,
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    throttle: {
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });
}

/** 書き込み側の共通経路。失敗は必ず PortError にして、素の例外を controller に流さない */
async function request(
  octokit: Octokit,
  route: string,
  options: GitHubOptions,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    const response = await octokit.request(route, {
      owner: options.owner,
      repo: options.repo,
      ...params,
    });
    return response.data;
  } catch (error) {
    throw new PortError("unavailable", `${describe(route, params, options)}: ${message(error)}`);
  }
}

/**
 * review_decision を REST から導出する。
 *
 * GraphQL なら1回で取れるが、ETag による conditional request（design.md §3.4）が
 * 効くのは REST の GET だけなので、レビュー一覧から組み立てる。
 * 1人でも変更を求めていればマージできないので、承認より優先する。
 */
function reviewDecisionOf(
  reviews: readonly Review[],
  requestedReviewers: readonly string[],
): PullRequestSnapshot["reviewDecision"] {
  // 同じ人が何度もレビューするので、人ごとに最後の1件だけを見る。
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") {
      continue;
    }
    latest.set(review.user?.login ?? "", review.state);
  }
  const states = [...latest.values()];

  if (states.includes("CHANGES_REQUESTED")) {
    return "CHANGES_REQUESTED";
  }
  if (states.includes("APPROVED")) {
    return "APPROVED";
  }
  // レビューを求めていなければ null。「未要求」という観測できた状態にあたる。
  return requestedReviewers.length > 0 ? "REVIEW_REQUIRED" : null;
}

async function failedJobsOf(
  get: (route: string, params: Record<string, unknown>) => Promise<unknown>,
  runId: number,
): Promise<{ name: string; logUrl: string }[]> {
  const raw = await get("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
    run_id: runId,
    per_page: 100,
  });
  if (raw === null) {
    return [];
  }
  return jobsSchema
    .parse(raw)
    .jobs.filter((job) => job.conclusion === "failure")
    .map((job) => ({ name: job.name, logUrl: job.html_url }));
}

/**
 * Issue にリンクした PR の番号。
 *
 * REST から取れるのは「その Issue 自身が PR である」場合だけ。
 * 相互参照された PR は timeline API が要るので、まだ観測しない。
 * design.md §4.3 のとおり、取得できる対象をレジストリ側の正とする。
 */
function linkedPrOf(htmlUrl: string | undefined): number | null {
  if (htmlUrl === undefined) {
    return null;
  }
  const matched = /\/pull\/(\d+)$/.exec(htmlUrl);
  return matched === null ? null : Number(matched[1]);
}

function statusOf(status: string | null): CiRunSnapshot["status"] {
  return status === "queued" || status === "in_progress" ? status : "completed";
}

function conclusionOf(conclusion: string | null): CiRunSnapshot["conclusion"] {
  switch (conclusion) {
    case "success":
    case "failure":
    case "cancelled":
    case "timed_out":
      return conclusion;
    // 実行中の run は conclusion が null。まだ結論が出ていないだけ。
    default:
      return null;
  }
}

/** evidence に載る形。Port 呼び出し名ではなく実際に叩いた API を残す（design.md §3.1） */
function describe(route: string, params: Record<string, unknown>, options: GitHubOptions): string {
  let path = route.replace("{owner}", options.owner).replace("{repo}", options.repo);
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`{${key}}`, String(value));
  }
  return path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pullRequestSchema = z.object({
  number: z.number(),
  state: z.string(),
  merged: z.boolean().optional(),
  mergeable: z.boolean().nullish(),
  head: z.object({ sha: z.string() }),
  requested_reviewers: z.array(z.object({ login: z.string() })).nullish(),
});

const reviewsSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullish(),
    state: z.string(),
  }),
);
type Review = z.infer<typeof reviewsSchema>[number];

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      head_sha: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
    }),
  ),
});

const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    }),
  ),
});

const openPullsSchema = z.array(z.object({ number: z.number() }));

const createdPullSchema = z.object({ number: z.number() });

const commentsSchema = z.array(
  z.object({
    body: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    user: z.object({ login: z.string() }).nullish(),
    created_at: z.string(),
  }),
);

const issueSchema = z.object({
  number: z.number(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.object({ html_url: z.string() }).optional(),
});
