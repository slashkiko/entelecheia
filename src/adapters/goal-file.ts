import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Goal } from "../domain/goal.js";
import { parseGoal } from "../domain/goal-parse.js";

/**
 * `.goals/<slug>.yaml` をファイルシステムから読む Adapter。
 *
 * 検証そのものは `parseGoal`（`src/domain/goal-parse.ts`）が持つ。ここが持つのは
 * 「ファイルを読む」と「ファイル名から slug を決める」の2つだけになる。
 *
 * かつては読む側も domain に置いていた。`tests/architecture.test.ts` が見るのは
 * 相対 import だけなので `node:fs` は素通りし、ドメイン層がファイルシステムに
 * 触っていることは機械では分からなかった。いまはドメインが使ってよい Node 組み込みも
 * 許可リストで固定してある。
 */
export function loadGoalFile(path: string): Goal {
  return parseGoal(readFileSync(path, "utf8"), basename(path, extname(path)));
}
