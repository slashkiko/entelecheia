import {
  type ActorInvocation,
  NOT_OBTAINED,
  PULL_REQUEST_SECTION,
  renderPullRequestText,
} from "../act/index.js";
import type { ActorRole } from "../domain/run.js";

/**
 * Codex Actor に渡す、役割ごとの指示。
 */

/** どの役割でも同じ末尾。承認と公開は controller の側に残す。 */
const COMMON_TAIL = `Do not create PRs and do not post comments. The controller does that, push included.
Writing the approval phrase (/ent approve) is not permitted for any reason.`;

const IMPLEMENT_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

Work only inside the current directory. When you are done, state what you did in one paragraph.

${COMMON_TAIL}`;

/**
 * レビュー役の指示。
 *
 * PR のタイトルと本文は controller が観測して渡す（`renderPullRequestText`）。
 * 資格情報は渡さないままなので、レビュー役が自分で `gh` を叩くことはできない。
 * 「宣言された意図」の一次情報は `.goals/<id>.yaml` のままで、PR の本文は
 * **レビューの対象**として読む。
 */
const REVIEW_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

You are running as the review role. **Do not modify files.**
Only read, and run commands to confirm.

Work only inside the current directory. The steps are as follows.

1. Read .goals/${invocation.goalId}.yaml and the diff, and confirm what must be satisfied
2. Run git rev-parse HEAD to confirm which commit you read
3. Read "${PULL_REQUEST_SECTION}" below. If it was passed down, check
   there whether the constraints in the declaration are reflected in the body. If it was
   not passed down, write "${NOT_OBTAINED}" for that point
4. List the findings heaviest first. You need not write how to fix them, but write why each is a problem
5. Run tests to confirm when needed. Do not write "no problem" about anything you could not confirm
6. Make the last two lines take this form
reviewed_sha: <the 40-hex sha from git rev-parse HEAD>
verdict: approved or verdict: changes_requested

${renderPullRequestText(invocation.pullRequest ?? null)}

${COMMON_TAIL}`;

const INVESTIGATE_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

You are running as the investigate role. **Do not modify files.**

Work only inside the current directory. State what you found and the evidence for it
(the files you read, the commands you ran and their output). Write that you could not
confirm what you could not confirm. Do not fill gaps with guesses.

${COMMON_TAIL}`;

/** 役割ごとのプロンプト */
export const PROMPT_FOR: Record<ActorRole, (invocation: ActorInvocation) => string> = {
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  investigate: INVESTIGATE_PROMPT,
};

export const JSON_ONLY = "Return only a JSON object. No preamble, no explanation.";

/** コードフェンスで囲まれていても読めるようにする */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body === "") {
    throw new Error("The LLM returned an empty output");
  }
  return JSON.parse(body) as unknown;
}
