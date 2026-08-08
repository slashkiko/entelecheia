import type { Fact, VerifyResult } from "../domain/fact.js";
import type { AcceptanceCriterion } from "../domain/goal.js";

/**
 * Verify が依存する外部世界。observe と同じく、実装ではなくインターフェースとして切る。
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunnerPort {
  /** シェルコマンドを実行する。起動そのものに失敗したら throw する */
  run(command: string): Promise<CommandResult>;
}

export interface Approval {
  approvedBy: string;
  approvedAt: string;
}

export interface ApprovalPort {
  /** criterion に対する人間の承認。未承認なら null */
  getApproval(criterionId: string): Promise<Approval | null>;
}

export interface VerifyDeps {
  command: CommandRunnerPort;
  approval: ApprovalPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

export interface VerifyTarget {
  /** 検証コマンドを実行できる状態にする手順。criteria の前に1度だけ流す */
  setup: readonly string[];
  criteria: readonly AcceptanceCriterion[];
  /** OBSERVE の結果。type: fact の criteria がここを参照する */
  facts: readonly Fact[];
}

/**
 * Acceptance Criteria を検証し、結果を VERIFIED な Fact にする。
 *
 * 満たすべき性質:
 * - criteria の結果は `criteria.<id>.passed` として VERIFIED な Fact になる。
 *   true でも false でも「検証できた」ことに変わりはないので、どちらも Fact にする
 * - 「落ちた」と「検証できなかった」を混ぜない。後者は Fact にせず unverified に積む
 * - type: fact は VERIFIED な Fact しか参照しない。INFERRED な Fact しか無いキーは
 *   未検証（pending）であって不合格ではない（design.md §3.1）
 * - setup が失敗したら criteria を1件も実行しない。実行環境が整っていない状態で
 *   出した不合格は「捏造した不合格」になる
 */
export async function verify(_target: VerifyTarget, _deps: VerifyDeps): Promise<VerifyResult> {
  throw new Error("not implemented");
}
