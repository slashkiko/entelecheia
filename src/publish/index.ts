import { worktreeBranchFor, worktreeNameFor } from "../act/index.js";
import type { Decision } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import { type Goal, type PublishStep, publishPolicyOf } from "../domain/goal.js";
import { DEFAULT_ACTOR_ROLE, type Run } from "../domain/run.js";
import type { Verification } from "../domain/verification.js";
import type { ReviewPort } from "../observe/index.js";

/**
 * PR を確保して進捗を書く。design.md §9 の「PR と通知」にあたる。
 *
 * OBSERVE が読む CodeProviderPort とは別のインターフェースにしてある。
 * §4.1 のとおり各 Provider は read と write を分ける。read だけを渡せば
 * 副作用を出せないことが型で分かる、という性質を保ちたい。
 */

export interface PullRequestDraft {
  head: string;
  base: string;
  title: string;
  body: string;
  /**
   * draft として立てるか。宣言が無ければ undefined になる。
   *
   * **false と undefined を混ぜない。** undefined は「Goal が何も言っていない」で、
   * 実装側はその場合に draft を送らない。GitHub の既定は false なので結果は同じだが、
   * 送る中身が変わらないことをここで型に残しておく（issue #65）。
   */
  draft?: boolean | undefined;
}

export interface CodeWriterPort {
  /** head ブランチに紐づく open な PR を探す。無ければ null */
  findPullRequest(head: string): Promise<number | null>;
  /** PR を作り、番号を返す。失敗したら throw する */
  createPullRequest(draft: PullRequestDraft): Promise<number>;
  addComment(prNumber: number, body: string): Promise<void>;
}

export interface PushResult {
  /** push 先のブランチ名 */
  branch: string;
  /** base との差分があって push したか。差分が無ければ false */
  pushed: boolean;
}

export interface BranchPort {
  /**
   * worktree の差分を feature ブランチに push する。
   *
   * base ブランチそのものへは push しない。実装側で弾く
   * （design.md §7 の push_to_default_branch）。
   */
  push(worktreeName: string, baseBranch: string): Promise<PushResult>;
}

export interface PublishTarget {
  goal: Goal;
  /** このティックで走った Run。ACT を選ばなかったティックでは null */
  run: Run | null;
  decision: Decision;
  verifications: readonly Verification[];
  /** 既に分かっている PR 番号。まだ無ければ null */
  prNumber: number | null;
  /** このティックの観測ダイジェスト */
  digest: string;
  /** 前のティックのダイジェスト。初回は null */
  previousDigest: string | null;
  /**
   * 前のティックの Decision。初回は null。
   *
   * ガード停止（`GUARD_REASONS`）が続くあいだ、同じ通知を毎ティック積まないための材料。
   * 停止に入った最初のティックは書き、観測が変わらないまま同じ停止が続くティックは
   * 飛ばす（`repeatsGuardStop`）。省略時（既存の呼び出し）は「前が無い」と同じ扱いで、
   * ガード停止は従来どおり書く。
   */
  previousDecision?: Decision | null;
}

/** 進捗を PR の外に書くときの宛先。実体は CLI が作る（`ent run --report`） */
export type ReportDestination = "stdout" | "file";

/**
 * PR コメントの代わりに進捗を書く先。
 *
 * `CodeWriterPort` と別にしてあるのは、こちらが PR 番号を必要としないため。
 * PR を確保できるかどうかと切り離せることが、この宛先の存在理由になる。
 */
export interface ProgressSink {
  /** どこに書くか。結果に載せて、読む側が探す場所を分かるようにする */
  readonly destination: ReportDestination;
  /** 進捗を1件書く。失敗したら throw する（publish が握って結果に変える） */
  write(body: string): Promise<void>;
}

export interface PublishDeps {
  writer: CodeWriterPort;
  branch: BranchPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
  /**
   * 進捗の宛先を PR の外に移す。未指定なら従来どおり PR コメントに書く。
   *
   * 指定されたら PR には**投稿しない**。両方に出すと「投稿しない」を満たさない。
   */
  report?: ProgressSink | undefined;
  /**
   * 直近のレビュー役の Run を読む口（issue #59）。
   *
   * 読むのは `report` があるティックだけになる。PR コメントには載せないので、
   * 付けないティックで開くと、使わない本文のために毎回生ログを開くことになる。
   * 失敗する口が1つ増えるだけで、誰も読まない。
   *
   * 任意にしてあるのは、publish を単体で呼ぶ経路（既存のテストを含む）を
   * 壊さないため。controller からは `ControllerDeps`（`ObserveDeps` を継承する）
   * がそのまま渡るので、実運用では常に入っている。
   */
  review?: ReviewPort | undefined;
}

