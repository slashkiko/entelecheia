import type { Fact, ObserveResult, VerifiedFact } from "../domain/fact.js";

/**
 * Observe が依存する外部世界。実装ではなくインターフェースとして切っておく。
 * MVP の実装は GitHub のみだが、ここが 1 実装に癒着しないことを保つのが L2 の要件。
 */

export interface PullRequestSnapshot {
  number: number;
  state: "open" | "closed" | "merged";
  mergeable: boolean | null;
  headSha: string;
  /** GitHub の reviewDecision。レビュー未要求なら null */
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  requestedReviewers: string[];
}

export interface CiRunSnapshot {
  /** 対応する PR の head sha */
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
  /** conclusion が failure のときだけ埋まる */
  failedJobs: { name: string; logUrl: string }[];
}

export interface IssueSnapshot {
  number: number;
  state: "open" | "closed";
  labels: string[];
  linkedPr: number | null;
}

export interface CodeProviderPort {
  getPullRequest(prNumber: number): Promise<PullRequestSnapshot | null>;
  getLatestCiRun(headSha: string): Promise<CiRunSnapshot | null>;
  getIssue(issueNumber: number): Promise<IssueSnapshot | null>;
}

export interface LocalRepoSnapshot {
  branch: string;
  headSha: string;
  /** 未コミットの変更があるか */
  dirty: boolean;
}

export interface LocalRepoPort {
  snapshot(): Promise<LocalRepoSnapshot>;
}

export interface ObserveTarget {
  /** 観測対象の PR。未作成なら null */
  prNumber: number | null;
  /** 追跡している Issue。無ければ null */
  issueNumber: number | null;
}

export interface ObserveDeps {
  code: CodeProviderPort;
  local: LocalRepoPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

/**
 * Port から得た値を VERIFIED な Fact にする。
 *
 * observe() は Port の戻り値しか触らないので、ここを通った Fact はすべて一次情報になる。
 * 逆に言えば、この関数を経由しない Fact を observe() が作ってはいけない。
 */
function verified(
  key: string,
  value: unknown,
  observedAt: string,
  source: string,
  detail: string,
): VerifiedFact {
  return { key, value, observedAt, confidence: "VERIFIED", evidence: { source, detail } };
}

/**
 * 観測の失敗を「観測できなかった」に畳む。
 *
 * 「対象が存在しない（null）」と「取得に失敗した（throw）」を Fact の有無としては同じに扱う。
 * どちらも Fact を作らないのが正しく、捏造しないための最後の砦になる。
 * 片方の Port が落ちても他方の観測は残したいので、observe() 全体を失敗させない。
 */
async function observed<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * 現在状態を観測して Fact 列を返す。
 *
 * 満たすべき性質:
 * - GitHub API と git から得た値は必ず VERIFIED、evidence 付き
 * - 観測できなかった対象について Fact を捏造しない（黙って落とす）
 * - CI が失敗しているときは、失敗ジョブ名とログ URL まで Fact に含める
 *   （「CI が落ちた」だけでは次の ACT に渡す材料がないため）
 */
export async function observe(target: ObserveTarget, deps: ObserveDeps): Promise<ObserveResult> {
  // 1 回だけ読む。同じ観測に含まれる Fact の observedAt を揃えて、
  // あとから「どのティックで見た値か」を突き合わせられるようにする。
  const observedAt = deps.now().toISOString();
  const facts: Fact[] = [];

  const push = (key: string, value: unknown, source: string, detail: string): void => {
    facts.push(verified(key, value, observedAt, source, detail));
  };

  const local = await observed(() => deps.local.snapshot());
  if (local !== null) {
    const source = "LocalRepoPort.snapshot()";
    push("local.branch", local.branch, source, `branch=${local.branch}`);
    push("local.head_sha", local.headSha, source, `head_sha=${local.headSha}`);
    push("local.dirty", local.dirty, source, `dirty=${local.dirty}`);
  }

  const prNumber = target.prNumber;
  if (prNumber !== null) {
    const prSource = `CodeProviderPort.getPullRequest(${prNumber})`;
    const pr = await observed(() => deps.code.getPullRequest(prNumber));
    if (pr !== null) {
      push("github.pr.number", pr.number, prSource, `number=${pr.number}`);
      push("github.pr.state", pr.state, prSource, `state=${pr.state}`);
      push("github.pr.head_sha", pr.headSha, prSource, `head_sha=${pr.headSha}`);
      // mergeable の null は「GitHub がまだ判定していない」＝未観測なので Fact にしない。
      // review_decision の null は「レビュー未要求」という観測できた状態なので Fact にする。
      if (pr.mergeable !== null) {
        push("github.pr.mergeable", pr.mergeable, prSource, `mergeable=${pr.mergeable}`);
      }
      push(
        "github.pr.review_decision",
        pr.reviewDecision,
        prSource,
        `review_decision=${pr.reviewDecision ?? "null (レビュー未要求)"}`,
      );
      push(
        "github.pr.requested_reviewers",
        [...pr.requestedReviewers],
        prSource,
        `requested_reviewers=[${pr.requestedReviewers.join(", ")}]`,
      );

      // CI は PR の head sha に紐づくので、PR を観測できたときだけ引ける。
      const ciSource = `CodeProviderPort.getLatestCiRun(${pr.headSha})`;
      const ci = await observed(() => deps.code.getLatestCiRun(pr.headSha));
      if (ci !== null) {
        push("github.ci.status", ci.status, ciSource, `status=${ci.status}`);
        // 実行中の run は conclusion が null。まだ結論が出ていないだけなので Fact にしない。
        if (ci.conclusion !== null) {
          push("github.ci.conclusion", ci.conclusion, ciSource, `conclusion=${ci.conclusion}`);
        }
        // 失敗ジョブ名とログ URL。ここまで載せないと次の ACT が何を直すか決められない。
        if (ci.failedJobs.length > 0) {
          const failedJobs = ci.failedJobs.map((job) => ({ name: job.name, logUrl: job.logUrl }));
          push(
            "github.ci.failed_jobs",
            failedJobs,
            ciSource,
            failedJobs.map((job) => `${job.name} (${job.logUrl})`).join(", "),
          );
        }
      }
    }
  }

  const issueNumber = target.issueNumber;
  if (issueNumber !== null) {
    const issueSource = `CodeProviderPort.getIssue(${issueNumber})`;
    const issue = await observed(() => deps.code.getIssue(issueNumber));
    if (issue !== null) {
      push("github.issue.number", issue.number, issueSource, `number=${issue.number}`);
      push("github.issue.state", issue.state, issueSource, `state=${issue.state}`);
      push(
        "github.issue.labels",
        [...issue.labels],
        issueSource,
        `labels=[${issue.labels.join(", ")}]`,
      );
      push(
        "github.issue.linked_pr",
        issue.linkedPr,
        issueSource,
        `linked_pr=${issue.linkedPr ?? "null (未リンク)"}`,
      );
    }
  }

  // TODO(Phase 1): Port が throw したケースを unobserved に積む。
  // observed() が例外を握り潰しているため、いまは常に空になる。
  return { observedAt, facts, unobserved: [] };
}
