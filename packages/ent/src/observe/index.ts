import { errorMessage } from "../domain/error-message.js";
import type { Fact, ObserveResult, Unresolved, VerifiedFact } from "../domain/fact.js";
import {
  GITHUB_PR_BODY_KEY,
  GITHUB_PR_TITLE_KEY,
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
  /**
   * PR のタイトル。**応答に無ければ null。**
   *
   * `mergeable` と同じく緩く読む。タイトルと本文はレビュー役に渡すためだけの値で、
   * 完了判定には使わない。ここを必須にすると、タイトルの欠けた応答1回で
   * `github.pr` の読み取りごと `shape_mismatch` になり、`state` も `head_sha` も
   * 落ちたうえで、guard が「待っても直らない」失敗として人間を呼ぶ。
   * **プロンプトに載せるためだけの項目に、Goal を止める力を持たせない。**
   */
  title: string | null;
  /**
   * PR の本文。**本文が無い PR では null になる。**
   *
   * 空文字ではなく null にしてあるのは、読む側が「空だった」と「取れなかった」を
   * 取り違えないようにするため。ここが null なのは前者で、後者は PR そのものが
   * 観測できていない（この Snapshot が作られない）。
   */
  body: string | null;
  /**
   * 未解決のレビュースレッドの件数。数え切れなければ null。
   *
   * **`0` と `null` を畳まない。** 0 は「未解決のスレッドが1つも無い」という
   * 観測できた結果で、null は「いくつあるのか確かめられなかった」になる。
   * 数え切れなかったぶんを 0 と読むと、指摘を残したまま
   * `equals: 0` の criterion が成立する。
   *
   * 省略可能にしない。型チェックを通す最も安いやり方が「フィールドを埋めない
   * Adapter を書く」になり、Port の契約が「数えたら入っているかもしれない」に
   * 弱まるため。
   */
  unresolvedThreads: number | null;
}

/**
 * head sha に紐づく CI の状態。
 *
 * `status` / `conclusion` / `headSha` は**最新の run 1本**のもので、
 * `failedJobs` / `failedJobCount` は**その sha の run を横断**したものになる。
 * 見ている範囲が違うので、片方を読んでもう片方を推し量らない（issue #58）。
 *
 * 横断する範囲は `repository.ci.exclude_workflows` で削れる。**削れるのは
 * `failedJobs` と `failedJobCount` の両方で、片方だけではない**（それぞれの注記）。
 */