/** PR の外に進捗を書いた結果。`--report` が無ければ null になる */
export interface ReportResult {
  destination: ReportDestination;
  /** 実際に書けたか */
  written: boolean;
  /** 書けなかった理由。書けたなら null */
  error: string | null;
}

/**
 * 宣言（`policies.publish`）で止めた段と、代わりに動く側が要る事実。
 *
 * `ReportResult` と同じ形にしてある。あちらも「その口を使ったティックにだけ載る、
 * publish の結果」で、`destination` / `written` / `error` という**行った先と結果**を
 * 構造で返している。ここも同じく、止めた段と、続きをやるのに要る宛先
 * （head と base）を構造で返す。
 *
 * `skipped` や `decision.rationale` の文面と別に持つ。あちらは人間が読む1行で、
 * 文面は直る。停止条件や「代わりに PR を立てるか」を文字列の部分一致に載せると、
 * 文面を直した瞬間に読む側の分岐が黙って消える。
 */
export interface PublishHold {
  /** 止めた段 */
  step: PublishStep;
  /**
   * 止めた理由の種別。いまは宣言だけ。
   *
   * `step` に畳まない。段が増えるより先に「別の事情で止める」が増える方があり得るので、
   * 「宣言で止めた」を読む側が名指しで確かめられるようにしておく。
   */
  reason: "declared_manual";
  /**
   * controller が push を済ませたか。`branch` が remote にあるかと同義。
   *
   * **`step` から導けるが、それでも別に持つ。** remote に無いブランチに PR は
   * 立てられないので、代わりに立てる側はここを見てから動く。導出に頼らせると、
   * publish の順序が変わったときに読む側のコードが静かに間違う。
   */
  pushed: boolean;
  /** PR の head になるブランチ。押していない段でも、押す先はこの名前になる */
  branch: string;
  /** PR の base */
  base: string;
}

export interface PublishResult {
  /** 確保できた PR 番号。作れなかった、あるいは作る段でなければ null */
  prNumber: number | null;
  /** このティックで新しく作ったか */
  created: boolean;
  /** このティックでコメントを書いたか */
  commented: boolean;
  /** PR の外に進捗を書いた結果。宛先の指定が無ければ null */
  report: ReportResult | null;
  /** 宣言で止めた段。止めていなければ null */
  held: PublishHold | null;
  /** 何もしなかった理由。した場合は null */
  skipped: string | null;
}

/**
 * PR を確保し、状態が変わっていれば進捗を書く。
 *
 * 満たすべき性質:
 * - 同じ head ブランチに2本目の PR を立てない。作る前に必ず探す。
 *   push まで済んで作成の前に kill されたとき、次のティックが2本目を立てると
 *   どちらが正かを決められなくなる
 * - 差分が無ければ PR を作らない。空の PR は通知にも検証にも使えない
 * - 進捗コメントは observed_digest が変わったときだけ書く。
 *   同じ状態を毎ティック通知すると、人間が読むのをやめる
 * - どの経路でも throw しない。失敗は skipped の理由として返す。
 *   通知に失敗しただけでティック全体を落とさない
 * - `deps.report` があれば、進捗は PR ではなくそちらに書く（`ent run --report`）。
 *   push と PR の確保は止めない。移るのは通知の宛先で、そこにレビュー役の本文が
 *   1節ぶん増える（`withReviewMessage`）
 * - `policies.publish` で `manual` と宣言された段は行わない。行わなかったことを
 *   `held` に載せて返す。**黙って何もしない経路は作らない。** 押せなかったのと
 *   押さないと決めていたのが同じ見た目になると、人間はどちらかを確かめに
 *   ログを掘ることになる（design.md §7）
 */
