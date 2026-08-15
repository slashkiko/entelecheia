import { z } from "zod";
import { describeCycles, findCycles } from "../domain/dependency-graph.js";
import { errorMessage } from "../domain/error-message.js";
import { observedFactKeySchema } from "../domain/fact-keys.js";
import {
  acceptanceCriterionSchema,
  DEFAULT_BUDGET,
  DEFAULT_DECLARED_POLICIES,
  type Goal,
  goalContextSchema,
  goalSchema,
  SLUG,
} from "../domain/goal.js";
import { parseGoal } from "../domain/goal-parse.js";
import { renderGoal } from "../domain/goal-render.js";
import { MAX_LLM_RETRIES } from "../domain/llm-call.js";

/**
 * `ent plan` の本体。散文のゴールを、サブ Goal の宣言に分解する。
 *
 * design.md §10-12 が planner と呼んでいる経路にあたる。あそこが決めているのは
 * 「置き場は Actor ではなく controller 側」「`LlmPort` を1回呼ぶ」「worktree では
 * なく repoRoot の `.goals/*.yaml` に書く」「承認点は人間が `ent start` を打つ瞬間」
 * の4つで、コードは1行も無かった。ここがその1行目になる。
 *
 * **書くのは宣言部だけで、実行時状態には触らない。** 状態 DB も開かない。
 * 書き出した Goal は DRAFT ですらなく、`.goals/` にファイルがあるだけの状態から
 * 始まる（§4.6 の分け方）。走り出すのは人間が `ent start` を打ってからになる。
 *
 * `init` / `doctor` と同じく、外の世界は `PlanProbes` で受け取る。実装を挿すのは
 * 合成ルート（`src/wiring/index.ts`）で、ここは Adapter を知らない。
 */

/**
 * planner が LLM に1問投げる口。
 *
 * **`LlmPort`（`src/decide/index.ts`）を import しない。** Port は使う側が所有する
 * （`Store` と同じ扱い）。DECIDE のそれは「次の行動を1つ選ぶ」ための口で、
 * 名前も含めてあちらの語彙になっている。実装は合成ルートで同じ Adapter に繋ぐ。
 */
export interface PlannerPort {
  /** 構造化出力を求める。戻り値は呼び出し側が Zod で検証する */
  propose(prompt: string): Promise<unknown>;
}

/**
 * 宣言に書く対象リポジトリ。決まらなければ、何を足せば決まるかを `reason` に入れる。
 *
 * **LLM には書かせない。** 書かせると存在しない owner 名を埋め、最初のティックで
 * GitHub の 404 として初めて表面化する（`goalTemplate` が同じ注意を書いている）。
 */
export type RepositoryResolution =
  | { kind: "resolved"; owner: string; name: string; defaultBranch: string }
  | { kind: "unresolved"; reason: string };

/** 既存の宣言1本分。`ent doctor` が読むのと同じ粒度にしてある */
export interface ExistingGoal {
  slug: string;
  /** 読めなかった Goal では空。**「依存を書いていない」とは読まない** */
  dependsOn: readonly string[];
}

/** plan が外に触る口。合成ルートが実装を挿す（`src/wiring/index.ts`） */
export interface PlanProbes {
  planner: PlannerPort;
  /** 宣言に書く対象リポジトリ */
  repository(): RepositoryResolution;
  /** `.goals/` にある既存の宣言。ディレクトリごと無ければ null */
  existingGoals(): readonly ExistingGoal[] | null;
  /**
   * Goal YAML を1本書く。戻り値は人間に見せるパス。
   *
   * **呼ばれるのは全件の検証が通った後だけ。** 途中で落ちる可能性のある処理を
   * ここより前に置いてあるのは、`.goals/` に半分だけ書かれた状態を作らないため。
   */
  writeGoalFile(slug: string, body: string): string;
  now(): Date;
}