export interface CiRunSnapshot {
  /** 対応する PR の head sha */
  headSha: string;
  /** 最新の run の status */
  status: "queued" | "in_progress" | "completed";
  /** 最新の run の conclusion。実行中なら null */
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
  /**
   * **除外後の** run を横断して集めた失敗ジョブ。次の ACT が何を直すかを決める材料になる。
   *
   * `repository.ci.exclude_workflows` で外した run の失敗ジョブは、数だけでなく
   * ここからも消える。**次の ACT に渡る材料が除外分だけ欠ける**ことになるが、
   * 残す側に倒すと「数から外した＝直さなくてよい」と宣言したはずの失敗を ACT に
   * 渡すことになり、除外の意味が消える。外した run について何が起きていたかは
   * `excludedWorkflows` の状態から読む。
   */
  failedJobs: { name: string; logUrl: string }[];
  /**
   * 除外後の run を横断して数えた失敗ジョブの数。**数え切れていなければ null。**
   *
   * null になるのは2通り。まだ終わっていない run が1本でもあるときと、
   * 1ページ（`per_page: 100`）で run を読み切れていないとき。
   *
   * **null と 0 を混ぜない。** 0 は「数え切って1件も無かった」で、
   * null は「まだ数が決まらない」にあたる。混ぜると push した直後の
   * queued な状態や、100 本を超えて読み切れていない状態が
   * 「落ちている job は 0 件」に見える。
   */
  failedJobCount: number | null;
  /**
   * `repository.ci.exclude_workflows` に書かれた名前と、それが実際に外した run。
   * 宣言が無ければ空配列になる。
   *
   * **宣言をそのまま写す。** 一致した分だけを残すと、書いたのに何も外していない名前
   * （typo か、今回は起動しなかった workflow か）が観測から消える。`runs: 0` として
   * 残せば、外から読んで気づける。
   *
   * `states` は外した run 1本ずつの見え方（`waiting` / `failure` / `success` …）を
   * 一致した順に並べたもの。**数だけでは「保留のままの gate を外した」と「本物の
   * 失敗を含む run を外した」を読み分けられない。** `failedJobs` から除外分が消える
   * 以上、消えたものが赤かったかはここでしか読めない。
   *
   * observe はこれを `github.ci.excluded_workflows` の Fact と
   * `failed_job_count` の detail の両方に出す。「全部緑」と「除外した上で緑」が
   * 同じ見た目になると、issue #58 が直そうとした壊れ方を作り直すことになる。
   */
  excludedWorkflows: { name: string; runs: number; states: string[] }[];
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
          ? `could not determine a single verdict line from the final message of ${where} (exactly one line reading ${REVIEW_VERDICTS.join(" / ")})`
          : `${where} states verdict=${verdict}, but the sha of the commit it read could not be determined, so this is not recorded as a Fact on its own`;
      pending(REVIEW_VERDICT_KEY, verdictDetail);
      pending(
        REVIEW_REVIEWED_SHA_KEY,
        sha === null
          ? `could not determine a single sha of the commit read from the final message of ${where}`
          : `the sha of ${where} read as ${sha}, but the verdict could not be determined, so the two cannot be paired`,
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
        `review_decision=${pr.reviewDecision ?? "null (no review requested)"}`,
      );
      push(
        "github.pr.requested_reviewers",
        [...pr.requestedReviewers],
        prSource,
        `requested_reviewers=[${pr.requestedReviewers.join(", ")}]`,
      );
      // タイトルと本文は、完了判定ではなくレビュー役に渡すために観測する
      // （`GITHUB_PR_TITLE_KEY` の注記）。body の null は「本文が空」という
      // 観測できた状態なので、review_decision と同じく Fact にする。
      //
      // evidence には本文を写さない。あれは追跡の手がかりで本文の控えではなく、
      // PR 本文は数百行になりうる。長さだけ残せば、値と食い違ったときに気づける。
      push(
        GITHUB_PR_TITLE_KEY,
        pr.title,
        prSource,
        pr.title === null ? "title=null (absent from response)" : `title=${pr.title}`,
      );
      push(
        GITHUB_PR_BODY_KEY,
        pr.body,
        prSource,
        pr.body === null ? "body=null (body is empty)" : `body=${pr.body.length} chars`,
      );
      // 未解決スレッドの件数。**0 は Fact にする。** ここが
      // `verification: { type: fact, key: github.pr.unresolved_threads, equals: 0 }`
      // の収束条件そのものなので、0 を falsy として落とすと永久に成立しない。
      //
      // null は mergeable と同じ扱いにする。Fact も unobserved も作らない。
      // 「いくつあるか確かめられなかった」ことと「未解決が 0 件」は別で、
      // かつ、ここで unresolved を積むと Gap がゼロの Goal で DECIDE が
      // COMPLETE ではなく WAIT を返すようになり（src/decide/index.ts）、
      // このキーを1文字も参照していない Goal まで完了できなくなる。件数を
      // 求めている Goal の側は、Fact が無ければ criteria が Gap(unknown) を
      // 立てるので、待つ理由はそちらに残る。
      if (pr.unresolvedThreads !== null) {
        push(
          "github.pr.unresolved_threads",
          pr.unresolvedThreads,
          prSource,
          `unresolved_threads=${pr.unresolvedThreads}`,
        );
      }

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
        // 落ちている job の数。**0 件でも Fact にする。** 下の failed_jobs と
        // 違って「1件以上あるとき」だけにすると、`equals: 0` が永久に届かず
        // 「この head sha で落ちている job が1つも無い」を criteria に書けない。
        //
        // 逆に、まだ回っている run があるあいだ（null）は Fact にしない。
        // conclusion が null の run を Fact にしないのと同じ規則で、そこで 0 を
        // 出すと push した直後の queued な状態で criterion が通る。
        //
        // 除外を宣言していれば、その内訳を同じ detail に書く。除外した結果を
        // 黙って隠すと、「落ちている job は 0 件」と「除外した上で 0 件」が
        // 同じ見た目になる。**それは issue #58 の壊れ方そのものになる。**
        const excluded = describeExcluded(ci.excludedWorkflows);
        if (ci.failedJobCount !== null) {
          push(
            "github.ci.failed_job_count",
            ci.failedJobCount,
            ciSource,
            `failed_job_count=${ci.failedJobCount} (across all workflow runs for the head sha${excluded === null ? "" : ` / excluded: ${excluded}`})`,
          );
        }
        // 除外そのものも Fact にする。数が確定していなくても出す。数を出さない
        // 理由（まだ回っている run がある）と、何を除外したかは別のことになる。
        //
        // 宣言が無ければ push しない。**Fact の有無が「除外したかどうか」になる。**
        if (excluded !== null) {
          push(
            "github.ci.excluded_workflows",
            ci.excludedWorkflows.map((w) => ({
              name: w.name,
              runs: w.runs,
              states: [...w.states],
            })),
            ciSource,
            excluded,
          );
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
        `linked_pr=${issue.linkedPr ?? "null (not linked)"}`,
      );
    }
  }

  return { observedAt, facts, unobserved };
}