export async function publish(target: PublishTarget, deps: PublishDeps): Promise<PublishResult> {
  // ここで組み立てる本文は、宛先を問わず1つになる。criteria の pass 状況が
  // PR で読んだ人と手元で読んだ人で食い違わないのは、この1本を両方に渡すため。
  //
  // **ただし `--report` の宛先にだけ、この後ろにレビュー役の本文が1節付く**
  // （issue #59 の案1）。したがって「本文は宛先に関わらず完全に同じ」は、
  // もう成り立たない。事故ではなく判断で、issue #59 の3案のうち案3（PR に
  // 投稿する）を採らなかった結果になる。PR コメントは人間が購読していて、
  // 毎ティック 14,000 字が積まれると読むのをやめる。`--report stdout` は
  // 1回叩いて1回出すので、長い本文を置いても積み上がらない。
  //
  // **`--report <path>` は積み上がる。** あちらは追記で（`src/cli/present.ts` の
  // `reportSink`）、追記なのは cron から回したときに最後の1ティックしか残らない
  // のを避けるための選択になる。しかも `ReviewPort.latest()` が返すのは直近の
  // 完了したレビュー役の Run なので、次のレビューが終わるまで毎ティック同じ本文が
  // 返る（`WAIT(review_pending)` が続く区間がこれにあたる）。**案3 を退けた理由は、
  // 採った案1のこの宛先でそのまま再現する。** 畳む口はまだ無い——前ティックに
  // どの Run を出したかを publish は持っておらず、渡すには `PublishTarget` を
  // 足すことになる。作るのは controller で、そちらは PROTECTED_PATH_FLOOR の中になる。
  //
  // 動かさないのは criteria の表の位置で、節は必ずこの本文の**後ろ**に足す
  // （`withReviewMessage`）。宛先が違っても、表は同じ位置で読める。
  //
  // 末尾に入る時刻は、以前は push と PR 作成の往復を終えてから取っていた。ここに
  // 移したので、その往復ぶん（数秒）だけ早くなる。示したいのは「このティックが
  // いつ判断したか」なので、通信の所要時間を含まない方がむしろ近い。
  const body = commentBody(target, deps.now(), null, null);

  // PR の外に書くなら、PR の確保より先に書く。**この順序が仕様になる。**
  // 下の経路は、PR を作れない・作る段でない・まだ番号が無いといった理由で
  // 早く return する。この口を使う動機の多くは「PR がまだ無い」「トークンが
  // 無い」側にあるので、後ろに置くと要るときに書けない。
  //
  // ダイジェストが前ティックと同じでも書く。PR コメントを飛ばすのは、同じ通知が
  // 積まれると人間が読むのをやめるため。1回叩いて1回出す宛先では、黙って何も
  // 出さない方が読めない（「回したのに出ない」と「回っていない」が同じ見た目になる）。
  //
  // レビュー役の本文は**この宛先にだけ**足す（issue #59 の案1）。読みに行くのも
  // ここだけになるので、`--report` を付けないティックでは生ログを開かない。
  const report =
    deps.report === undefined
      ? null
      : await deliver(deps.report, await withReviewMessage(body, deps.review));

  /** 宣言で止めた段。`ensurePullRequest` が決める。null なら止めていない */
  let held: PublishHold | null = null;

  const nothing = (skipped: string): PublishResult => ({
    prNumber: target.prNumber,
    created: false,
    commented: false,
    report,
    held,
    skipped,
  });

  let prNumber = target.prNumber;
  let created = false;
  /** push が失敗した理由。コメントに載せる。null なら push まで通っている */
  let pushFailure: string | null = null;

  try {
    const ensured = await ensurePullRequest(target, deps);
    // 止めた段は、早く return する経路でも必ず返す。`nothing` はこの変数を読む。
    held = ensured.held;
    if (ensured.skipped !== null && prNumber === null) {
      return nothing(ensured.skipped);
    }
    prNumber = ensured.prNumber ?? prNumber;
    created = ensured.created;
  } catch (error) {
    // PR を作れなくても観測と判断は済んでいる。ティック全体は落とさない。
    //
    // **PR が既にあるなら、ここで降りない。** 以前は push が throw した時点で
    // 無条件に return していた。push の機会を Actor の実行から外したので、
    // `ESCALATE(uncommitted_changes)` のティック——**人間が作業ツリーを手で
    // 触っている状態**、つまり push が throw しやすい状態そのもの——でも必ず
    // push を試すようになった。そこで降りると、止めた理由が PR に一度も出ない
    // まま WAITING_HUMAN になる。人間に届かない関門は鳴っていないのと同じで、
    // 下の「関門が止めたティックは必ず書く」が守ろうとしているものが消える。
    if (prNumber === null) {
      return nothing(`Could not secure a pull request: ${errorMessage(error)}`);
    }
    pushFailure = errorMessage(error);
  }

  // 宛先を移したティックは、ここで終わる。PR には投稿しない。
  if (report !== null) {
    return {
      prNumber,
      created,
      commented: false,
      report,
      held,
      skipped: `Wrote the progress to ${report.destination} instead of the pull request`,
    };
  }

  if (prNumber === null) {
    return nothing("There is no pull request yet, so there is nothing to comment on");
  }

  // 同じ状態を毎ティック通知しない。読まれなくなる通知は無いのと同じ。
  //
  // ただし関門が止めたティックは、その停止が**新しいうちは**書く。ダイジェストは
  // Fact だけから作るので Decision を含まない。Actor が worktree の外だけを書いた
  // 場合、観測は前ティックと1文字も変わらないまま decision だけが ESCALATE に
  // 差し替わる。そこを黙って飛ばすと、隔離が破れたことが PR に一度も出ないまま
  // WAITING_HUMAN になる。人間に届かない関門は鳴っていないのと同じ。だから
  // 「停止に入ったティック」（前ティックが同じガード停止でない）は必ず書く。
  //
  // **一方、同じガード停止が観測も変わらないまま続くティックは飛ばす**
  // （`repeatsGuardStop`）。以前はここを毎ティック書いていたが、同じ reason の同じ
  // コメントを積み増しても情報は増えず、GitHub は初回コメントで通知を出す。読まれなく
  // なる通知は無いのと同じで、これは publish が既に持っている「同じ状態を毎ティック
  // 通知しない」原則そのもの——ガード停止だけがその例外になっていた。停止の初回は必ず
  // 出し、変化の無い繰り返しだけを畳む（`PublishTarget.previousDecision`）。人間が実際に
  // 手を動かしたティックは観測が変わるので、そのときは畳まれず出る。
  //
  // push が落ちたティックと宣言で止めたティックは、この畳み込みに載せない。どちらも
  // `pushFailure` / `held` が今ティックの状態から毎回作られ、前ティックの Decision には
  // 現れないので、繰り返しかどうかをここでは判定できない。とくに `pushFailure` は
  // エラー文がティックごとに変わりうるので、reason だけを見る `repeatsGuardStop` では
  // 「同じ」と言い切れない。黙って飛ばすと PR は静かなまま人間が待つので、従来どおり書く。
  if (
    target.previousDigest === target.digest &&
    (!stoppedByGuard(target.decision) ||
      repeatsGuardStop(target.decision, target.previousDecision)) &&
    pushFailure === null &&
    held === null
  ) {
    return {
      prNumber,
      created,
      commented: false,
      report,
      held,
      skipped: "The observation is identical to the previous tick",
    };
  }

  try {
    // push が落ちた、あるいは宣言で止めたときだけ本文を作り直す。`body` は push より
    // 前に作るので、どちらもまだ知らない。通常のティックでは作り直さない。
    const withNotice =
      pushFailure === null && held === null
        ? body
        : commentBody(target, deps.now(), pushFailure, held);
    await deps.writer.addComment(prNumber, withNotice);
    return { prNumber, created, commented: true, report, held, skipped: null };
  } catch (error) {
    return {
      prNumber,
      created,
      commented: false,
      report,
      held,
      skipped: `Could not post the comment: ${errorMessage(error)}`,
    };
  }
}

