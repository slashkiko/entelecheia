import { describe, expect, it } from "vitest";
import { type Goal, goalTemplate, TEMPLATE_SLUG } from "../src/domain/goal.js";
import { configTemplate, parseGoalConfig } from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import { renderGoal } from "../src/domain/goal-render.js";

/**
 * 書いたものが読み戻せること。
 *
 * `ent plan` が書き出す YAML はここだけが作る。読む側（`parseGoal`）との間に
 * 往復性が無いと、「検証は通ったのにファイルにすると通らない」を作れてしまい、
 * しかもそれは書いた後にしか分からない。
 */

const MINIMAL = `
version: 1
goal:
  id: sample-goal
  name: sample
  desired_state: |
    Something is finished.
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
acceptance_criteria:
  - id: ac-1
    description: the tests pass
    verification: { type: command, run: mise run test }
context:
  background: |
    Why this is being done.
  constraints:
    - do not touch tests
budget:
  max_actor_runs: 10
  max_reconciles: 20
  max_wall_clock: 2h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
policies:
  require_human_approval: [merge]
`;

/**
 * 省略できるキーを書いた版。落とし方と残し方の両方を1本で見る。
 *
 * `policies` は MINIMAL の末尾なので、そのまま同じ深さで足せる。
 */
const FULL = `${MINIMAL}  protected_paths:
    - src/**
  publish:
    push_branch: manual
    open_pull_request: manual
`;

function roundTrip(source: string, slug: string): { before: Goal; after: Goal } {
  const before = parseGoal(source, slug);
  const after = parseGoal(renderGoal(before), slug);
  return { before, after };
}

describe("Goal を YAML に落とす", () => {
  it("最小構成が往復する", () => {
    const { before, after } = roundTrip(MINIMAL, "sample-goal");
    expect(after).toEqual(before);
  });

  it("省略できるキーを書いた構成も往復する", () => {
    const { before, after } = roundTrip(FULL, "sample-goal");
    expect(after).toEqual(before);
    // 書いた分は残る。`policies.publish` はキーの有無で意味が変わる。
    expect(after.policies.publish).toEqual({
      push_branch: "manual",
      open_pull_request: "manual",
    });
  });

  it("`ent init` が置く雛形も往復する", () => {
    // 雛形は人間が読む注釈だらけだが、値としては妥当（`goalTemplate` の JSDoc）。
    // 実際に書き出しうる形の中で最も項目が多いので、往復の対象に入れておく。
    //
    // **妥当と言えるのは config を敷いた後になった。** `repository` と `setup` と
    // `policies` の中身は `.goals/config.yaml` へ移った。init は同じ1周で両方を
    // 置くので、init を叩いた直後の状態で往復を見る。書き出す側（`renderGoal`）は
    // 実効 Goal を丸ごと出すので、読み戻すときに config は要らない。
    const before = parseGoal(
      goalTemplate(TEMPLATE_SLUG),
      TEMPLATE_SLUG,
      parseGoalConfig(
        configTemplate({ owner: "your-org", name: "your-repo", defaultBranch: "main" }),
      ),
    );
    const after = parseGoal(renderGoal(before), TEMPLATE_SLUG);
    expect(after).toEqual(before);
  });

  it("書いていない任意キーは、キーごと落とす", () => {
    // `.default({})` を置かない設計（`src/domain/goal.ts`）と揃える。`null` や `{}` を
    // 書き出すと、書いていないはずの宣言が生えたように読める。
    const body = renderGoal(parseGoal(MINIMAL, "sample-goal"));
    expect(body).not.toContain("publish:");
    expect(body).not.toContain("pull_request:");
    expect(body).not.toContain("ci:");
  });

  it("下限が混ざった保護パスは、混ざったまま書き出される", () => {
    // `protected_paths` はスキーマが `PROTECTED_PATH_FLOOR` を混ぜる。空で書き戻すと
    // 往復しなくなるうえ、宣言だけを読んだ人には保護範囲が空に見える。
    const goal = parseGoal(MINIMAL, "sample-goal");
    const body = renderGoal(goal);
    expect(body).toContain("src/controller/**");
    expect(parseGoal(body, "sample-goal").policies.protected_paths).toEqual(
      goal.policies.protected_paths,
    );
  });

  it("ヘッダのコメントは、読み戻しに影響しない", () => {
    const goal = parseGoal(MINIMAL, "sample-goal");
    const body = renderGoal(goal, "# written by a machine");
    expect(body.startsWith("# written by a machine\n")).toBe(true);
    expect(parseGoal(body, "sample-goal")).toEqual(goal);
  });
});
