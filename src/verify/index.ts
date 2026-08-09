import { errorMessage } from "../domain/error-message.js";
import {
  type Evidence,
  type Fact,
  type Unresolved,
  type VerifyResult,
  verifiedOnly,
} from "../domain/fact.js";
import { criterionFactKey } from "../domain/fact-keys.js";
import type { AcceptanceCriterion } from "../domain/goal.js";
import { isShapeMismatch } from "../domain/port-error.js";

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
export async function verify(target: VerifyTarget, deps: VerifyDeps): Promise<VerifyResult> {
  // 1 回だけ読む。同じ検証に含まれる Fact の observedAt を揃える。
  const verifiedAt = deps.now().toISOString();
  const facts: Fact[] = [];
  const unverified: Unresolved[] = [];

  const setupFailure = await runSetup(target.setup, deps);
  if (setupFailure !== null) {
    // 環境が整っていない状態で出した不合格は捏造した不合格になる。
    // criteria を1件も実行せず、全件を「検証できなかった」として返す。
    for (const criterion of target.criteria) {
      unverified.push({
        key: criterionFactKey(criterion.id),
        reason: "port_failed",
        detail: setupFailure,
      });
    }
    return { verifiedAt, facts, unverified };
  }

  // 逐次実行する。criteria は同じ作業ツリーを触るので、並列にすると結果が混ざる。
  for (const criterion of target.criteria) {
    const key = criterionFactKey(criterion.id);
    const outcome = await judge(criterion, target.facts, deps);
    if (outcome.resolved) {
      facts.push({
        key,
        value: outcome.passed,
        observedAt: verifiedAt,
        confidence: "VERIFIED",
        evidence: outcome.evidence,
      });
    } else {
      unverified.push({ key, reason: outcome.reason, detail: outcome.detail });
    }
  }

  return { verifiedAt, facts, unverified };
}

/**
 * criteria の判定結果。
 *
 * `resolved: true` は「合否を出せた」であって「合格した」ではない。
 * 不合格（`passed: false`）も検証できた結果なので Fact になる。
 */
type Outcome =
  | { resolved: true; passed: boolean; evidence: Evidence }
  | { resolved: false; reason: Unresolved["reason"]; detail: string };

/** setup を順に流す。失敗したら理由を返し、成功したら null を返す */
async function runSetup(setup: readonly string[], deps: VerifyDeps): Promise<string | null> {
  for (const command of setup) {
    try {
      const result = await deps.command.run(command);
      if (result.exitCode !== 0) {
        return `setup が失敗した: ${command} → exit_code=${result.exitCode}`;
      }
    } catch (error) {
      return `setup を実行できなかった: ${command} → ${errorMessage(error)}`;
    }
  }
  return null;
}

async function judge(
  criterion: AcceptanceCriterion,
  observed: readonly Fact[],
  deps: VerifyDeps,
): Promise<Outcome> {
  const verification = criterion.verification;

  switch (verification.type) {
    case "command": {
      const command = verification.run;
      try {
        const result = await deps.command.run(command);
        return {
          resolved: true,
          passed: result.exitCode === 0,
          evidence: { source: command, detail: `exit_code=${result.exitCode}` },
        };
      } catch (error) {
        // 起動できなかったことを不合格にすると、捏造した不合格になる。
        return {
          resolved: false,
          reason: "port_failed",
          detail: `${command} を実行できなかった: ${errorMessage(error)}`,
        };
      }
    }

    case "fact": {
      // 完了判定に使ってよいのは VERIFIED だけ（design.md §3.1）。
      // INFERRED しか無いキーは不合格ではなく、まだ検証できていない。
      const fact = verifiedOnly(observed).find((f) => f.key === verification.key);
      if (fact === undefined) {
        return {
          resolved: false,
          reason: "pending",
          detail: `${verification.key} が VERIFIED な Fact として観測されていない`,
        };
      }
      return {
        resolved: true,
        passed: fact.value === verification.equals,
        evidence: {
          source: fact.evidence.source,
          detail: `${verification.key}=${JSON.stringify(fact.value)} expected=${JSON.stringify(verification.equals)}`,
        },
      };
    }

    case "human": {
      const source = `ApprovalPort.getApproval(${criterion.id})`;
      try {
        const approval = await deps.approval.getApproval(criterion.id);
        if (approval === null) {
          return { resolved: false, reason: "pending", detail: verification.prompt };
        }
        return {
          resolved: true,
          passed: true,
          evidence: {
            source,
            detail: `approved_by=${approval.approvedBy} approved_at=${approval.approvedAt}`,
          },
        };
      } catch (error) {
        // 届いたが読めなかった（shape_mismatch）と、届かなかった（port_failed）を
        // 分ける。observe は例外の種類から作り分けているのに、ここが畳んでいると
        // 承認の経路だけ分類が届かず、guard も止められない。
        //
        // 恒久的な不一致だけを shape_mismatch にする。`unavailable` と素の Error は
        // port_failed のまま——区別できない失敗を恒久扱いにすると、待てば直る
        // 障害で人間を呼ぶことになる。
        return {
          resolved: false,
          reason: isShapeMismatch(error) ? "shape_mismatch" : "port_failed",
          detail: `${source}: ${errorMessage(error)}`,
        };
      }
    }
  }
}
