import type { ActorInvocation } from "../act/index.js";
import type { ActorRole } from "../domain/run.js";

/**
 * Codex Actor に渡す、役割ごとの指示。
 */

/** どの役割でも同じ末尾。承認と公開は controller の側に残す。 */
const COMMON_TAIL = `PR の作成とコメントの投稿はしない。push も含めて controller が行う。
承認の定型文（/ent approve）を書くことは、どの理由があっても認められない。`;

const IMPLEMENT_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

作業は現在のディレクトリの中だけで行う。終わったら何をしたかを1段落で述べる。

${COMMON_TAIL}`;

const REVIEW_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

あなたはレビュー役として起動している。**ファイルは書き換えない。**
読むことと、コマンドを流して確かめることだけを行う。

作業は現在のディレクトリの中だけで行う。手順は次のとおり。

1. .goals/${invocation.goalId}.yaml と差分を読み、何を満たすべきかを確かめる
2. git rev-parse HEAD で、どの commit を読んだのかを確かめる
3. 指摘を重い順に並べる。直し方まで書く必要は無いが、なぜ問題なのかは書く
4. 必要ならテストを流して確かめる。確かめられなかったことを「問題なし」と書かない
5. 最後の2行を、次の形式にする
reviewed_sha: <git rev-parse HEAD で得た40桁の sha>
verdict: approved または verdict: changes_requested

${COMMON_TAIL}`;

const INVESTIGATE_PROMPT = (invocation: ActorInvocation): string =>
  `${invocation.intent}

あなたは調べる役として起動している。**ファイルは書き換えない。**

作業は現在のディレクトリの中だけで行う。分かったことと、その根拠
（読んだファイル、流したコマンドとその出力）を述べる。確かめられなかったことは、
確かめられなかったと書く。推測で埋めない。

${COMMON_TAIL}`;

/** 役割ごとのプロンプト */
export const PROMPT_FOR: Record<ActorRole, (invocation: ActorInvocation) => string> = {
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  investigate: INVESTIGATE_PROMPT,
};

export const JSON_ONLY = "JSON オブジェクトだけを返す。前置きも説明も付けない。";

/** コードフェンスで囲まれていても読めるようにする */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body === "") {
    throw new Error("LLM が空の出力を返した");
  }
  return JSON.parse(body) as unknown;
}
