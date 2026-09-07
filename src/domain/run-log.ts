import { z } from "zod";

/**
 * Actor の生ログ（`.goals/.state/runs/<run-id>/log.jsonl`）から最終メッセージを読む。
 *
 * **ent 自身が書いた形を読み直すだけの純粋な文字列処理**で、I/O は持たない。
 * ファイルを開くのは Adapter（`src/adapters/review-run.ts`）と、台帳のビューを
 * 配る usecase の2つになる。**読み手が2つに分かれたのでここへ移した。**
 * 後者は合成ルートから Adapter を受け取れない層にあり、Adapter に置いたままでは
 * 同じ解析をもう1つ書くことになる。同じログを2通りに読む実装は、片方だけ
 * provider の出力形式に追随して静かにずれる。
 *
 * 形式は provider ごとに違う。Claude Code は `type: "result"`、Codex は
 * `type: "item.completed"` の `agent_message` に本文を入れる。
 */

/** 生ログの1行。読みたいのは本文だけなので、他のフィールドは見ない */
const resultLineSchema = z.object({
  type: z.literal("result"),
  result: z.string().optional(),
});

const codexAgentMessageSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("agent_message"),
    text: z.string().optional(),
  }),
});

/**
 * JSON Lines から最終メッセージを取り出す。見つからなければ null。
 *
 * 後ろから探す。`type: "result"` は1回の実行に1件だが、壊れた行が混ざっても
 * 最後に確定した本文を採れるようにしておく。JSON として読めない行は飛ばす——
 * ログは追記で書かれるので、末尾が切れた行が残りうる。
 */
export function finalMessageIn(contents: string): string | null {
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const claude = resultLineSchema.safeParse(parsed);
    if (claude.success) {
      return claude.data.result ?? null;
    }
    const codex = codexAgentMessageSchema.safeParse(parsed);
    if (codex.success) {
      return codex.data.item.text ?? null;
    }
  }
  return null;
}