/**
 * 進捗を PR の外に書く。書けなくても throw しない。
 *
 * 失敗しても PR に流し直さない。投稿しないと言われている以上、書けなかった
 * ことを結果に載せて返すのが正しい。呼び出し側（CLI）がそれを人間に見せる。
 */
async function deliver(sink: ProgressSink, body: string): Promise<ReportResult> {
  try {
    await sink.write(body);
    return { destination: sink.destination, written: true, error: null };
  } catch (error) {
    return { destination: sink.destination, written: false, error: errorMessage(error) };
  }
}

/**
 * レビュー役の本文の節の見出し。
 *
 * 宛先の本文のどこに足したかを、読む側が探せるようにする。文言を変えると
 * 探し方が変わるので、`tests/publish-review-body.test.ts` と対にしてある。
 */
const REVIEW_HEADING = "## Review role message";

/**
 * `--report` の宛先の本文に、レビュー役の最終メッセージを足す（issue #59 の案1）。
 *
 * 満たすべき性質:
 * - **いまの本文の後ろに足す。** criteria の表の位置を動かさない。前に割り込ませると、
 *   14,000 字の本文を読み飛ばさないと pass 状況に辿り着けなくなる
 * - **本文はそのまま出す。** `flatten` も `oneLine` も通さない。改行・表・コード
 *   ブロックが落ちれば、要約を読ませることになって取り返した意味が消える
 * - **読めなかったときも黙らない。** 理由を節に出す。黙って落とすと、この Goal が
 *   直そうとしている壊れ方（本文が verdict の1語に畳まれて消える）をもう1つ作る
 * - **どの経路でも throw しない。** publish の既存の性質を、この節のために崩さない。
 *   ここで throw すると、レビューの生ログが1つ壊れているだけでティックが落ちる
 *
 * `latest()` が null を返したときだけ、節そのものを出さない。書くことが無いのと、
 * 書けなかったのを同じ見た目にしない。null になる条件は「1度も起動していない」
 * だけではないので、下の分岐のコメントに書いてある。
 */
async function withReviewMessage(body: string, review: ReviewPort | undefined): Promise<string> {
  const section = await reviewSection(review);
  return section === null ? body : `${body}\n\n${section}`;
}

