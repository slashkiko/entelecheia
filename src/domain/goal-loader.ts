import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse } from "yaml";
import { type Goal, goalSchema } from "./goal.js";

/**
 * `.goals/<slug>.yaml` を読み込んで検証する。
 *
 * design.md §3.2 の「Acceptance Criteria に還元できない Goal は ACTIVE にしない」を
 * 入口で強制するのがこの関数の役目。Zod を通らない YAML は Goal にならない。
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

/** `.goals/foo.yaml` を読んで、ファイル名から slug を取り出して検証する */
export function loadGoalFile(path: string): Goal {
  return parseGoal(readFileSync(path, "utf8"), basename(path, extname(path)));
}