export interface PlanRequest {
  /** 分解したいことの散文。`--desire` か `--from` のどちらかで届く */
  desire: string;
  /** 書き出す本数の上限 */
  max: number;
  /** 検証まで済ませて、書かない */
  dryRun: boolean;
  json: boolean;
}

/**
 * 書き出す本数の既定の上限。
 *
 * 検証に通る 30 本が一度に `.goals/` へ落ちる形を作らない。読み切れない量を
 * 人間に渡すのは、渡していないのとあまり変わらない。
 */
export const DEFAULT_MAX_GOALS = 5;

/** `ent plan` が出すもの。`--json` はこれをそのまま出す */
interface PlanReport {
  /** 書いた（`--dry-run` なら書くはずだった）Goal */
  goals: { id: string; path: string; depends_on: string[] }[];
  /** なぜこの分け方にしたか。LLM が書く */
  rationale: string;
  /** `--dry-run` だったか。読む側が「ファイルがある」と読み違えないため */
  dryRun: boolean;
  /** 次に何を叩くか */
  next: string;
}

/**
 * 散文のゴールをサブ Goal に分解して `.goals/` に書く。
 *
 * 満たすべき性質:
 * - **書く前に集合まるごとを検証し、1件でも落ちたら1本も書かない。** 半分だけ
 *   書かれた `.goals/` は、次に叩く人が何を直せばよいのか判断できない（`init` と同じ）
 * - 検証に落ちたら、落ちた内容を添えて `MAX_LLM_RETRIES` 回まで投げ直す。
 *   使い切ったら1本も書かずに 1 で断る
 * - `repository` / `policies` / `budget` は ent が埋める。LLM が書くのは Goal 固有の
 *   部分だけで、関門の入力（`protected_paths` / `require_human_approval`）は渡さない
 * - 既存の `.goals/<id>.yaml` を上書きしない。`--force` も置かない
 * - 実行時状態には触らない。状態 DB を開かず、`ent start` も打たない
 */
export async function planGoals(request: PlanRequest, probes: PlanProbes): Promise<number> {
  const refuse = (message: string): number => {
    // 書いてから気づかせない。何も置かずに、打ち直せる形を添える（gist 2.3）。
    process.stderr.write(`${message}\n`);
    return 1;
  };

  const existing = probes.existingGoals();
  if (existing === null) {
    return refuse(
      ".goals/ does not exist, so there is nowhere to write the plan (run ent init first)",
    );
  }

  const repository = probes.repository();
  if (repository.kind === "unresolved") {
    return refuse(repository.reason);
  }

  const failures: string[] = [];
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    const prompt = buildPlanPrompt(request, existing, failures);

    let raw: unknown;
    try {
      raw = await probes.planner.propose(prompt);
    } catch (error) {
      // 呼べなかったのと、返ってきたものが読めなかったのは別。前者は投げ直しても
      // 直らないことが多いので、その場で理由を出して降りる。
      return refuse(`The planner could not be called: ${errorMessage(error)}`);
    }

    const accepted = accept(raw, request, existing, repository);
    if (typeof accepted === "string") {
      failures.push(accepted);
      continue;
    }

    return emit(accepted, request, probes);
  }

  return refuse(
    `None of the ${String(MAX_LLM_RETRIES + 1)} planner outputs could be adopted, so nothing was written: ` +
      failures.join(" / "),
  );
}

/**
 * LLM に書かせる形。**Goal 固有の部分だけ**を並べる。
 *
 * `version` / `repository` / `policies` / `budget` はここに無い。ent が埋めるので、
 * 書ける形にしておくと「書いてよいのだ」と読ませることになる。
 */
const proposalSchema = z.strictObject({
  /** なぜこの分け方にしたか。人間が最初に読む1段落 */
  rationale: z.string().min(1),
  goals: z
    .array(
      z.strictObject({
        id: z.string().regex(SLUG, "id must be kebab-case"),
        name: z.string().min(1),
        desired_state: z.string().min(1),
        depends_on: z
          .array(z.string().regex(SLUG, "depends_on entries must be kebab-case ids"))
          .default([]),
        setup: z.array(z.string().min(1)).default([]),
        acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
        context: goalContextSchema,
      }),
    )
    .min(1),
});

