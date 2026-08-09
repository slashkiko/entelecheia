import type { Decision } from "../domain/action.js";
import type { Goal } from "../domain/goal.js";
import type { Run } from "../domain/run.js";
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

export interface PublishDeps {
  writer: CodeWriterPort;
  branch: BranchPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

export interface PublishResult {
  /** 確保できた PR 番号。作れなかった、あるいは作る段でなければ null */
  prNumber: number | null;
  /** このティックで新しく作ったか */
  created: boolean;
  /** このティックでコメントを書いたか */
  commented: boolean;
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
 */
export async function publish(target: PublishTarget, deps: PublishDeps): Promise<PublishResult> {
  const nothing = (skipped: string): PublishResult => ({
    prNumber: target.prNumber,
    created: false,
    commented: false,
    skipped,
  });

  let prNumber = target.prNumber;
  let created = false;

  try {
    const ensured = await ensurePullRequest(target, deps);
    if (ensured.skipped !== null && prNumber === null) {
      return nothing(ensured.skipped);
    }
    prNumber = ensured.prNumber ?? prNumber;
    created = ensured.created;
  } catch (error) {
    // PR を作れなくても観測と判断は済んでいる。ティック全体は落とさない。
    return nothing(`PR を確保できなかった: ${message(error)}`);
  }

  if (prNumber === null) {
    return nothing("PR がまだ無いのでコメントできない");
  }

  // 同じ状態を毎ティック通知しない。読まれなくなる通知は無いのと同じ。
  if (target.previousDigest === target.digest) {
    return { prNumber, created, commented: false, skipped: "観測が前のティックと同じ" };
  }

  try {
    await deps.writer.addComment(prNumber, commentBody(target, deps.now()));
    return { prNumber, created, commented: true, skipped: null };
  } catch (error) {
    return {
      prNumber,
      created,
      commented: false,
      skipped: `コメントできなかった: ${message(error)}`,
    };
  }
}

/** PR を確保する。既にあればそれを使い、無ければ差分があるときだけ作る */
async function ensurePullRequest(
  target: PublishTarget,
  deps: PublishDeps,
): Promise<{ prNumber: number | null; created: boolean; skipped: string | null }> {
  if (target.prNumber !== null) {
    return { prNumber: target.prNumber, created: false, skipped: null };
  }
  // 制御ループ自体に触れた変更で PR を立てない（design.md §7）。立てると、
  // 保護パスへの変更が通常の変更として流れてしまう。既に PR がある場合は
  // 上で返しているので、コメントで知らせる経路は残る。
  if (
    target.decision.action.type === "ESCALATE" &&
    target.decision.action.reason === "protected_path_touched"
  ) {
    return { prNumber: null, created: false, skipped: "保護パスに触れたので PR を作らない" };
  }
  if (target.run === null || target.run.status !== "completed") {
    // Actor が走っていない、あるいは失敗したティックでは push するものが無い。
    return { prNumber: null, created: false, skipped: "完了した Run が無い" };
  }

  const pushed = await deps.branch.push(target.run.worktree, target.goal.repository.default_branch);
  if (!pushed.pushed) {
    // 空の PR は通知にも検証にも使えない。
    return { prNumber: null, created: false, skipped: "base との差分が無い" };
  }

  // 作る前に必ず探す。2本目を立てるとどちらが正かを決められなくなる。
  const existing = await deps.writer.findPullRequest(pushed.branch);
  if (existing !== null) {
    return { prNumber: existing, created: false, skipped: null };
  }

  const number = await deps.writer.createPullRequest({
    head: pushed.branch,
    base: target.goal.repository.default_branch,
    title: target.goal.goal.name,
    body: pullRequestBody(target.goal),
  });
  return { prNumber: number, created: true, skipped: null };
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
 * 進捗コメント。
 *
 * action と rationale だけでは「何が残っているか」が読めないので、
 * criteria ごとの Verification.result を並べる。
 */
function commentBody(target: PublishTarget, now: Date): string {
  const rows = target.verifications.map(
    (v) => `| \`${v.criterionId}\` | ${MARKERS[v.result]} ${v.result} | ${oneLine(v.detail)} |`,
  );

  return [
    `### ${describeAction(target.decision)}`,
    "",
    target.decision.rationale,
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

/** 表のセルとタイトルに入れる。改行と `|` が混ざると GFM の表が崩れる */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
