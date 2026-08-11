import type { Decision } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import type { ApprovalGate, Goal } from "../domain/goal.js";
import {
  type ActorKind,
  type ActorRole,
  DEFAULT_ACTOR_ROLE,
  type Run,
  type RunIntent,
  type RunOutcome,
} from "../domain/run.js";

/**
 * ACT が依存する外部世界。observe / verify と同じく、実装ではなくインターフェースで切る。
 * 実装コードから直接プロセスを起動したり git を叩いたりしない。
 */

export interface Worktree {
  /** 作業ディレクトリの絶対パス */
  path: string;
  /** その worktree が checkout しているブランチ */
  branch: string;
}

export interface WorktreePort {
  /**
   * Goal 専用の worktree を用意する。同じ name で2回呼んでも同じものを返す。
   * ティックをまたいで同じ作業ツリーを使い続けるため、作り直しにはしない。
   */
  ensure(name: string, baseBranch: string): Promise<Worktree>;
  /**
   * その worktree で実際に変わったパスを、worktree からの相対で返す。
   * 作業ツリーがまだ無ければ空配列。
   *
   * 保護パスの検査（design.md §7 / §10-6）が読む。`Run.artifacts` は Actor の
   * 自己申告で、Bash 経由の書き込みが現れないため、検査の入力としては足りない。
   * commit 済みと未 commit の両方を含める。
   */
  changedPaths(name: string, baseBranch: string): Promise<string[]>;
  /**
   * その worktree の変更を1つの commit にまとめる。**controller が呼ぶ。**
   *
   * 何も commit するものが無ければ false を返す。呼び出し側が「commit した」と
   * 「するものが無かった」を分けられるようにしてある。
   *
   * **「Actor が commit する」という前提を置くのをやめたのでここに来た**
   * （design.md §10-11）。intent に書いてもプロンプトに書いても、従ったことは
   * 確かめられない（§3.2）。実測でも、同じ設定の Actor が commit するティックと
   * しないティックの両方が出た。push が送るのは commit 済みの差分だけなので、
   * commit されないと criteria が全部通っていても remote には1行も出ない。
   *
   * 全部入れる（`add --all`）。Actor がどこを書いたかは呼び出し側が
   * `changedPaths` で既に検査していて、保護パスに触れていればそもそもここへ
   * 来ない。ここで選び直すと、検査した集合と commit する集合がずれる。
   */
  commit(name: string, message: string): Promise<boolean>;
  /**
   * 本体リポジトリ側で汚れているパスと、その中身の指紋を返す。
   * 鍵は**絶対パス**で、worktree 配下は含めない。
   *
   * `changedPaths` は worktree の中で git を回すので、worktree の外に出た書き込みを
   * 1件も観測できない。`Run.artifacts` も SDK の Edit / Write しか拾わないため、
   * Actor が `bash -c 'echo > ../../../../src/controller/index.ts'` と書けば、
   * どちらの入力にも現れなかった。隔離が守るはずの当のファイルが、隔離の
   * 検査から漏れていたことになる。
   *
   * 絶対パスで返すのは、`findViolations` が worktree からの相対に直したときに
   * `..` で始まり、`escaped_worktree` として分類されるようにするため。
   * 指紋を併せて返すのは、controller が ACT の前後を比べるため。パスの集合だけ
   * だと、人間が編集中のファイルを Actor が上書きしても差がゼロになる。
   *
   * これでも repoRoot の外（`~/.zshrc` など）は見えない。git で観測できる範囲が
   * 上限で、そこは design.md §10-6 に残す。
   */
  repoDirtyState(): Promise<Map<string, string>>;
  /**
   * git が観測しない場所の指紋。`.git/hooks/**`、`core.hooksPath`、状態 DB。
   *
   * `repoDirtyState` と分けるのは、あちらが「git が見える汚れ」を意味するため。
   * こちらは git の観測手段では原理的に出てこないものを、別の手段で見る。
   * 実装が用意していなければ controller は検査を飛ばす（省略可）。
   */
  outOfSightState?(): Promise<Map<string, string>>;
}

