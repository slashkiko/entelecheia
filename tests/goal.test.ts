import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goalSchema } from "../src/domain/goal.js";
import { loadGoalFile, parseGoal } from "../src/domain/goal-loader.js";

const GOALS_DIR = join(import.meta.dirname, "..", ".goals");

function goalFiles(): string[] {
  return readdirSync(GOALS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(GOALS_DIR, f));
}

/** 最小構成。個別のテストは必要な部分だけ差し替える */
const MINIMAL = `
version: 1
goal:
  id: sample-goal
  name: サンプル
  desired_state: |
    何かが完成している。
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
acceptance_criteria:
  - id: ac-1
    description: テストが通る
    verification: { type: command, run: mise run test }
context:
  background: |
    背景。
  constraints:
    - 何かをしない
policies:
  require_human_approval: [merge]
budget:
  max_actor_runs: 10
  max_reconciles: 20
  max_wall_clock: 2h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

describe("goal schema", () => {
  it("リポジトリ内の .goals/*.yaml がすべてスキーマを通る", () => {
    const files = goalFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => loadGoalFile(file), file).not.toThrow();
    }
  });

  it("宣言部だけを持ち、実行時状態は受け付けない", () => {
    // status / lease / source は SQLite 側が持つ（design.md §4.6）。
    // YAML に書けてしまうと reconcile のたびに diff が出て人間の編集履歴が埋もれる。
    const withStatus = MINIMAL.replace("  name: サンプル", "  name: サンプル\n  status: active");
    expect(() => parseGoal(withStatus, "sample-goal")).toThrow();
  });

  it("Acceptance Criteria が空の Goal は登録できない", () => {
    // design.md §3.2「Acceptance Criteria に還元できない Goal は ACTIVE にしない」
    const goal = parseGoal(MINIMAL, "sample-goal");
    expect(() => goalSchema.parse({ ...goal, acceptance_criteria: [] })).toThrow();
  });

  it("fact 検証が参照できるのは実在する観測キーだけ", () => {
    const good = MINIMAL.replace(
      "verification: { type: command, run: mise run test }",
      "verification: { type: fact, key: github.ci.conclusion, equals: success }",
    );
    expect(() => parseGoal(good, "sample-goal")).not.toThrow();

    const typo = MINIMAL.replace(
      "verification: { type: command, run: mise run test }",
      "verification: { type: fact, key: github.ci.conclution, equals: success }",
    );
    expect(() => parseGoal(typo, "sample-goal")).toThrow();
  });

  it("human 検証は承認者への提示文を必須にする", () => {
    const noPrompt = MINIMAL.replace(
      "verification: { type: command, run: mise run test }",
      "verification: { type: human }",
    );
    expect(() => parseGoal(noPrompt, "sample-goal")).toThrow();
  });

  it("goal.id がファイル名の slug と一致しないと弾く", () => {
    expect(() => parseGoal(MINIMAL, "other-slug")).toThrow(/sample-goal/);
  });

  it("require_human_approval は閉じた集合しか受け付けない", () => {
    const unknown = MINIMAL.replace(
      "require_human_approval: [merge]",
      "require_human_approval: [rm_minus_rf]",
    );
    expect(() => parseGoal(unknown, "sample-goal")).toThrow();
  });

  it("max_wall_clock は duration 形式を強制する", () => {
    const bad = MINIMAL.replace("max_wall_clock: 2h", "max_wall_clock: しばらく");
    expect(() => parseGoal(bad, "sample-goal")).toThrow();
  });

  it("setup と references は省略できる", () => {
    const goal = parseGoal(MINIMAL, "sample-goal");
    expect(goal.setup).toEqual([]);
    expect(goal.context.references).toEqual([]);
  });
});