/** 採用できた分解。書き出す直前の形になる */
interface AcceptedPlan {
  rationale: string;
  goals: { goal: Goal; body: string }[];
}

/**
 * 返ってきたものを検証する。採用できれば書き出す形、駄目なら**理由の文字列**を返す。
 *
 * 理由をそのまま次のプロンプトに載せるので、機械可読な形にはしない。
 * 直せる文にしておかないと、投げ直しても同じものが返る。
 */
function accept(
  raw: unknown,
  request: PlanRequest,
  existing: readonly ExistingGoal[],
  repository: Extract<RepositoryResolution, { kind: "resolved" }>,
): AcceptedPlan | string {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    return `the output did not match the required shape: ${z.prettifyError(parsed.error)}`;
  }
  const proposal = parsed.data;

  if (proposal.goals.length > request.max) {
    return `${String(proposal.goals.length)} Goals were proposed, but at most ${String(request.max)} are accepted (raise --max, or split more coarsely)`;
  }

  // id の重複。集合の中と、既に `.goals/` にあるものの両方を見る。
  const proposedIds = proposal.goals.map((goal) => goal.id);
  const duplicated = proposedIds.filter((id, index) => proposedIds.indexOf(id) !== index);
  if (duplicated.length > 0) {
    return `the same id was proposed twice: ${[...new Set(duplicated)].join(", ")}`;
  }

  const declared = new Set(existing.map((goal) => goal.slug));
  const taken = proposedIds.filter((id) => declared.has(id));
  if (taken.length > 0) {
    // 上書きしない。人間が書いた宣言部を消す経路を、ここに作らない。
    return `.goals/<id>.yaml already exists for: ${taken.join(", ")} (choose different ids; existing declarations are never overwritten)`;
  }

  // 依存の不在。実行時には「まだ start されていない」と見分けが付かず、
  // どの停止条件にも当たらないまま待ち続ける（design.md §10-12）。
  const known = new Set([...declared, ...proposedIds]);
  const missing = proposal.goals
    .map((goal) => ({ id: goal.id, absent: goal.depends_on.filter((dep) => !known.has(dep)) }))
    .filter((entry) => entry.absent.length > 0);
  if (missing.length > 0) {
    return (
      "depends_on points at ids that do not exist: " +
      missing.map((entry) => `${entry.id} → ${entry.absent.join(", ")}`).join(" / ")
    );
  }

  // 循環。既存の宣言が持つ辺も混ぜる。新しく書く id を、既にある Goal が
  // 先回りして depends_on に書いている（doctor が「不在」と鳴らしていた）場合、
  // 集合の中だけを見ると輪が閉じたことに気づけない。
  const edges = new Map<string, string[]>([
    ...existing.map((goal): [string, string[]] => [
      goal.slug,
      goal.dependsOn.filter((dep) => known.has(dep)),
    ]),
    ...proposal.goals.map((goal): [string, string[]] => [goal.id, [...goal.depends_on]]),
  ]);
  const cycles = findCycles(edges);
  if (cycles.length > 0) {
    return `depends_on forms a cycle: ${describeCycles(cycles)} (every Goal in a closed cycle waits for its dependency, so none of them progresses)`;
  }

  // ここまで通ってから、宣言としての妥当性を見る。ent が埋める側を足して
  // `goalSchema` を通し、書き出す文字列に落として、**読み戻せることまで**確かめる。
  const goals: AcceptedPlan["goals"] = [];
  for (const proposed of proposal.goals) {
    const goal = goalSchema.safeParse({
      version: 1,
      goal: {
        id: proposed.id,
        name: proposed.name,
        desired_state: proposed.desired_state,
        depends_on: proposed.depends_on,
      },
      repository: {
        provider: "github",
        owner: repository.owner,
        name: repository.name,
        default_branch: repository.defaultBranch,
      },
      setup: proposed.setup,
      acceptance_criteria: proposed.acceptance_criteria,
      context: proposed.context,
      policies: DEFAULT_DECLARED_POLICIES,
      budget: DEFAULT_BUDGET,
    });
    if (!goal.success) {
      return `${proposed.id} is not a valid Goal declaration: ${z.prettifyError(goal.error)}`;
    }

    const body = renderGoal(goal.data, planHeader());
    try {
      // 書いたものが読み戻せることを、書く前に確かめる。往復性は
      // `renderGoal` と `parseGoal` の間の性質で、テストでも固定してある。
      parseGoal(body, proposed.id);
    } catch (error) {
      return `${proposed.id} rendered to YAML that ent cannot read back: ${errorMessage(error)}`;
    }
    goals.push({ goal: goal.data, body });
  }

  return { rationale: proposal.rationale, goals };
}