/**
 * DECIDE が決めた intent に、Goal の宣言部の制約を足す。
 *
 * `src/domain/goal.ts` は `context.constraints` を「ACT にそのまま渡る自由記述」と
 * 宣言しているが、長らく `goal.context` を読むコードがどこにも無く、Actor には
 * 1行も届いていなかった。
 *
 * 届かないことが効くのは `tests/**` の扱いになる。`guard-the-controller.yaml` は
 * 「criteria を確かめる仕組みと確かめる中身は別で、後者まで凍らせると新しい
 * テストを1本足すたびに ESCALATE する」という理由で `tests/**` を
 * `protected_paths` から意図的に外し、代わりに各 Goal の constraints へ
 * 「このテストは仕様なので変更しない」と書いてきた。その行が届かないので、
 * criteria が `mise run test` の Actor は仕様テストを書き換えて通せた。
 * そうして出来た `criteria.<id>.passed` は VERIFIED になり、§3.1 が成立しない。
 *
 * 足す先を intent にしてあるのは、Actor 側のプロンプト組み立てを触らずに済むため。
 * `ActorInvocation.intent` は「そのまま Actor へのプロンプトになる」と決めてある
 * ので、ここで足せば Port の実装がどれでも届く。
 *
 * 制約が無ければ intent をそのまま返す。空の見出しを足さない。
 */
export function withConstraints(intent: string, goal: Goal): string {
  const constraints = goal.context.constraints;
  if (constraints.length === 0) {
    return intent;
  }

  const lines = constraints.map((constraint) => `- ${constraint}`).join("\n");
  return `${intent}\n\n## 守る制約（Goal の宣言部より）\n\n${lines}`;
}

export interface ActorInvocation {
  /**
   * この実行の Run id。生ログを run ごとに分けるために渡す（design.md §4.6）。
   * write-ahead で先に採番済みなので、Actor を起動する時点で必ず決まっている。
   */
  runId: string;
  /**
   * どの Goal の実行か。Actor 側が宣言部（`.goals/<goalId>.yaml`）を名指しするのに使う。
   *
   * レビュー役は「宣言された意図」と差分を突き合わせる。その意図の一次情報は
   * PR 本文ではなく Goal の `desired_state` と `acceptance_criteria` で、
   * `intent` には載っていない（`withConstraints` が足すのは constraints だけ）。
   * 作業ツリーには宣言部が commit 済みで入っているので、**どのファイルを読めば
   * よいかだけを渡せば届く。**
   *
   * ブランチ名（`worktreeBranchFor` が作る `entelecheia/<goalId>`）から引くことも
   * できるが、それだとプロンプトが命名規則に依存する。id は既にここにあるので、
   * 素直に渡す。
   */
  goalId: string;
  /**
   * DECIDE が決めた intent に Goal の制約を足したもの。そのまま Actor への
   * プロンプトになる。組み立ては `withConstraints` が持つ。
   */
  intent: string;
  /**
   * どの役割として起動するか（design.md §4.2）。
   *
   * Actor 側が role によって使ってよいツールを変える。渡っていなければ、
   * レビュー役に「読むだけ」を指示で頼むことになり、Agent が従わなければ
   * 実装を書き換えられる。権限で分けるために、intent とは別に渡す。
   */
  role: ActorRole;
  /** 隔離された作業ツリー。controller 本体のコードとは物理的に分ける（design.md §7） */
  worktree: Worktree;
  /** 人間の承認が要る操作。Actor に実行させてはいけない */
  deniedOperations: readonly ApprovalGate[];
  /** 中断の伝播。SIGTERM を受けたら走行中の Actor を kill する（design.md §3.6） */
  signal: AbortSignal;
}

export interface ActorResult {
  exitCode: number;
  /** 生ログの置き場所。数十MBの文字列を DB に入れない（design.md §4.6） */
  logRef: string;
  /** 使ったトークン。Claude Max 経由でも記録する（design.md §7） */
  tokens: number;
  /** 変更したファイル、作った PR など */
  artifacts: string[];
}

export interface ActorPort {
  kind: ActorKind;
  run(invocation: ActorInvocation): Promise<ActorResult>;
}

