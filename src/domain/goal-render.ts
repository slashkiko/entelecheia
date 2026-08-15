import { stringify } from "yaml";
import type { Goal } from "./goal.js";

/**
 * `Goal` を `.goals/<id>.yaml` の中身に落とす。**ファイルは書かない。**
 *
 * 読む側（`parseGoal`）の隣に置く。`ent plan` が書き出す YAML はここだけが作るので、
 * 「書いたものが読み戻せない」を型の外側で起こさないための往復性
 * （`parseGoal(renderGoal(g), g.goal.id)` が `g` に等しい）は、この2つの関数の間の
 * 性質になる。`tests/goal-render.test.ts` がそれを固定する。
 *
 * **キーの並びを Zod の出力任せにしない。** `goalSchema.parse` が返すオブジェクトの
 * キー順は実装依存で、人間が読む YAML の並びをそこに預けると、依存を上げただけで
 * 書き出す順が変わりうる。雛形（`goalTemplate`）と同じ並び——宣言の粒度が粗い順——を
 * ここで明示する。
 *
 * **省略できるキーは、値が無ければキーごと落とす。** `repository.ci` /
 * `repository.pull_request` / `policies.publish` は「書かなければ何も起きない」を
 * キーの有無で表している（`src/domain/goal.ts`）。`null` や `{}` を書き出すと、
 * 書いていないはずの宣言が生えたように読める。
 */
export function renderGoal(goal: Goal, header?: string): string {
  const body = stringify(canonical(goal), {
    // 人間が読む前提の YAML なので、機械的な折り返しで文を割らない。
    lineWidth: 0,
    // `desired_state` と `background` は複数行で書かれる。引用符付きの1行に
    // 畳まれると、雛形が示している形（`|` のブロック）と見た目が変わる。
    blockQuote: "literal",
  });
  return header === undefined ? body : `${header}\n${body}`;
}

/**
 * 書き出す並びと、省略できるキーの落とし方を1箇所に持つ。
 *
 * 戻り値の型を `Goal` にしない。省略したキーを型の上でも「無い」ままにするため。
 */
function canonical(goal: Goal): Record<string, unknown> {
  return {
    version: goal.version,
    goal: {
      id: goal.goal.id,
      name: goal.goal.name,
      desired_state: goal.goal.desired_state,
      depends_on: [...goal.goal.depends_on],
    },
    repository: {
      provider: goal.repository.provider,
      owner: goal.repository.owner,
      name: goal.repository.name,
      default_branch: goal.repository.default_branch,
      ...(goal.repository.ci === undefined
        ? {}
        : { ci: { exclude_workflows: [...goal.repository.ci.exclude_workflows] } }),
      ...(goal.repository.pull_request === undefined
        ? {}
        : { pull_request: { draft: goal.repository.pull_request.draft } }),
    },
    setup: [...goal.setup],
    acceptance_criteria: goal.acceptance_criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verification: { ...criterion.verification },
    })),
    context: {
      background: goal.context.background,
      constraints: [...goal.context.constraints],
      references: goal.context.references.map((reference) => ({ ...reference })),
    },
    policies: {
      require_human_approval: [...goal.policies.require_human_approval],
      protected_paths: [...goal.policies.protected_paths],
      ...(goal.policies.publish === undefined
        ? {}
        : {
            publish: {
              push_branch: goal.policies.publish.push_branch,
              open_pull_request: goal.policies.publish.open_pull_request,
            },
          }),
    },
    budget: {
      max_actor_runs: goal.budget.max_actor_runs,
      max_reconciles: goal.budget.max_reconciles,
      max_wall_clock: goal.budget.max_wall_clock,
      max_consecutive_failures: goal.budget.max_consecutive_failures,
      max_unchanged_reconciles: goal.budget.max_unchanged_reconciles,
      ...(goal.budget.usd === undefined ? {} : { usd: goal.budget.usd }),
    },
  };
}
