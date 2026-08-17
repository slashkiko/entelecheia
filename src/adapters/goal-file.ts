import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { errorMessage } from "../domain/error-message.js";
import type { Goal } from "../domain/goal.js";
import { CONFIG_FILENAME, type GoalConfig, parseGoalConfig } from "../domain/goal-config.js";
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

/**
 * Goal YAML を読む。同じディレクトリに `config.yaml` があれば下へ敷く。
 *
 * **ここが唯一の loader になる。** start / run / get / abandon と doctor の
 * `loadGoalSummaries` が全部ここを通るので、混ぜる場所を1つにすれば、どの経路も
 * 同じ実効 Goal を見る。cli.ts に「config を読むかどうか」の分岐を置くと、
 * 混ぜ忘れた経路だけが別の Goal を見ることになる。
 *
 * config が無ければ、これまでと1文字も変わらない。
 */
export function loadGoalFile(path: string): Goal {
  const config = loadGoalConfig(join(dirname(path), CONFIG_FILENAME));
  return parseGoal(readFileSync(path, "utf8"), basename(path, extname(path)), config);
}

/**
 * `.goals/config.yaml` を読む。無ければ null。
 *
 * 落ちたら、どのファイルが悪いのかを名指しして投げ直す。素の zod の文言だけだと
 * `repository.owner` がどちらのファイルの話なのかが読めない。Goal YAML の側は
 * `ent <sub> <slug>` に slug が出ているので名指しの必要が無く、config だけが
 * 「どこにも名前が出ないのに解析に混ざる」形になる。
 */
function loadGoalConfig(path: string): GoalConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseGoalConfig(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is invalid: ${errorMessage(error)}`);
  }
}