/** 検証を全部通った集合を書き出す。`--dry-run` なら書かずに同じ報告だけ出す */
function emit(accepted: AcceptedPlan, request: PlanRequest, probes: PlanProbes): number {
  const goals = accepted.goals.map(({ goal, body }) => ({
    id: goal.goal.id,
    // dry-run でもパスを出す。「どこに書かれるか」を読んでから走らせられる。
    path: request.dryRun ? `.goals/${goal.goal.id}.yaml` : probes.writeGoalFile(goal.goal.id, body),
    depends_on: [...goal.goal.depends_on],
  }));

  const report: PlanReport = {
    goals,
    rationale: accepted.rationale,
    dryRun: request.dryRun,
    next: nextStep(goals, request.dryRun),
  };

  process.stdout.write(
    request.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${goals
          .map(
            (goal) =>
              `${request.dryRun ? "would write" : "wrote"}  ${goal.path}` +
              (goal.depends_on.length === 0 ? "" : `  (after ${goal.depends_on.join(", ")})`),
          )
          .join("\n")}\n\n${report.rationale}\n\n${report.next}\n`,
  );

  if (request.dryRun) {
    // 検証まで済ませたが1本も書いていない。本文にも出すが、`--dry-run` を
    // 付けたことを忘れて `ent start` を叩く経路があるので、stderr にも残す。
    process.stderr.write("--dry-run was set, so nothing was written\n");
  }
  return 0;
}

/**
 * 次に何を叩くか。**依存を持たない Goal を名指しする。**
 *
 * 依存が残っている Goal を先に start しても、`dependencyGate` が入口で返すだけで
 * lease も取らない（design.md §10-12）。名前を挙げる先を間違えると、その1本を
 * 叩いた人には「何も起きなかった」ようにしか見えない。
 */
function nextStep(goals: readonly { id: string; depends_on: string[] }[], dryRun: boolean): string {
  if (dryRun) {
    return "Nothing was written. Run the same command without --dry-run to write these declarations";
  }
  const roots = goals.filter((goal) => goal.depends_on.length === 0).map((goal) => goal.id);
  return (
    "Read the declarations, delete the ones you do not want, then run ent doctor and " +
    `ent start ${roots.join(" / ")}` +
    ". The rest wait on their dependencies, so they can be started at any time"
  );
}

/**
 * 書き出す YAML の先頭に置くコメント。
 *
 * **機械が書いたことを、ファイル自身に書いておく。** `.goals/*.yaml` は §4.6 が
 * 「人間が編集する宣言部」と決めている場所で、そこに機械の書いたものが混ざる。
 * 後から読む人が、どちらが書いたのかをファイルだけで判別できるようにする。
 * 承認点は変わらず `ent start` なので、それもここに書く（§3.2）。
 */
function planHeader(): string {
  return `# Written by ent plan. Review it before running ent start — typing that command
# is the approval point, and nothing runs until you do (design.md §3.2).
# Edit anything here freely; this file is an ordinary Goal declaration.`;
}

/**
 * planner に渡すプロンプト。
 *
 * **英語で書く。** LLM に渡す文面はすべて英語に寄せてある（`src/adapters/agent-prompt.ts`
 * と同じ扱い）。書かせる `desired_state` と criteria の本文も英語にさせる。
 *
 * **観測キーを列挙して渡す。** `type: fact` の criterion に実在しないキーを書かれると
 * `goalSchema` で落ちるが、キーの一覧はコード側（`observedFactKeySchema`）にしか無く、
 * Goal YAML からは読み取れない。渡さないと当てられず、再試行を丸ごと使い切る。
 */
export function buildPlanPrompt(
  request: PlanRequest,
  existing: readonly ExistingGoal[],
  failures: readonly string[],
): string {
  const existingIds = existing.map((goal) => goal.slug);
  return [
    "You split one coarse objective into sub-Goals for ent, a controller that converges a declared",
    "end state. Each sub-Goal gets its own worktree and its own pull request, so split only where the",
    "split is real: a unit that can be implemented, verified, and reviewed on its own.",
    "",
    "## What to split",
    "",
    request.desire,
    "",
    "## Rules",
    "",
    `- Emit between 1 and ${String(request.max)} Goals. Fewer is better when the work does not truly split.`,
    "- Declare ordering with depends_on. A Goal does not start until every id it lists is COMPLETED.",
    "  Leave depends_on empty for the ones that can start immediately.",
    "- ids are kebab-case and become the filename. They must not collide with the ids listed below.",
    "- desired_state describes the finished state, not the steps. It is the text the Actor reads.",
    "- Every Goal needs at least one acceptance criterion, and a Goal that cannot be reduced to",
    "  criteria must not be emitted (design.md §3.2). Verification is one of:",
    '    { "type": "command", "run": "<shell command; a non-zero exit means failed>" }',
    '    { "type": "fact", "key": "<one of the observed keys below>", "equals": <string|number|boolean> }',
    '    { "type": "human", "prompt": "<what the approver must confirm>" }',
    "- Prefer command verification. It is the only kind the Actor can satisfy on its own.",
    "- context.background is why this is being done; context.constraints lists what must not be touched.",
    '- context.references is a list of { "title": "...", "path": "..." } and nothing else.',
    "  path is a path inside the repository. **URLs are not accepted** — the Actor often cannot open",
    "  them, and a reference it silently skips is worse than none. Leave it [] unless you are naming a",
    "  path you are sure exists.",
    "- setup lists shell commands run once before verification. Leave it [] when nothing is needed.",
    "- Write every field in English.",
    "",
    "## Observed fact keys (the only values allowed for type: fact)",
    "",
    observedFactKeySchema.options.join(", "),
    "",
    "## ids already declared in .goals/ (do not reuse; you may depend on them)",
    "",
    existingIds.length === 0 ? "(none)" : existingIds.join(", "),
    "",
    "## Output",
    "",
    "Return one JSON object:",
    '{ "rationale": "<why this split, in one paragraph>",',
    '  "goals": [ { "id": "...", "name": "...", "desired_state": "...", "depends_on": [],',
    '              "setup": [], "acceptance_criteria": [ { "id": "ac-1", "description": "...",',
    '              "verification": { ... } } ],',
    '              "context": { "background": "...", "constraints": ["..."], "references": [] } } ] }',
    "",
    "Do not write repository, policies, or budget. ent fills those in.",
    "Every key above is required and no other key is accepted; an extra key rejects the whole set.",
    ...(failures.length === 0
      ? []
      : [
          "",
          "## Your previous attempt(s) were rejected",
          "",
          ...failures.map((failure, index) => `${String(index + 1)}. ${failure}`),
          "",
          "Fix these and return the whole set again.",
        ]),
  ].join("\n");
}
