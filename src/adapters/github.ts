import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { errorMessage } from "../domain/error-message.js";
import { PortError } from "../domain/port-error.js";
import type {
  CiRunSnapshot,
  CodeProviderPort,
  IssueSnapshot,
  PullRequestSnapshot,
} from "../observe/index.js";
import { type CodeWriterPort, PROGRESS_MARKER } from "../publish/index.js";
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

/**
 * API の応答をスキーマに通す。落ちたら PortError(shape_mismatch) にする。
 *
 * 以前はどの `.parse()` も `get` / `request` の try/catch の外にあり、ZodError が
 * 素の例外として controller に抜けていた。`github.ts` 自身が「失敗は必ず
 * PortError にして、素の例外を controller に流さない」と書いているのに、
 * 応答の形だけがその約束の外にあった。
 *
 * 抜けた ZodError は observe の汎用ラッパが拾い、`port_failed` に畳んでいた。
 * つまり「GitHub がフィールドを変えた」という永久に直らない状態が、一時的な
 * 障害として毎ティック再試行され、`max_unchanged_reconciles` に当たるまで
 * 止まらなかった。人間には「GitHub が不安定」に見える。
 */
function decode<S extends z.ZodType>(schema: S, raw: unknown, source: string): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PortError(
      "shape_mismatch",
      `${source}: 応答の形が想定と違う: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function githubCodeProvider(options: GitHubOptions): CodeProviderPort {
  const octokit = client(options, { retry: true });

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
      throw new PortError(
        "unavailable",
        `${describe(route, params, options)}: ${errorMessage(error)}`,
      );
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
      const pr = decode(pullRequestSchema, raw, "GET /pulls/{pull_number}");

      const rawReviews = await get("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        pull_number: prNumber,
        per_page: 100,
      });
      const reviews =
        rawReviews === null ? [] : decode(reviewsSchema, rawReviews, "GET /pulls/{n}/reviews");
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
      const run = decode(runsSchema, raw, "GET /actions/runs").workflow_runs[0];
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
      const issue = decode(issueSchema, raw, "GET /issues/{issue_number}");

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
      const found = decode(openPullsSchema, response, "GET /pulls")[0];
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
      return decode(createdPullSchema, response, "POST /pulls").number;
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
 * 人間の承認を検知する。design.md §10-4 の未決を埋める。
 *
 * signal は2つある。どちらか一方でも成立すれば承認とみなす。
 *
 * 1. **GitHub のレビュー承認** — 他人が Approve を押した場合。仕事で使うときの
 *    本来の経路にあたる。§4.3 が言うとおり、これ *だけ* には頼れない。GitHub は
 *    自分が作った PR に Approve を押させないので、1人で開発しているあいだは
 *    永久に成立しない。逆に言えば、成立しないだけで誤りではない
 * 2. **PR コメントの定型文** `/ent approve <criterion-id>` — レビュアーが
 *    いない状況でも承認できる経路。criterion 単位で書ける
 *
 * 粒度が違うことに注意する。レビュー承認は PR 全体に対するもので、
 * criterion を選べない。したがって `type: human` の criteria すべてを満たす。
 * 個別に承認したいなら定型文を使う。
 *
 * 変更要求（CHANGES_REQUESTED）が最新のレビューとして残っているあいだは、
 * どちらの経路でも承認しない。変更を求められている PR を承認済みと読むのは
 * 矛盾している。§4.3 の `reviewDecisionOf` と同じく、変更要求を承認より優先する。
 *
 * PR がまだ無ければ常に未承認を返す。承認の置き場所が無い状態を
 * 「承認された」と読まないため。
 */
export function githubApproval(options: GitHubOptions & { prNumber: number | null }): ApprovalPort {
  const octokit = client(options);
  const prNumber = options.prNumber;
  const hasWriteAccess = writeAccessChecker(octokit, options);

  // 1ティックで criteria の数だけ呼ばれる。同じ PR を何度も引かない。
  let cached: Promise<{ reviews: Review[]; comments: Comment[]; author: string | null }> | null =
    null;

  const load = async (): Promise<{
    reviews: Review[];
    comments: Comment[];
    author: string | null;
  }> => {
    const [pr, reviews, comments] = await Promise.all([
      request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}", options, {
        pull_number: prNumber,
      }),
      request(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", options, {
        pull_number: prNumber,
        per_page: 100,
      }),
      request(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", options, {
        issue_number: prNumber,
        per_page: 100,
      }),
    ]);

    return {
      author: decode(prAuthorSchema, pr, "GET /pulls/{pull_number}").user?.login ?? null,
      reviews: decode(reviewsSchema, reviews, "GET /pulls/{n}/reviews"),
      comments: decode(commentsSchema, comments, "GET /issues/{n}/comments"),
    };
  };

  return {
    async getApproval(criterionId) {
      if (prNumber === null) {
        return null;
      }
      cached ??= load();
      const { reviews, comments, author } = await cached;

      const latest = latestReviewByUser(reviews);

      // 変更を求められている PR を承認済みと読まない。
      // 権限の無い相手からの変更要求も止める側に数える。承認を厳しくするのと、
      // 拒否を厳しくするのは別の話で、後者は倒す向きが逆になる。
      if ([...latest.values()].some((r) => r.state === "CHANGES_REQUESTED")) {
        return null;
      }

      // 1. レビュー承認。PR 全体に対するものなので human の criteria すべてを満たす。
      //    作成者自身のレビューは数えない。GitHub も普通は許さないが、
      //    別アカウントで作った PR を自分で承認する形を型の外で塞いでおく。
      for (const review of latest.values()) {
        const login = review.user?.login ?? "";
        if (review.state !== "APPROVED" || login === author || !permitted(review)) {
          continue;
        }
        // 関係だけでは足りない。実際に書き込めるかを権限 API で確かめる。
        if (!(await hasWriteAccess(login))) {
          continue;
        }
        return { approvedBy: login, approvedAt: review.submitted_at ?? "" };
      }

      // 2. コメントの定型文。最初の1件を採る。2回承認しても最初の判断が残る。
      //    controller 自身が書いた進捗コメントは数えない。rationale には LLM が
      //    決めた intent が載るので、そこに定型文を書かせれば自己承認になる。
      for (const comment of comments) {
        if (comment.body.includes(PROGRESS_MARKER)) {
          continue;
        }
        if (!permitted(comment) || !approves(comment.body, criterionId)) {
          continue;
        }
        const login = comment.user?.login ?? "";
        if (!(await hasWriteAccess(login))) {
          continue;
        }
        return { approvedBy: login, approvedAt: comment.created_at };
      }
      return null;
    },
  };
}

/**
 * 承認として数えてよい投稿者の関係。
 *
 * `author_association` は GitHub が返す「その PR のリポジトリに対する関係」で、
 * クライアントが名乗るものではない。ここを見ないと、公開リポジトリでは
 * **通りすがりの誰でも** `/ent approve <criterion-id>` の1行で `type: human` の
 * criterion を VERIFIED にできた。§9 の完了判定は人間の承認を根拠にしているので、
 * ここが開いていると完了判定そのものが成立しない。
 *
 * `CONTRIBUTOR`（過去にマージされた PR がある）は含めない。書き込み権限とは別物で、
 * 一度貢献しただけの相手に完了判定を渡す理由が無い。
 */
const APPROVER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * 前段のふるい。関係が読めなければ承認しない側に倒す。
 *
 * これだけでは足りない。README は「`type: human` の承認は、リポジトリに
 * 書き込み権限がある人のものだけを数える」と書いているが、`MEMBER` は
 * 所有 org のメンバー全員を指し、リポジトリ単位の権限を一切含意しない。
 * `COLLABORATOR` も read / triage で招かれた相手を含む。つまりこの集合は
 * 「書き込み権限がある」より広く、org に人がいるほど広がる。
 *
 * そこで2段構えにする。ここは API を1回も叩かずに落とせる相手を落とす前段で、
 * 実際の判定は `writeAccessChecker` が権限 API で行う。
 */
function permitted(actor: { author_association?: string | null | undefined }): boolean {
  return actor.author_association != null && APPROVER_ASSOCIATIONS.has(actor.author_association);
}

/**
 * 書き込み権限として数える値。GitHub の permission API が返す語をそのまま使う。
 *
 * `pull`（read）と `triage` は入れない。どちらもコードを変えられないので、
 * 「実装が完了した」という判断の根拠にならない。
 */
const WRITE_PERMISSIONS = new Set(["push", "maintain", "admin", "write"]);

const permissionSchema = z.object({ permission: z.string().nullish() });

/**
 * その login が実際にリポジトリへ書き込めるかを、権限 API で確かめる。
 *
 * 3つの結果を混ぜない（design.md §3.1）。
 *
 * - 権限がある            → true
 * - コラボレーターでない  → false。404 がこれにあたる。承認していないのと同じ扱い
 * - 確かめられなかった    → throw。トークンの権限不足やネットワーク断がこれ
 *
 * 3つ目を false に畳んではいけない。`verify` は承認が null なら `pending`、
 * Port が throw すれば `port_failed` を返し、両者を別の unresolved として残す。
 * 畳むと、権限 API が落ちているだけの状態が「まだ誰も承認していない」に見え、
 * Goal は理由の分からないまま WAITING_HUMAN で止まり続ける。
 *
 * 一方で「確かめられなかった」を true にするのも駄目で、GitHub が落ちている
 * あいだだけ誰でも承認できる窓が開く。倒す先は throw であって true / false ではない。
 */
function writeAccessChecker(
  octokit: Octokit,
  options: GitHubOptions,
): (login: string) => Promise<boolean> {
  // 1ティックで criteria の数だけ呼ばれる。同じ人を何度も引かない。
  const cache = new Map<string, Promise<boolean>>();
  const route = "GET /repos/{owner}/{repo}/collaborators/{username}/permission";

  return (login) => {
    if (login === "") {
      return Promise.resolve(false);
    }
    const cached = cache.get(login);
    if (cached !== undefined) {
      return cached;
    }

    const pending = (async () => {
      let raw: unknown;
      try {
        // request() を通さずに叩く。あちらは何でも PortError に畳むので、
        // 404（コラボレーターでない）と本当の障害を区別できない。
        const response = await octokit.request(route, {
          owner: options.owner,
          repo: options.repo,
          username: login,
        });
        raw = response.data;
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          // コラボレーターではない。確かめられた結果としての「権限なし」。
          return false;
        }
        throw new PortError(
          "unavailable",
          `${describe(route, { username: login }, options)}: ${errorMessage(error)}`,
        );
      }

      const permission = decode(permissionSchema, raw, route).permission;
      return permission != null && WRITE_PERMISSIONS.has(permission);
    })();

    cache.set(login, pending);
    return pending;
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
/**
 * octokit を組み立てる。read と write で違うのは retry プラグインの有無だけ。
 *
 * 書き込み側に retry を入れないのは意図的で、500 で再試行すると1回目が実際には
 * 成功していた場合に PR が2本立つ。どちらが正かを決められなくなるより、失敗して
 * 次のティックに任せる方がよい（design.md §3.6）。
 *
 * throttle の2つのコールバックは両方で同じにする。レート制限に当たっても待たない。
 * ここで待つと reconcile が有限時間で return しなくなる。以前は同じ設定が2箇所に
 * あり、片方だけ直せばもう片方が黙って待つ形だった。
 */
function client(options: GitHubOptions, plugins: { retry: boolean } = { retry: false }): Octokit {
  const Client = plugins.retry ? Octokit.plugin(retry, throttling) : Octokit.plugin(throttling);
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
    throw new PortError(
      "unavailable",
      `${describe(route, params, options)}: ${errorMessage(error)}`,
    );
  }
}

/**
 * 人ごとに最後の1件のレビューだけを残す。COMMENTED は数えない。
 *
 * 承認の成立条件（自己承認の除外、変更要求の優先）は安全性の根幹なので、
 * その土台になるこの集約は1箇所に置く。observe が読む `review_decision` と
 * verify が読む承認が別々にこれを書いていたころは、片方だけ直すと
 * 2つが別の結論を出せた。
 */
function latestReviewByUser(reviews: readonly Review[]): Map<string, Review> {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") {
      continue;
    }
    latest.set(review.user?.login ?? "", review);
  }
  return latest;
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
  const states = [...latestReviewByUser(reviews).values()].map((review) => review.state);

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
    /** 承認した時刻。Approval.approvedAt に入る */
    submitted_at: z.string().nullish(),
    /** リポジトリに対する関係。承認を数えてよい相手かの判定に使う */
    author_association: z.string().nullish(),
  }),
);
type Review = z.infer<typeof reviewsSchema>[number];

const prAuthorSchema = z.object({ user: z.object({ login: z.string() }).nullish() });

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
    /** リポジトリに対する関係。承認を数えてよい相手かの判定に使う */
    author_association: z.string().nullish(),
  }),
);
type Comment = z.infer<typeof commentsSchema>[number];

const issueSchema = z.object({
  number: z.number(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.object({ html_url: z.string() }).optional(),
});
