import { errorMessage } from "../domain/error-message.js";
import {
  type Evidence,
  type Fact,
  type Unresolved,
  type VerifiedFact,
  type VerifyResult,
  verifiedOnly,
} from "../domain/fact.js";
import {
  criterionFactKey,
  LOCAL_HEAD_SHA_KEY,
  REVIEW_REVIEWED_SHA_KEY,
  REVIEW_VERDICT_KEY,
} from "../domain/fact-keys.js";
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

/** 生ログではないので上限を置く。数十MBを SQLite に押し込まない（design.md §4.6） */
const COMMAND_OUTPUT_LIMIT = 2000;

/**
 * 落ちたコマンドの出力を、あとから読める長さで evidence に残す。
 *
 * 通ったときは `exit_code=0` だけにする。全件緑の出力を毎ティック DB に積む
 * 理由が無く、`ent get` を読む側のノイズにもなる。
 *
 * **落ちたときは末尾を残す。** これまで `exit_code=1` しか残しておらず、
 * criteria が一度だけ落ちて次のティックで通った、という揺れを追う手段が
 * 何も無かった（実際に踏んだ。同じ worktree で手で流すと通り、Verification には
 * 終了コードだけが残っていた）。design.md §3.1 は「確かめられなかったことを
 * 黙って落とさない」を中核に置いているが、**確かめた結果が不合格だったときの
 * 中身**は落ちていた。
 *
 * 末尾を採るのは、テストランナーもリンタも失敗の要約を最後に出すため。
 * 先頭から切ると、通ったケースの列挙で埋まる。
 *
 * stderr を先に見て、空なら stdout に落とす。`mise run test` のように失敗の
 * 要約を stdout に出すものがある。
 */
export function describeCommandResult(result: CommandResult): string {
  const head = `exit_code=${result.exitCode}`;
  if (result.exitCode === 0) {
    return head;
  }

  const output = result.stderr.trim() === "" ? result.stdout : result.stderr;
  const trimmed = output.trim();
  if (trimmed === "") {
    return `${head}（出力なし）`;
  }

  const tail =
    trimmed.length <= COMMAND_OUTPUT_LIMIT
      ? trimmed
      : `…（先頭を切った）\n${trimmed.slice(-COMMAND_OUTPUT_LIMIT)}`;
  return `${head}\n${tail}`;
}

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

/**
 * レビューの結論を、読んだ commit ごと突き合わせる。
 *
 * verdict が approved でも、それが3コミット前のコードに対する結論なら、
 * いまの実装は誰も読んでいない。**Fact は消さない。** 観測できたものは
 * 観測できたとおりに残し、完了判定に使えるかどうかはここで決める。
 * いつどの commit を読んだかを後から追えるようにするためで、その代わり
 * 「VERIFIED だが完了判定には使えない Fact」という状態が1つ増える。
 * 読む人間が取り違えないよう、両方の sha を evidence に書く。
 *
 * 突き合わせる相手が観測できていなければ、合否を出さず pending にする。
 * 「確かめられなかった」を「不合格」にすると、観測の穴が実装の不備として
 * PR に出る（design.md §3.1）。
 *
 * この照合を `type: fact` の criterion 全体には広げない。CI の結論のように
 * 「どの commit を読んだか」を持たない観測まで巻き込むと、全部が未検証になる。
 */
function judgeReviewVerdict(
  verdict: VerifiedFact,
  expected: unknown,
  verified: readonly VerifiedFact[],
): Outcome {
  const reviewed = verified.find((f) => f.key === REVIEW_REVIEWED_SHA_KEY);
  const head = verified.find((f) => f.key === LOCAL_HEAD_SHA_KEY);
  if (reviewed === undefined || head === undefined) {
    const missing = reviewed === undefined ? REVIEW_REVIEWED_SHA_KEY : LOCAL_HEAD_SHA_KEY;
    return {
      resolved: false,
      reason: "pending",
      detail: `${REVIEW_VERDICT_KEY} は観測できているが、${missing} が VERIFIED な Fact として観測されていない。どの commit へのレビューかを突き合わせられないので合否を出さない`,
    };
  }

  const current = reviewed.value === head.value;
  const shas = `${REVIEW_REVIEWED_SHA_KEY}=${String(reviewed.value)} ${LOCAL_HEAD_SHA_KEY}=${String(head.value)}`;
  return {
    resolved: true,
    passed: current && verdict.value === expected,
    evidence: {
      source: verdict.evidence.source,
      detail: current
        ? `${REVIEW_VERDICT_KEY}=${JSON.stringify(verdict.value)} expected=${JSON.stringify(expected)}（${shas}: 現在の HEAD へのレビュー）`
        : `${REVIEW_VERDICT_KEY}=${JSON.stringify(verdict.value)} expected=${JSON.stringify(expected)}（${shas}: レビュー後に実装が進んでおり、いまの HEAD は誰も読んでいない）`,
    },
  };
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
          evidence: {
            source: command,
            detail: describeCommandResult(result),
          },
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
      const verified = verifiedOnly(observed);
      const fact = verified.find((f) => f.key === verification.key);
      if (fact === undefined) {
        return {
          resolved: false,
          reason: "pending",
          detail: `${verification.key} が VERIFIED な Fact として観測されていない`,
        };
      }

      // レビューの結論だけは、値のほかに「どの commit を読んだ結論か」を見る。
      if (verification.key === REVIEW_VERDICT_KEY) {
        return judgeReviewVerdict(fact, verification.equals, verified);
      }

      return {
        resolved: true,
        passed: fact.value === verification.equals,
        evidence: {
          source: fact.evidence.source,
          detail: `${verification.key}=${JSON.stringify(fact.value)} expected=${JSON.stringify(verification.equals)}${observedContext(fact)}`,
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

/**
 * 観測が Fact の detail に残した文脈を、判定の detail にも通す。無ければ空文字。
 *
 * verify が `key=value expected=...` を組み立て直すだけだと、observe が書いた文脈が
 * ここで落ちる。**進捗コメントが出すのは criteria の detail だけ**なので、落とすと
 * 人間が読む場所からその文脈が消える。`github.ci.failed_job_count` で言えば、
 * 「落ちている job が1つも無い」と「除外した上で1つも無い」が同じ行になる。
 *
 * 値を言い直しただけの detail は繋がない。observe の detail は大半が
 * `<キーの末尾>=<値>`（`conclusion=success` など）の形で、繋ぐと同じ値が1行に
 * 2回並ぶだけになる。**判定を外したときは繋ぐ側に倒れる。** 重複は読めるが、欠落は読めない。
 */
function observedContext(fact: VerifiedFact): string {
  const detail = fact.evidence.detail;
  const restated = `${fact.key.split(".").at(-1)}=${String(fact.value)}`;
  return detail === "" || detail === restated ? "" : ` / ${detail}`;
}
