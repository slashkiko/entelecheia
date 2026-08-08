import type { Decision } from "../domain/action.js";
import type { ApprovalGate, Goal } from "../domain/goal.js";
import type { ActorKind, Run, RunIntent, RunOutcome } from "../domain/run.js";

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
}

export interface ActorInvocation {
  /** DECIDE が決めた intent。そのまま Actor へのプロンプトになる */
  intent: string;
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
 * - worktree の名前は goal.id から決まる。ティックをまたいで同じ作業ツリーを使う
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

  const worktreeName = worktreeNameFor(target.goal.goal.id);
  const startedAt = deps.now().toISOString();
  const intent: RunIntent = {
    intent: action.intent,
    actor: deps.actor.kind,
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
  const outcome = await runActor(target.goal, action.intent, worktreeName, deps);
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
  intent: string,
  worktreeName: string,
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
    worktree = await deps.worktree.ensure(worktreeName, goal.repository.default_branch);
  } catch (error) {
    // 隔離できていない状態で Agent を走らせると、controller 本体を書き換えうる。
    // 起動しなかったので exit_code は無い。
    return failed(`worktree を用意できなかった: ${errorMessage(error)}`, null);
  }

  try {
    const result = await deps.actor.run({
      intent,
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
 * worktree の名前。goal.id から決まる。
 *
 * 試行ごとに変えない。ティックをまたいで同じ作業ツリーに差分を積み上げ、
 * それがそのまま PR になるため。
 */
function worktreeNameFor(goalId: string): string {
  return goalId;
}

/** signal を渡されなかった呼び出しに使う。中断されることはない */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