/**
 * 副作用の前に意図を書くための口（design.md §3.6 の write-ahead）。
 *
 * 永続化そのものは別 Goal なので、SQLite に書くかどうかはここでは知らない。
 * 実装は呼び出し側が渡す。
 */
export interface RunRecorderPort {
  /** Actor を起動する前に呼ぶ。戻り値は Run の id */
  start(intent: RunIntent): Promise<string>;
  /** 結果が出たら呼ぶ。starting のまま残った Run は次ティックが orphan として回収する */
  finish(runId: string, outcome: RunOutcome): Promise<void>;
}

export interface ActTarget {
  goal: Goal;
  /** DECIDE の結果。action が ACT のときだけ Actor を起動する */
  decision: Decision;
  /** 同じ intent の何回目の試行か。design.md §4.5 の Task.attempts に対応する */
  attempt: number;
  /**
   * worktree を切る元。`GoalState.guardBaseSha`（`ent start` 時点の repoRoot の HEAD）。
   *
   * 関門が差分を取る相手と同じものを渡す。ここだけ `default_branch` にすると、
   * 人間が呼び出し側のブランチに書いた分が worktree に入らないまま関門の基準にだけ
   * 現れる（あるいはその逆になる）。**切った元と比べる相手は同じでなければならない。**
   *
   * 省略と null は `repository.default_branch` に落とす。この記録より前に start した
   * Goal には sha が無く、走行中の worktree を別の commit へ切り直すと
   * それまでの差分が PR から消える。
   */
  base?: string | null;
}

