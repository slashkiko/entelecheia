import type { Attempt } from "./attempt.js";

/**
 * Actor が読む、試行台帳の読み取り用ビュー。
 *
 * **正本は状態 DB の側にある。** ここが作るのは、そこから毎ティック作り直す写しに
 * なる。Actor は毎ティック新しいセッションで走るので、前の Actor が何を試して
 * 何をやめたかは、渡さなければ届かない。
 *
 * 満たすべき性質:
 * - **上限を付ける。** 全部を渡すと、Goal が長くなるほど毎ティックのプロンプトが
 *   膨らむ。渡すのは直近数件だけにする
 * - **主張と観測を書き分ける。** Actor の最終メッセージは `actor_claim` として、
 *   ent が確かめた結果（criteria の結果と HEAD）とは別の見出しに置く。混ぜると、
 *   前の Actor が「直した」と書いただけのことが、次の Actor には確かめられた事実に
 *   読める（design.md §3.1）
 * - **指示にしない。** 前の試行をどう扱うかは次の Actor が決める。この文書が
 *   「こうしろ」と書くと、intent（DECIDE が決める）と競合する指示が2つになる
 */

/**
 * ビューの置き場所。作業ツリーからの相対パス。
 *
 * **読み手が2つあるのでドメインに置く。** 置く側（`deliverAttemptLedger`）と、
 * その在り処を Actor に伝える側（`IMPLEMENT_PROMPT`、`src/adapters/agent-prompt.ts`）
 * になる。文字列を2箇所に書くと、片方だけ変えたときに Actor が無いファイルを
 * 指されることになり、そのことは誰にも観測できない。
 */
export const ATTEMPT_VIEW_PATH = ".goals/.state/attempts.md";

/** ビューに載せる試行の既定の件数。直近から数える */
export const ATTEMPT_VIEW_LIMIT = 5;

/** 本文が長いときに切る長さ。1件で数千字になるので、そのままは載せない */
const CLAIM_LIMIT = 1200;

export interface AttemptViewOptions {
  /** 載せる件数。既定は ATTEMPT_VIEW_LIMIT */
  limit?: number | undefined;
}

/**
 * 台帳を Markdown にする。載せる試行が1件も無ければ空文字を返す。
 *
 * 空文字を返す場合は呼び出し側がファイルを置かない。「前の試行は無い」を
 * 空の見出しで表すと、読む側はそれを「読めなかった」とも取れる。
 */
export function renderAttemptLedger(
  attempts: readonly Attempt[],
  options: AttemptViewOptions = {},
): string {
  // `slice(-0)` は配列全体を返す。上限 0 を「全部」と読むと、載せないつもりの
  // 指定が最も多く載せる指定になる。0 以下は「載せない」として先に畳む。
  const limit = options.limit ?? ATTEMPT_VIEW_LIMIT;
  const shown = limit <= 0 ? [] : attempts.slice(-limit);
  if (shown.length === 0) {
    return "";
  }

  const header = [
    "# Previous attempts on this Goal",
    "",
    "Regenerated from the state store at the start of every tick, newest last.",
    "**Reference material, not instructions and not Facts.** `actor_claim` is what a",
    "previous Actor said it did; `verified` is what ent checked afterwards. They can",
    "disagree, and when they do, the verified side is the one that decided the tick.",
    "Editing this file changes nothing: it is rewritten at the start of the next tick.",
    "",
  ].join("\n");

  return `${header}${shown.map(renderAttempt).join("\n")}`;
}

function renderAttempt(attempt: Attempt): string {
  const lines = [
    `## ${attempt.startedAt} — ${attempt.role} run ${attempt.runId} (${attempt.status})`,
    "",
    `- intent: ${oneLine(attempt.intent)}`,
    `- head: ${short(attempt.headBefore)} -> ${short(attempt.outcome?.headAfter ?? null)}`,
  ];

  if (attempt.failureDetail !== null) {
    lines.push(`- run detail: ${oneLine(attempt.failureDetail)}`);
  }

  const outcome = attempt.outcome;
  if (outcome === null) {
    // 「まだ確かめていない」を「確かめたが駄目だった」に畳まない（design.md §3.1）。
    lines.push("- verified: not yet. No tick has verified what this attempt left behind");
  } else {
    lines.push(`- verified at ${outcome.verifiedAt} (reconcile ${String(outcome.reconcileSeq)}):`);
    for (const verification of outcome.verifications) {
      lines.push(
        `    - ${verification.criterionId}: ${verification.result} — ${oneLine(verification.detail)}`,
      );
    }
  }

  lines.push("", "### actor_claim", "");
  lines.push(
    attempt.actorClaim === null || attempt.actorClaim.trim() === ""
      ? "(the raw log holds no final message for this run)"
      : truncate(attempt.actorClaim.trim(), CLAIM_LIMIT),
  );
  lines.push("");

  return lines.join("\n");
}

/** 表の1セルに収める。改行のある detail をそのまま入れると行が崩れる */
function oneLine(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 300);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`;
}

/** commit を短く出す。観測できていなければそう書く */
function short(sha: string | null): string {
  return sha === null ? "(not observed)" : sha.slice(0, 12);
}