/** レビュー役の本文の節。出すものが無ければ null */
async function reviewSection(review: ReviewPort | undefined): Promise<string | null> {
  if (review === undefined) {
    return null;
  }

  let snapshot: Awaited<ReturnType<ReviewPort["latest"]>>;
  try {
    snapshot = await review.latest();
  } catch (error) {
    // 理由をそのまま出す。Adapter は「どの Run の、どのファイルを、なぜ」を
    // 詰めて投げてくる（`src/adapters/review-run.ts`）ので、ここで畳むと
    // 生ログに戻る道が消える。
    return [
      REVIEW_HEADING,
      "",
      "> [!WARNING]",
      "> Could not read the review role's message. The reason follows.",
      "",
      errorMessage(error),
    ].join("\n");
  }

  // Port が出すものを持っていない。書くことが無いので節を出さない。
  //
  // **null は「1度も起動していない」だけではない。** `latestReviewRun()`
  // （`src/adapters/review-run.ts`）は `role: review` かつ `status: "completed"` の
  // Run だけを候補にするので、レビュー役が `interrupted`（SIGTERM）や `failed` でしか
  // 終わっていない Goal でも null になる。**その見た目は1度も起動していないときと
  // 完全に同じで、ここからは区別を作れない。** Port が返すのは snapshot か null かの
  // 2値で、どちらの理由で null かは載っていない。Adapter は PROTECTED_PATH_FLOOR の
  // 中なので、区別が要るなら向こう側の戻り値を足すところから始まる。
  if (snapshot === null) {
    return null;
  }

  // 途中で切れた Run。Adapter は空文字で返す。「本文が空だった」と
  // 「レビューを回していない」を同じ見た目にしないので、読んだ Run の id は出す。
  if (snapshot.finalMessage.trim() === "") {
    return [
      REVIEW_HEADING,
      "",
      `Read the latest review role Run \`${snapshot.runId}\`, but no message was left behind.`,
    ].join("\n");
  }

  return [
    REVIEW_HEADING,
    "",
    `The last message returned by the latest review role Run \`${snapshot.runId}\`.`,
    "",
    // ここだけは加工しない。取り返したいのは本文そのものになる。
    snapshot.finalMessage,
  ].join("\n");
}

/**
 * 差分を push し、PR を確保する。
 *
 * **PR の有無で push を止めない。** 最初はここで `prNumber !== null` なら
 * すぐ返していたが、それだと2ティック目以降の Actor の作業が remote に届かない。
 * 実際に自己ホストで回したとき、PR は1ティック目の内容のまま止まり、CI は
 * 「実装が無い」と言い続けた。
 *
 * **push が送るのは commit 済みの差分だけになる。** ここは以前「Actor は毎ティック
 * worktree に commit している」と書いていたが、それは観測ではなく仮定だった。
 * commit を要求しているところは controller のどこにも無く、intent は LLM が
 * 生成するので、commit に言及しない intent が出れば Actor は書いたまま終わる。
 * 実際に出た。書き残された変更はこの関数からは見えない（差分が無いのと区別が
 * つかない）ので、検知は controller 側に置いてある（`uncommittedDecision`）。
 */