export interface ActDeps {
  worktree: WorktreePort;
  actor: ActorPort;
  runs: RunRecorderPort;
  /** SIGTERM の伝播。渡されなければ中断は起きない */
  signal?: AbortSignal | undefined;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

/**
 * 実行したかどうか。
 *
 * `acted: false` は失敗ではない。ACT 以外の Decision を渡された、
 * あるいは起動前に中断された、という「副作用を出さずに終わった」結果にあたる。
 * Actor が失敗した場合は `acted: true` で Run の status が failed になる。
 */
export type ActResult = { acted: true; run: Run } | { acted: false; reason: string };

/**
 * Decision を Actor の実行に変える。
 *
 * 満たすべき性質:
 * - action が ACT のときだけ Actor を起動する。それ以外は副作用を出さずに理由を返す
 * - 副作用の前に Run(starting) を書く（design.md §3.6 の write-ahead）。
 *   worktree の作成も副作用なので、Run を書けなかったら worktree も作らない
 * - worktree 隔離は必須。作れなかったら Actor を起動しない（design.md §7）。
 *   controller 本体を動かしているコードと Agent が編集するコードを物理的に分ける
 * - worktree の名前は (goal.id, role) から決まる。ティックをまたいで同じ作業ツリーを使う。
 *   role を書かない ACT は実装役として扱い、既存の作業ツリーから動かさない
 * - どの役割として走ったかを Run に残す。write-ahead の starting 側に入れる
 * - `policies.require_human_approval` はそのまま Actor に渡す。
 *   merge や force push を Agent に実行させない
 * - 中断されたら Actor に伝播し、Run を interrupted で確定してから return する。
 *   Ctrl+C が効かない状態を作らない。interrupted は failed とは別の状態にする
 * - どの経路でも throw しない。Actor の失敗も Port の失敗も Run に残して返す
 */
export async function act(target: ActTarget, deps: ActDeps): Promise<ActResult> {
  const action = target.decision.action;
  if (action.type !== "ACT") {
    // 無言で握り潰すと、呼び出し側が「起動したが何も起きなかった」と読む。
    return { acted: false, reason: `action が ${action.type} なので Actor を起動しない` };
  }

  // 起動前に中断されていたら、Run も worktree も作らない。
  // 何も書いていない状態なので、回収すべきものが残らない。
  if (deps.signal?.aborted === true) {
    return { acted: false, reason: "Actor を起動する前に中断された" };
  }

  // role を書いていない Decision は実装役として読む。既に走っている Goal の
  // Decision には role が無いので、ここで別の作業ツリーへ移すと差分が分かれる。
  const role = action.role ?? DEFAULT_ACTOR_ROLE;
  const worktreeName = worktreeNameFor(target.goal.goal.id, role);
  const startedAt = deps.now().toISOString();
  const intent: RunIntent = {
    intent: action.intent,
    actor: deps.actor.kind,
    role,
    worktree: worktreeName,
    attempt: target.attempt,
    startedAt,
  };

  // 副作用の前に意図を書く（design.md §3.6）。worktree の作成も副作用なので、
  // ここが書けなかったら何も作らずに引き返す。
  let runId: string;
  try {
    runId = await deps.runs.start(intent);
  } catch (error) {
    return { acted: false, reason: `Run を書けなかったので起動しない: ${errorMessage(error)}` };
  }

  // ここから先は Run(starting) が残っているので、どの経路でも必ず finish で確定させる。
  const outcome = await runActor(
    target.goal,
    runId,
    action.intent,
    role,
    worktreeName,
    // 切る元は関門の基準と同じものにする。記録が無ければ従来どおり default_branch。
    target.base ?? target.goal.repository.default_branch,
    deps,
  );
  try {
    await deps.runs.finish(runId, outcome);
  } catch (error) {
    // 確定を書けなくても Actor はもう走っている。Run は starting のまま残るので、
    // 次ティックが orphan として回収する。ここで throw すると回収の機会まで失う。
    return {
      acted: true,
      run: {
        ...intent,
        id: runId,
        ...outcome,
        detail: appendDetail(outcome.detail, `Run を確定できなかった: ${errorMessage(error)}`),
      },
    };
  }

  return { acted: true, run: { ...intent, id: runId, ...outcome } };
}

function appendDetail(detail: string | null, added: string): string {
  return detail === null ? added : `${detail} / ${added}`;
}

/**
 * worktree を用意して Actor を起動する。
 *
 * throw しない。失敗も中断も Run の確定値として返し、呼び出し側に finish させる。
 */
async function runActor(
  goal: Goal,
  runId: string,
  intent: string,
  role: ActorRole,
  worktreeName: string,
  base: string,
  deps: ActDeps,
): Promise<RunOutcome> {
  const failed = (detail: string, exitCode: number | null): RunOutcome => ({
    // 中断が原因なら failed にはしない。意図して止めたものを「Actor が失敗した」と
    // 読むと、次ティックが再試行上限を無駄に消費する。
    status: deps.signal?.aborted === true ? "interrupted" : "failed",
    finishedAt: deps.now().toISOString(),
    exitCode,
    logRef: null,
    tokens: null,
    artifacts: [],
    detail,
  });

  let worktree: Worktree;
  try {
    worktree = await deps.worktree.ensure(worktreeName, base);
  } catch (error) {
    // 隔離できていない状態で Agent を走らせると、controller 本体を書き換えうる。
    // 起動しなかったので exit_code は無い。
    return failed(`worktree を用意できなかった: ${errorMessage(error)}`, null);
  }

  try {
    const result = await deps.actor.run({
      runId,
      // 宣言部の置き場所を Actor に名指しさせるために渡す（`ActorInvocation.goalId`）。
      goalId: goal.goal.id,
      intent: withConstraints(intent, goal),
      // 使ってよいツールは Actor 側が role から決める（design.md §4.2）。
      role,
      worktree,
      // merge や force push を Agent に実行させない（design.md §7）。
      deniedOperations: goal.policies.require_human_approval,
      // signal を渡さない呼び出し側でも Actor 側の型を割らないよう、
      // 中断されない signal を代わりに渡す。
      signal: deps.signal ?? NEVER_ABORTED,
    });

    if (result.exitCode === 0) {
      return {
        status: "completed",
        finishedAt: deps.now().toISOString(),
        exitCode: result.exitCode,
        logRef: result.logRef,
        tokens: result.tokens,
        artifacts: [...result.artifacts],
        detail: null,
      };
    }

    return {
      status: deps.signal?.aborted === true ? "interrupted" : "failed",
      finishedAt: deps.now().toISOString(),
      exitCode: result.exitCode,
      logRef: result.logRef,
      tokens: result.tokens,
      artifacts: [...result.artifacts],
      detail: `Actor が exit_code=${result.exitCode} で終了した`,
    };
  } catch (error) {
    return failed(`Actor の実行に失敗した: ${errorMessage(error)}`, null);
  }
}

/**
 * worktree の名前。(goal.id, role) から決まる。
 *
 * 試行ごとに変えない。ティックをまたいで同じ作業ツリーに差分を積み上げ、
 * それがそのまま PR になるため。
 *
 * **`review` は `implement` と同じ作業ツリーを見る。** 当初は役割ごとに分けて
 * いたが、分けると**レビューの対象が実装に永久に追いつかない**。レビュー役の
 * 作業ツリーは base から切られるので実装役の commit が1つも入らず、
 * `review.reviewed_sha`（レビュー役が読んだ HEAD）は base のまま動かない。
 * 一方 `local.head_sha` は実装役の作業ツリーから観測する（`verifyRoot`）ので、
 * Actor が1回 commit した時点で両者は二度と一致しない。「読んだ commit が
 * 実装の HEAD と一致するときだけ結論を使う」という照合（design.md §10-6 /
 * `review.reviewed_sha` の注記）が、常に不一致に倒れることになる。
 * さらに1ティック目は `verifyRoot` が repoRoot に落ちるので、実装が1行も無い
 * 状態でレビュー役が先に走ると、**人間のブランチをレビューした approved が
 * sha 一致で通る**。
 *
 * 分けた当初の理由——レビュー役の checkout や clean で実装側の差分が消える、
 * 実装側が書き換えるとレビューの対象が定まらない——は、**同時に走らせる場合の
 * 話**になる。1ティックで起動する Actor は1体（design.md §5）なので、同じ
 * ティックの中で両者が同じ作業ツリーを触ることはない。残るのは「レビュー役が
 * 破壊的な git を打つ」経路だけで、そこは `src/adapters/claude.ts` の
 * 拒否リストで role ごとに塞ぐ。
 *
 * **`implement` は goal.id のまま据え置く。** 既存の worktree と PR の
 * ブランチは `entelecheia/<goal.id>` にあり、規則を変えると走行中の Goal が
 * 別ブランチに乗り換えて、それまでの差分が PR から消える。`investigate` は
 * 分けたままにする。あちらは Goal の実装とは別のものを調べる役で、
 * 実装の作業ツリーを汚す理由が無い。
 *
 * **第2引数に既定値を置かない。** `verifyRoot`（src/wiring/index.ts）と未 commit の
 * 関門（src/controller/index.ts）は、観測した `local.branch` を
 * `worktreeBranchFor(worktreeNameFor(...))` と突き合わせて「その dirty が
 * どこを観測した値か」を判定している（design.md §10-11）。候補のブランチが
 * 2本ある以上、呼び出し側が「どちらの作業ツリーの話か」を毎回書かなければ、
 * `investigate` の作業ツリーの汚れを実装の書き残しと読んでも型でもテストでも
 * 気づけない。role を書いていない入力に既定を当てるのは、値を読む側
 * （`act`・`Run` を読む controller）の仕事にする（`DEFAULT_ACTOR_ROLE`）。
 *
 * controller も保護パスの検査で同じ作業ツリーを指す必要があるので export する。
 * `src/wiring/index.ts` の `verifyRoot` も含め、規則を2箇所に書くと、検査や検証が
 * 別の作業ツリーを見ていても誰も気づけない。
 */
export function worktreeNameFor(goalId: string, role: ActorRole): string {
  return role === "investigate" ? `${goalId}-${role}` : goalId;
}

/**
 * worktree が checkout するブランチ名。worktree の名前から決まる。
 *
 * 規則の正はここ1箇所にする。WorktreePort の実装（`gitWorktree`）も、
 * 「今の観測がその worktree のものか」を見る controller も、同じ関数を通す。
 * 2箇所に書くと、観測しているのが別の作業ツリーでも誰も気づけない
 * （`worktreeNameFor` を export しているのと同じ理由）。
 */
export function worktreeBranchFor(worktreeName: string): string {
  return `entelecheia/${worktreeName}`;
}

/** signal を渡されなかった呼び出しに使う。中断されることはない */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;
