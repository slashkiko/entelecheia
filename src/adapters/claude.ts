import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ActorPort } from "../act/index.js";
import type { LlmPort } from "../decide/index.js";

/**
 * Claude Code 向けの ActorPort と LlmPort。Claude Agent SDK の query() を使う。
 *
 * design.md §3.5 のとおり ASSESS も DECIDE も Actor 層経由に寄せ、依存を1系統にする。
 * Agent SDK は Claude Code の OAuth をそのまま使うので、Claude Max の枠内で動く。
 */

/**
 * query() の口。テストから注入できるように、こちらで型を切り直してある。
 *
 * 戻り値を `AsyncIterable<unknown>` にしてあるのは、SDK のメッセージ型が広く、
 * テストが本物の型を組み立てるコストに見合わないため。読む項目は Zod で絞る。
 * 実装側は SDK の `query` をそのまま渡せる。
 */
export type AgentQuery = (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;

export interface ClaudeOptions {
  query: AgentQuery;
  /** 生ログの置き場所。run ごとにディレクトリを掘る（design.md §4.6） */
  runsDir: string;
  /** ログをファイルに書く口。テストから差し替える */
  writeLog?: (path: string, contents: string) => Promise<void>;
}

/**
 * Actor を worktree 上で走らせる。
 *
 * 満たすべき性質:
 * - `worktree.path` を cwd にする。controller 本体のコードと物理的に分ける（§7）
 * - `signal` を SDK の abortController に繋ぐ。SIGTERM で即座に落ちる
 * - `deniedOperations` を disallowedTools に落とす。merge や force push を
 *   Agent に実行させない
 * - tokens を必ず記録する。Claude Max 経由でも課金は無いが、
 *   あとから単価をかけて「従量課金だったらいくらか」を出せるようにする（§7）
 * - 生ログはファイルに書き、logRef にはパスだけ返す。数十MBを DB に入れない
 * - 使用量上限に当たったら PortError("usage_limit") を投げる
 */
export function claudeActor(_options: ClaudeOptions): ActorPort {
  throw new Error("not implemented");
}

/**
 * DECIDE の LLM。JSON だけを返させる。
 *
 * 満たすべき性質:
 * - 戻り値は JSON.parse した結果をそのまま返す。Zod 検証は decide が持つので、
 *   ここで整形しない
 * - JSON として読めなければ throw する。壊れた出力を握って空オブジェクトを
 *   返すと、decide が「検証に落ちた」と「呼べなかった」を区別できない
 * - ファイルを触らせない。DECIDE は判断だけで、副作用は ACT が持つ
 * - 使用量上限に当たったら PortError("usage_limit") を投げる
 */
export function claudeLlm(_options: ClaudeOptions): LlmPort {
  throw new Error("not implemented");
}
