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
export async function act(_target: ActTarget, _deps: ActDeps): Promise<ActResult> {
  throw new Error("not implemented");
}