async function ensurePullRequest(
  target: PublishTarget,
  deps: PublishDeps,
): Promise<{
  prNumber: number | null;
  created: boolean;
  held: PublishHold | null;
  skipped: string | null;
}> {
  // 止めた段に載せる宛先。押す前でも決まるので、両方の段で同じ値を使える。
  // **規則をここに書かない。** `worktreeBranchFor`（src/act/index.ts）が正で、
  // 2箇所に持つと、案内した push 先と実際に押す先がずれても誰も気づけない。
  const branch = worktreeBranchFor(pushWorktree(target.goal));
  const base = target.goal.repository.default_branch;
  // 制御ループ自体に触れた変更は push もしない（design.md §7）。
  // remote に出た時点で、通常の変更として流れる余地が生まれる。
  // 検査できなかった場合も同じ扱いにする。関門が動いていない状態で push するのは、
  // 関門が無いのと同じになる。
  if (blocksPush(target.decision)) {
    return {
      prNumber: target.prNumber,
      created: false,
      held: null,
      skipped:
        "The protected path gate did not pass, so neither push nor pull request creation runs",
    };
  }

  const policy = publishPolicyOf(target.goal);

  // 宣言で止まる段は、実行する前に返す。**「押してから無かったことにする」形は
  // 取れない。** remote に出たブランチも、飛んだ通知も戻らない。
  if (policy.push_branch === "manual") {
    return {
      prNumber: target.prNumber,
      created: false,
      // remote には1行も出ていない。`pushed: false` がそれを言う唯一の値になる。
      held: { step: "push_branch", reason: "declared_manual", pushed: false, branch, base },
      skipped: "policies.publish.push_branch: manual is declared, so nothing is pushed",
    };
  }
  // **Run の有無で push を決めない。** ここは以前「完了した Run が無いティックでは
  // push するものが無い」と書いていたが、それは「commit するのは Actor だけ」という
  // 仮定だった。`ESCALATE(uncommitted_changes)` の解決手順は人間が commit することで、
  // その commit には Run が付かない。PR が立ったあとの DECIDE は
  // `WAIT(review_pending)` を選び続けるので次の ACT も来ず、人間が片付けた差分は
  // remote に出ないまま固まる（実際に PR #34 がそうなった）。
  //
  // 失敗した Run のティックも同じく送る。push が送るのは commit 済みの差分だけなので、
  // 失敗した Actor の書きかけはそもそも乗らない。前のティックまでに commit された分を
  // 止める理由が無い。
  const pushed = await deps.branch.push(
    pushWorktree(target.goal),
    target.goal.repository.default_branch,
  );
  if (!pushed.pushed) {
    // 空の PR は通知にも検証にも使えない。
    return {
      prNumber: target.prNumber,
      created: false,
      held: null,
      skipped: "There is no diff against base",
    };
  }
  if (target.prNumber !== null) {
    // push は済んだ。PR はもうあるので作らない。
    return { prNumber: target.prNumber, created: false, held: null, skipped: null };
  }

  // 作る前に必ず探す。2本目を立てるとどちらが正かを決められなくなる。
  //
  // **宣言で止める前に探す。** 人間が手で立てた PR がここで見つかるので、
  // `open_pull_request: manual` のまま Goal を先へ進められる。宣言より先に
  // 止めてしまうと、人間が PR を立てても controller はそれを一度も見ないまま
  // 毎ティック同じところで止まり、宣言を書き換える以外に進む道が無くなる。
  const existing = await deps.writer.findPullRequest(pushed.branch);
  if (existing !== null) {
    return { prNumber: existing, created: false, held: null, skipped: null };
  }

  // 止めるのは「作る」ことだけになる。PR の作成はレビュアーへの通知を伴い、
  // 取り消しても通知は戻らない。push（ブランチが remote に出るだけ）とは
  // 戻せなさが違うので、段を分けて宣言できるようにしてある。
  if (policy.open_pull_request === "manual") {
    return {
      prNumber: null,
      created: false,
      // ここへ来るのは push が通ったあとだけになる。`pushed: true` は「この
      // ブランチに PR を立ててよい」を意味するので、押す前の段から出してはいけない。
      // 押していないブランチを head にした `gh pr create` は落ちる。
      held: {
        step: "open_pull_request",
        reason: "declared_manual",
        pushed: true,
        branch: pushed.branch,
        base,
      },
      skipped:
        "policies.publish.open_pull_request: manual is declared, so no pull request is created",
    };
  }

  const number = await deps.writer.createPullRequest({
    head: pushed.branch,
    base: target.goal.repository.default_branch,
    title: target.goal.goal.name,
    body: pullRequestBody(target.goal),
    // 宣言が無ければ undefined のまま渡す。Adapter がそのとき draft を送らない。
    draft: target.goal.repository.pull_request?.draft,
  });
  return { prNumber: number, created: true, held: null, skipped: null };
}

/**
 * push 先の作業ツリー。Goal だけから決まる。
 *
 * Run が無いティックでも押すので `run.worktree` は読めない。**名前の規則を
 * ここに書かない。** `worktreeNameFor`（src/act/index.ts）が正で、規則を2箇所に
 * 持つと、検査と push が別の作業ツリーを見ていても誰も気づけない。
 *
 * 役割は実装役に固定する（design.md §10-11）。`local.*` を観測するのも criteria の
 * コマンドを流すのも未 commit の関門が見るのも実装役の作業ツリーで、push だけを
 * `run.worktree` に従わせると、レビュー役が走ったティックだけ検査した木と押す木が
 * ずれる。ずれた先に PR は無いので、押した分はどの検証にも載らない。
 */
function pushWorktree(goal: Goal): string {
  return worktreeNameFor(goal.goal.id, DEFAULT_ACTOR_ROLE);
}

/** push を止める ESCALATE の理由。どちらも「関門が通っていない」を意味する */
const UNPUSHABLE_REASONS = new Set<string>(["protected_path_touched", "guard_unavailable"]);

/**
 * 通知を必ず書く ESCALATE の理由。controller の関門（guard）が止めたティック。
 *
 * push を止める理由に `uncommitted_changes` を足さないのは、あれが「commit された
 * ものは出してよい」状態だから。逆に通知の側では同じ扱いにする。どれもダイジェストに
 * 現れない理由で止まるので、黙って飛ばすと PR が静かなまま max_reconciles に当たる。
 *
 * `loop_detected` もここに入れる。**あれはダイジェストが動かないことが発火条件そのもの**
 * なので、下の「観測が前ティックと同じなら飛ばす」に必ず捕まる。足さないと、空回りで
 * 止めたティックが PR に一度も出ないまま WAITING_HUMAN になり、PR だけ見ている人間には
 * 止まった理由が届かない。report の宛先（`--report`）は早期リターンより前に必ず書くので
 * ここには関係せず、PR コメントの側だけを塞ぐ（`deliver` の位置、design.md §4.3）。
 * 通知は1度きり。次のティックは WAITING_HUMAN で idle なので publish に達しない。
 */