/**
 * 除外の内訳を1行にする。宣言が無ければ null。
 *
 * 一致しなかった名前を落とさない。`runs: 0` は「書いたのに何も外していない」で、
 * typo かもしれないし、今回は起動しなかった workflow かもしれない。観測の側から
 * 区別できないので、数のまま出して人間に読ませる（`ciOptionsSchema` 参照）。
 *
 * 数の後ろに run 1本ずつの見え方を並べる。**数だけだと「保留のままの gate を
 * 外した」と「本物の失敗を含む run を外した」が同じ行になる。** 外した run の
 * 失敗ジョブは `github.ci.failed_jobs` からも消えるので、消えたものが赤かったかは
 * この行でしか読めない（`CiRunSnapshot.excludedWorkflows`）。
 */
function describeExcluded(
  excluded: readonly { name: string; runs: number; states: string[] }[],
): string | null {
  if (excluded.length === 0) {
    return null;
  }
  return excluded
    .map((w) =>
      w.runs === 0 ? `${w.name} (no match)` : `${w.name} (${w.runs} run / ${w.states.join(", ")})`,
    )
    .join(", ");
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
 * 読んだ commit を名指しする行。**行全体で照合する**（`VERDICT_LINE` と同じ理由）。
 *
 * 本文の途中に現れた `reviewed_sha: <40桁>` ——たとえば「こう書いてはいけない」と
 * 説明した行——を名指しとして拾うと、読んでいない commit のレビューが作れる。
 */
const REVIEWED_SHA_LINE = /^[ \t]*reviewed_sha:[ \t]*([0-9a-f]{40})[ \t]*$/i;

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
 * 先に `reviewed_sha:` の行を探し、無ければ本文中の sha を数える。
 *
 * **数えるだけの規則を単独で使わない。** これを足した当時、レビュー役のプロンプト
 * （`src/adapters/claude.ts`）が求めていたのは「読んだ commit の sha を述べる」
 * ことだけで、2つ目の完全な sha を書くと観測が無効になるとは言っていなかった。
 * 差分の比較元を完全形で併記する、`git log` の出力を1行引用する——どれも
 * 指示に従った書き方なのに、数えるだけの規則ではレビュー1回分が丸ごと落ちる。
 * 触れない側（FLOOR）に暗黙の契約を負わせず、読む側で名指しを先に見る。
 *
 * いまは `REVIEW_PROMPT` が `reviewed_sha:` の行を要求しているので、名指しのある
 * 出力が通常になった。それでも数える側は残す。名指しの無い出力——プロンプトを
 * 差し替える前の Run——を、待っても直らない失敗として扱う理由が無い。
 *
 * 名指しが2つ以上あって値が食い違うときは、本文中の sha を数える側へ落とさずに
 * null にする。「どれを読んだか」を名指しで2通り述べた出力は、数え直しても
 * 決まらない。
 *
 * 名指しが無い場合の規則はこれまでどおり。同じ sha を何度述べても1つと数え、
 * 違う sha が並んでいたら、どれを読んだ結果なのか決められないので null にする。
 */
function soleShaIn(finalMessage: string): string | null {
  const lines = finalMessage.split("\n");
  const labeled = new Set(
    lines
      .map((line) => REVIEWED_SHA_LINE.exec(line)?.[1]?.toLowerCase())
      .filter((sha): sha is string => sha !== undefined),
  );
  if (labeled.size > 0) {
    return labeled.size === 1 ? ([...labeled][0] ?? null) : null;
  }

  const found = new Set([...finalMessage.matchAll(SHA)].map((matched) => matched[0].toLowerCase()));
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
