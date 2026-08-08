import type { Fact, ObserveResult, Unresolved, VerifiedFact } from "../domain/fact.js";

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
 * Port の読み取り結果。「値が取れた」と「取れなかった」を型で分ける。
 *
 * 「対象が存在しない（Port が null を返した）」と「取得に失敗した（throw した）」は
 * どちらも Fact を作らない点では同じだが、前者は観測できた結果で後者は観測の失敗にあたる。
 * 両方を `null` に畳むと、GitHub の障害を「PR は無い」と読んだ ASSESS が誤った DECIDE をする。
 */
type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Port の例外を握り、observe() 全体を失敗させない。
 * 片方の Port が落ちても他方の観測は残したいため。
 */
async function observed<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 現在状態を観測して Fact 列を返す。
 *
 * 満たすべき性質:
 * - GitHub API と git から得た値は必ず VERIFIED、evidence 付き
 * - 観測できなかった対象について Fact を捏造しない
 * - ただし取得に失敗した対象は unobserved に理由付きで残す。
 *   「対象が無い」と「対象を確かめられなかった」を Fact の不在に畳まない
 * - CI が失敗しているときは、失敗ジョブ名とログ URL まで Fact に含める
 *   （「CI が落ちた」だけでは次の ACT に渡す材料がないため）
 */
export async function observe(target: ObserveTarget, deps: ObserveDeps): Promise<ObserveResult> {
  // 1 回だけ読む。同じ観測に含まれる Fact の observedAt を揃えて、
  // あとから「どのティックで見た値か」を突き合わせられるようにする。
  const observedAt = deps.now().toISOString();
  const facts: Fact[] = [];
  const unobserved: Unresolved[] = [];

  const push = (key: string, value: unknown, source: string, detail: string): void => {
    facts.push(verified(key, value, observedAt, source, detail));
  };

  /**
   * 読み取りに失敗した観測を積む。
   *
   * key は個別の観測キーではなく、その読み取りが埋めるはずだったキーの接頭辞にする。
   * 1 回の Port 呼び出しが複数のキーを埋めるので、どれが欠けたかは列挙できないため。
   */
  const failed = (keyPrefix: string, source: string, error: unknown): void => {
    unobserved.push({
      key: keyPrefix,
      reason: "port_failed",
      detail: `${source}: ${errorMessage(error)}`,
    });
  };

  const localSource = "LocalRepoPort.snapshot()";
  const localRead = await observed(() => deps.local.snapshot());
  if (localRead.ok) {
    const local = localRead.value;
    push("local.branch", local.branch, localSource, `branch=${local.branch}`);
    push("local.head_sha", local.headSha, localSource, `head_sha=${local.headSha}`);
    push("local.dirty", local.dirty, localSource, `dirty=${local.dirty}`);
  } else {
    failed("local", localSource, localRead.error);
  }

  const prNumber = target.prNumber;
  if (prNumber !== null) {
    const prSource = `CodeProviderPort.getPullRequest(${prNumber})`;
    const prRead = await observed(() => deps.code.getPullRequest(prNumber));
    if (!prRead.ok) {
      failed("github.pr", prSource, prRead.error);
    } else if (prRead.value !== null) {
      const pr = prRead.value;
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
      const ciRead = await observed(() => deps.code.getLatestCiRun(pr.headSha));
      if (!ciRead.ok) {
        failed("github.ci", ciSource, ciRead.error);
      } else if (ciRead.value !== null) {
        const ci = ciRead.value;
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
    const issueRead = await observed(() => deps.code.getIssue(issueNumber));
    if (!issueRead.ok) {
      failed("github.issue", issueSource, issueRead.error);
    } else if (issueRead.value !== null) {
      const issue = issueRead.value;
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

  return { observedAt, facts, unobserved };
}