const GUARD_REASONS = new Set<string>([
  ...UNPUSHABLE_REASONS,
  "uncommitted_changes",
  "loop_detected",
]);

/** 関門が止めたティックか。通知の必須化が読む */
function stoppedByGuard(decision: Decision): boolean {
  return decision.action.type === "ESCALATE" && GUARD_REASONS.has(decision.action.reason);
}

/**
 * 観測が変わらないまま続いたとき、2ティック目以降の通知を畳んでよいガード停止。
 *
 * ここに入る reason は、`GUARD_REASONS` と同じく「停止に入った初回は必ず出す」が、
 * 同じ reason の停止が観測も変わらないまま続くティックでは再通知を飛ばす。同じ
 * コメントを積み増しても情報は増えないので、publish の「同じ状態を毎ティック通知
 * しない」原則に揃える。人間が手を動かせば観測が変わり、そのときは畳まれずに出る。
 *
 * いまは `GUARD_REASONS` の ESCALATE 全部を入れている。以前は安全側の信号
 * （protected_path_touched / guard_unavailable）と督促（uncommitted_changes）を
 * 毎ティック鳴らし続けていた（design.md §10-6）が、Goal は停止していて危険は
 * 「停止」が抑えており、2回目以降の同じ通知が守るものは無い——と判断して畳む側に
 * 倒した。**`held`（宣言 manual）と `pushFailure` はここに無い。** どちらも ESCALATE の
 * reason ではなく別フィールドで毎ティック組み立てられ、とくに `pushFailure` は
 * エラー文が変わりうるので reason だけでは「同じ」と言えない。
 */
const DEDUP_WHEN_REPEATED = new Set<string>([
  "loop_detected",
  "protected_path_touched",
  "guard_unavailable",
  "uncommitted_changes",
]);

/**
 * 前ティックと同じ、畳んでよいガード停止の繰り返しか。観測が変わらないまま同じ
 * 停止が続くティックを、通知から畳むために読む。
 *
 * 「同じ」は ESCALATE の reason で見る。停止に入った最初のティックは前ティックが
 * 別の行動（ACT など）なので false になり、必ず書かれる。前ティックが無いとき
 * （初回・`previousDecision` 省略）も false で、停止は書かれる。
 */
function repeatsGuardStop(decision: Decision, previous: Decision | null | undefined): boolean {
  return (
    decision.action.type === "ESCALATE" &&
    DEDUP_WHEN_REPEATED.has(decision.action.reason) &&
    previous != null &&
    previous.action.type === "ESCALATE" &&
    previous.action.reason === decision.action.reason
  );
}

/** 関門が push まで止めるティックか */
function blocksPush(decision: Decision): boolean {
  return decision.action.type === "ESCALATE" && UNPUSHABLE_REASONS.has(decision.action.reason);
}

/**
 * PR の本文。Goal の宣言部から作る。
 *
 * 進捗はコメントに積むので、本文は「この PR が何のためにあるか」に絞る。
 * 毎ティック本文を書き換えると、レビューが差分を追えなくなる。
 */
function pullRequestBody(goal: Goal): string {
  return [
    `Changes for the entelecheia Goal \`${goal.goal.id}\`.`,
    "",
    "## Desired State",
    "",
    goal.goal.desired_state.trim(),
    "",
    "## Acceptance Criteria",
    "",
    ...goal.acceptance_criteria.map(
      (c) => `- \`${c.id}\` (${c.verification.type}) ${c.description}`,
    ),
    "",
    "The controller stacks progress as comments. Approve with the following phrase.",
    "",
    "```",
    "/ent approve <criterion-id>",
    "```",
  ].join("\n");
}

/**
 * controller が書いた進捗コメントであることの目印。
 *
 * 承認の検知（design.md §10-4）がこれを見て自分のコメントを除外する。
 * rationale には LLM が決めた intent がそのまま載るので、そこに
 * `/ent approve <criterion-id>` を書かせれば、controller 自身のコメントとして
 * 承認の定型文が成立してしまう。Agent に `gh pr comment` を禁じて塞いだ経路を、
 * controller が迂回する形になっていた。
 *
 * 目印は HTML コメントにして、人間が読む本文には出さない。
 */
export const PROGRESS_MARKER = "<!-- ent:progress -->";

/**
 * 進捗コメント。
 *
 * action と rationale だけでは「何が残っているか」が読めないので、
 * criteria ごとの Verification.result を並べる。
 */
