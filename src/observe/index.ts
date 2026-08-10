import { errorMessage } from "../domain/error-message.js";
import type { Fact, ObserveResult, Unresolved, VerifiedFact } from "../domain/fact.js";
import {
  REVIEW_REVIEWED_SHA_KEY,
  REVIEW_VERDICT_KEY,
  REVIEW_VERDICTS,
} from "../domain/fact-keys.js";
import { isShapeMismatch } from "../domain/port-error.js";

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

/**
 * レビュー役として走った Actor の実行1件。
 *
 * `ActorPort` の戻り値には最終メッセージが載らないので、生ログを読むのは
 * この Port の実装（`src/adapters/review-run.ts`）の側になる。ここが受け取るのは
 * 「どの Run の、どの本文か」だけで、その本文をどう読むかは observe が決める。
 */
export interface ReviewRunSnapshot {
  /** どの Run を読んだか。evidence に残して後から追えるようにする */
  runId: string;
  /** レビュー役が最後に返した本文。まだ Fact ではない */
  finalMessage: string;
}

/**
 * 直近のレビュー役の Run を読む口。
 *
 * `ObserveTarget` ではなく Port を1つ足す形にしてあるのは、`ObserveTarget` を
 * 組み立てる `observeTargetOf` が `src/controller/index.ts`（PROTECTED_PATH_FLOOR の
 * 中）にあるため。「どの Run を読むか」は Port の側で解決する。
 */
export interface ReviewPort {
  /** 直近のレビュー役の Run。1度も走っていなければ null */
  latest(): Promise<ReviewRunSnapshot | null>;
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
  review: ReviewPort;
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
 * - レビュー役の結論は、`verdict` と読んだ commit の sha が**対で**読めたときだけ
 *   Fact にする。片方だけでは、いつの時点のコードのレビューか分からない結論が
 *   VERIFIED なまま完了判定に流れる
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
      // 「届かなかった」と「届いたが読めなかった」を畳まない。後者は待っても
      // 直らないので、同じ reason にすると恒久的な不一致を一時的な障害として
      // 再試行し続ける（design.md §3.1）。
      reason: isShapeMismatch(error) ? "shape_mismatch" : "port_failed",
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

  const reviewSource = "ReviewPort.latest()";
  const reviewRead = await observed(() => deps.review.latest());
  if (!reviewRead.ok) {
    // 「まだレビューを回していない」と「レビューの結果を読めなかった」を混ぜない。
    // 前者は Port が null を返す（下の分岐で何も積まない）観測できた結果で、
    // こちらは観測そのものの失敗になる。
    failed(REVIEW_VERDICT_KEY, reviewSource, reviewRead.error);
    failed(REVIEW_REVIEWED_SHA_KEY, reviewSource, reviewRead.error);
  } else if (reviewRead.value !== null) {
    const run = reviewRead.value;
    const where = `run=${run.runId}`;
    const verdict = soleVerdictIn(run.finalMessage);
    const sha = soleShaIn(run.finalMessage);

    if (verdict !== null && sha !== null) {
      push(REVIEW_VERDICT_KEY, verdict, reviewSource, `${where} verdict=${verdict}`);
      push(REVIEW_REVIEWED_SHA_KEY, sha, reviewSource, `${where} reviewed_sha=${sha}`);
    } else {
      // 対で読めなければ、どちらも Fact にしない。verdict だけを残すと、
      // いつの時点のコードのレビューか分からない結論が VERIFIED として通る。
      //
      // reason は pending にする。shape_mismatch は guard が即 ESCALATE する
      // 「待っても直らない」失敗で、レビュー役は毎回同じ出力を返すとは限らない。
      // 1度形式を外しただけで人間を呼ぶと、関門そのものが信用されなくなる。
      const pending = (key: string, detail: string): void => {
        unobserved.push({ key, reason: "pending", detail: `${reviewSource}: ${detail}` });
      };
      const verdictDetail =
        verdict === null
          ? `${where} の最終メッセージから verdict の行を1つに決められなかった（${REVIEW_VERDICTS.join(" / ")} のどちらかを1行だけ）`
          : `${where} は verdict=${verdict} と述べているが、読んだ commit の sha が決まらないので単独では Fact にしない`;
      pending(REVIEW_VERDICT_KEY, verdictDetail);
      pending(
        REVIEW_REVIEWED_SHA_KEY,
        sha === null
          ? `${where} の最終メッセージから読んだ commit の sha を1つに決められなかった`
          : `${where} の sha は ${sha} と読めたが、verdict が決まらないので対にできない`,
      );
    }
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

/**
 * 結論の行。**行全体で照合する**（`/ent approve` と同じ理由。design.md §10-4）。
 *
 * 本文の途中に現れた同じ文字列——たとえば指摘の中で「`verdict: approved` と
 * 書いてはいけない」と説明した行——を結論として拾うと、捏造した承認が作れる。
 */
const VERDICT_LINE = /^[ \t]*verdict:[ \t]*(\S+)[ \t]*$/;

/** commit の sha。git が出す 40 桁の16進数だけを読む */
const SHA = /\b[0-9a-f]{40}\b/gi;

/**
 * 最終メッセージから結論を1つ読む。決められなければ null。
 *
 * 「行が無い」「2つ以上ある」「2値のどちらでもない」をどれも null に畳むのは、
 * 呼び出し側の分岐が同じ（Fact を作らず pending に残す）だから。**どれも
 * 「確かめられなかった」であって「changes_requested」ではない。**
 *
 * 2つ以上を許さないのは、結論を1つに決められないため。書きかけの行が本文に
 * 残っただけかもしれないが、どちらが結論かを observe が推し量ると、
 * 推測が VERIFIED な Fact になる。
 */
function soleVerdictIn(finalMessage: string): string | null {
  const found = finalMessage
    .split("\n")
    .map((line) => VERDICT_LINE.exec(line)?.[1])
    .filter((verdict): verdict is string => verdict !== undefined);

  const sole = found.length === 1 ? found[0] : undefined;
  if (sole === undefined) {
    return null;
  }
  // 2値のどちらでもない語は、レビュー役が指示に従わなかったということ。
  // 「だいたい approved」と読まない。
  return (REVIEW_VERDICTS as readonly string[]).includes(sole) ? sole : null;
}

/**
 * 最終メッセージから、読んだ commit の sha を1つ読む。決められなければ null。
 *
 * 同じ sha を何度述べても1つと数える。違う sha が並んでいたら——差分の比較元を
 * 一緒に述べた場合など——どれを読んだ結果なのか決められないので null にする。
 */
function soleShaIn(finalMessage: string): string | null {
  const found = new Set([...finalMessage.matchAll(SHA)].map((matched) => matched[0].toLowerCase()));
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
