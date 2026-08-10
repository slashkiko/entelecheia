import { parse } from "yaml";
import { type Goal, goalSchema } from "./goal.js";

/**
 * Goal YAML の中身を検証して `Goal` にする。**ファイルは読まない。**
 *
 * design.md §3.2 の「Acceptance Criteria に還元できない Goal は ACTIVE にしない」を
 * 入口で強制するのがこの関数の役目。Zod を通らない YAML は Goal にならない。
 *
 * 読む側は `src/adapters/goal-file.ts` にある。同じファイルに置いていたあいだ、
 * ドメイン層が `node:fs` を呼んでいた。
 */
export function parseGoal(source: string, slug: string): Goal {
  const goal = goalSchema.parse(parse(source));
  if (goal.goal.id !== slug) {
    // ファイル名と id がズレると `ent get <slug>` と YAML の id が食い違い、
    // どちらを正とするかが人間にも controller にも決められなくなる。
    throw new Error(`goal.id (${goal.goal.id}) がファイル名の slug (${slug}) と一致しない`);
  }
  return goal;
}
