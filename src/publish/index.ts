import { worktreeBranchFor, worktreeNameFor } from "../act/index.js";
import type { Decision } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import { type Goal, type PublishStep, publishPolicyOf } from "../domain/goal.js";
import { DEFAULT_ACTOR_ROLE, type Run } from "../domain/run.js";
import type { Verification } from "../domain/verification.js";

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
 *   push と PR の確保は止めない。移すのは通知の宛先だけになる
 * - `policies.publish` で `manual` と宣言された段は行わない。行わなかったことを
 *   `held` に載せて返す。**黙って何もしない経路は作らない。** 押せなかったのと
 *   押さないと決めていたのが同じ見た目になると、人間はどちらかを確かめに
 *   ログを掘ることになる（design.md §7）
 */
export async function publish(target: PublishTarget, deps: PublishDeps): Promise<PublishResult> {
  // 本文は宛先に関わらず1つ。宛先で内容が変わると、PR で読んだ人と手元で
  // 読んだ人が別のものを見ることになる。
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
  const report = deps.report === undefined ? null : await deliver(deps.report, body);

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
      return nothing(`PR を確保できなかった: ${errorMessage(error)}`);
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
      skipped: `進捗は PR ではなく ${report.destination} に書いた`,
    };
  }

  if (prNumber === null) {
    return nothing("PR がまだ無いのでコメントできない");
  }

  // 同じ状態を毎ティック通知しない。読まれなくなる通知は無いのと同じ。
  //
  // ただし関門が止めたティックは必ず書く。ダイジェストは Fact だけから作るので
  // Decision を含まない。Actor が worktree の外だけを書いた場合、観測は
  // 前ティックと1文字も変わらないまま decision だけが ESCALATE に差し替わる。
  // そこを黙って飛ばすと、隔離が破れたことが PR に一度も出ないまま
  // WAITING_HUMAN になる。人間に届かない関門は鳴っていないのと同じ。
  //
  // 未 commit の関門（`uncommitted_changes`）も同じ性質を持つ。止まっているあいだ
  // 観測は1文字も変わらないので、初回しか書かないと2ティック目以降は PR が静かな
  // まま max_reconciles に当たって BLOCKED になり、止めた理由がどこにも出ない。
  //
  // push が落ちたティックも必ず書く。同じ理由で、観測が変わらないまま push だけ
  // 落ち続ける状態を黙って飛ばすと、PR は静かなまま人間が待ち続ける。
  //
  // 宣言で止めたティックも同じ扱いにする。止まっているあいだ観測は動かないので、
  // 初回しか書かなければ PR は静かなまま人間が待つ。宣言したのは人間だが、
  // 「いま止まっている」を知らせないのは押せなかったときと同じ壊れ方になる。
  if (
    target.previousDigest === target.digest &&
    !stoppedByGuard(target.decision) &&
    pushFailure === null &&
    held === null
  ) {
    return {
      prNumber,
      created,
      commented: false,
      report,
      held,
      skipped: "観測が前のティックと同じ",
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
      skipped: `コメントできなかった: ${errorMessage(error)}`,
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
      skipped: "保護パスの関門が通っていないので push も PR 作成もしない",
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
      skipped: "policies.publish.push_branch: manual の宣言があるので push しない",
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
      skipped: "base との差分が無い",
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
      skipped: "policies.publish.open_pull_request: manual の宣言があるので PR を作らない",
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
 */
const GUARD_REASONS = new Set<string>([...UNPUSHABLE_REASONS, "uncommitted_changes"]);

/** 関門が止めたティックか。通知の必須化が読む */
function stoppedByGuard(decision: Decision): boolean {
  return decision.action.type === "ESCALATE" && GUARD_REASONS.has(decision.action.reason);
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
    `entelecheia の Goal \`${goal.goal.id}\` に対する変更。`,
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
    "進捗は controller がコメントで積む。承認は次の定型文で行う。",
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
      : [`> [!WARNING]`, `> push できなかった: ${oneLine(pushFailure)}`, ""]),
    // 宣言で止めたことも先頭に出す。落ちたのではないので WARNING にはしない。
    // 下の criteria が全部緑でも、その先は人間が進める、という但し書きになる。
    ...(held === null ? [] : [`> [!NOTE]`, `> ${HELD_NOTES[held.step]}`, ""]),
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
      : [
          `Run \`${target.run.id}\`: ${target.run.status}（tokens: ${target.run.tokens ?? 0}）`,
          "",
        ]),
    `<sub>decided_by: ${target.decision.decidedBy} / digest: \`${target.digest.slice(0, 12)}\` / ${now.toISOString()}</sub>`,
  ].join("\n");
}

/** 宣言で止めた段を、PR を読む人間に1行で伝える文面 */
const HELD_NOTES: Record<PublishStep, string> = {
  push_branch:
    "`policies.publish.push_branch: manual` の宣言があるので push していない。" +
    "この PR は、宣言より前に押された分のままになる。",
  open_pull_request:
    "`policies.publish.open_pull_request: manual` の宣言があるので、" +
    "controller は PR を作らない。",
};

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