function commentBody(
  target: PublishTarget,
  now: Date,
  pushFailure: string | null,
  held: PublishHold | null,
): string {
  const rows = target.verifications.map(
    (v) => `| \`${v.criterionId}\` | ${MARKERS[v.result]} ${v.result} | ${oneLine(v.detail)} |`,
  );

  return [
    PROGRESS_MARKER,
    `### ${describeAction(target.decision)}`,
    "",
    // push が落ちたことを本文の先頭に出す。この下の criteria はローカルの
    // 作業ツリーを見た結果なので、全部緑でも remote には何も出ていない。
    ...(pushFailure === null
      ? []
      : [`> [!WARNING]`, `> Could not push: ${oneLine(pushFailure)}`, ""]),
    // 宣言で止めたことも先頭に出す。落ちたのではないので WARNING にはしない。
    // 下の criteria が全部緑でも、その先は人間が進める、という但し書きになる。
    ...(held === null
      ? []
      : [`> [!NOTE]`, ...heldNotes(held.step, target.goal.goal.id).map((line) => `> ${line}`), ""]),
    // 改行を潰す。承認の定型文は行単位で照合されるので、本文の途中に
    // 独立した1行を作らせない。目印による除外と二重にしておく。
    flatten(target.decision.rationale),
    "",
    "| criterion | result | detail |",
    "|---|---|---|",
    ...rows,
    "",
    ...(target.run === null
      ? []
      : [`Run \`${target.run.id}\`: ${target.run.status} (tokens: ${target.run.tokens ?? 0})`, ""]),
    `<sub>decided_by: ${target.decision.decidedBy} / digest: \`${target.digest.slice(0, 12)}\` / ${now.toISOString()}</sub>`,
  ].join("\n");
}

/**
 * 宣言で止めた段を、PR を読む人間に伝える文面。
 *
 * **PR に出る説明はここだけになる。** `publishHeldDecision`（`src/controller/index.ts`）が
 * 組み立てる rationale は publish の**後ろ**で判断を差し替えるので、この関数に渡る
 * `target.decision` は差し替え前のものになる。同じファイルのもう1つの関門
 * （`uncommittedDecision`）は publish の前で差し替わるため PR と `ent get` に同じ
 * 文字列が出るが、こちらは出ない。**その分をここに書く。** 「push していない」だけを
 * 書くと、人間が最も要る2つ——手で押しても解けないことと、`ent abandon` で終端に
 * できること——が PR の側から読めない。
 *
 * 行で返す。呼ぶ側が1行ずつ `> ` を付けるので、引用の外に独立した行を作らない。
 * 承認の定型文は行全体で照合されるので（`approves`、`src/adapters/github.ts`）、
 * 引用の外に行を作る形にすると、そこに並んだ文字列が承認として数えられる。
 *
 * `open_pull_request` の側は、いまのところ PR に出ない。この段で止まるのは
 * 「差分があり、まだ PR が無い」ティックだけで、書き込む先の PR がそもそも無いため
 * `publish` は「PR がまだ無いのでコメントできない」で降りる。**それでも文面を
 * 残しておく。** 段の並びが変わって PR がある状態で止まりうるようになったとき、
 * 文面が無いことに気づける形にしておくより、あるほうが壊れ方が小さい。
 */
function heldNotes(step: PublishStep, goalId: string): string[] {
  const declaration = `\`policies.publish.${step}\` in \`.goals/${goalId}.yaml\``;
  if (step === "open_pull_request") {
    return [
      "`policies.publish.open_pull_request: manual` is declared, so the controller does not open the pull request.",
    ];
  }
  return [
    "`policies.publish.push_branch: manual` is declared, so nothing was pushed. " +
      "This PR stays at whatever was pushed before the declaration.",
    "**Pushing by hand stays invisible to the controller.** The step it was told not to run is its " +
      "only path to the remote, so a manual push does not enter the next tick's decision.",
    `To resume, set ${declaration} back to \`auto\`. ` +
      `To stop tracking this Goal, terminate it with \`ent abandon ${goalId} --reason <reason>\`.`,
  ];
}

const MARKERS: Record<Verification["result"], string> = {
  passed: "🟢",
  failed: "🔴",
  unresolved: "🟡",
};

function describeAction(decision: Decision): string {
  const action = decision.action;
  switch (action.type) {
    case "ACT":
      return `ACT — ${oneLine(action.intent)}`;
    case "WAIT":
      return `WAIT(${action.reason})`;
    case "ESCALATE":
      return `ESCALATE(${action.reason})`;
    default:
      return action.type;
  }
}

/** 改行と連続する空白を1つに潰す。切り詰めない */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 表のセルとタイトルに入れる。改行と `|` が混ざると GFM の表が崩れる */
function oneLine(text: string): string {
  const collapsed = flatten(text).replace(/\|/g, "\\|");
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}
