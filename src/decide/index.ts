import { type Action, actionSchema, type Decision, type WaitReason } from "../domain/action.js";
import type { Unresolved } from "../domain/fact.js";
import { criterionFactKey } from "../domain/fact-keys.js";
import type { Assessment } from "../domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../domain/goal.js";
import { isUnavailable, isUsageLimit, resumeAfterOf } from "../domain/port-error.js";

/**
 * これまでに使った分。Goal の budget と突き合わせて上限判定に使う。
 * 永続化は別 Goal なので、いまは呼び出し側が組み立てて渡す。
 */
export interface BudgetUsage {
  actorRuns: number;
  reconciles: number;
  consecutiveFailures: number;
  /** Goal を ACTIVE にしてからの経過秒数 */
  elapsedSeconds: number;
}

/**
 * LLM への口。design.md §3.5 のとおり Actor 層経由に寄せ、依存を1系統にする。
 * 実装は Claude Agent SDK になるが、ここでは知らないままにしておく。
 */
export interface LlmPort {
  /** 構造化出力を求める。戻り値は呼び出し側が Zod で検証する */
  chooseAction(prompt: string): Promise<unknown>;
}

export interface DecideDeps {
  llm: LlmPort;
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

export interface DecideTarget {
  /**
   * WAIT の理由を決めるのに要る。「人間の承認待ち」と「CI 待ち」は
   * unresolved の reason だけでは区別できず、criteria の verification 形式で分かれる。
   */
  criteria: readonly AcceptanceCriterion[];
  assessment: Assessment;
  unresolved: readonly Unresolved[];
  budget: Budget;
  usage: BudgetUsage;
}

/** LLM の出力が Zod を通らなかったときの再試行回数（design.md §3.5） */
export const MAX_LLM_RETRIES = 2;

/**
 * 次に取る行動を1つ選ぶ。
 *
 * 満たすべき性質:
 * - 次の3つは LLM を呼ばずに決める（decidedBy: "guard"）
 *     予算・回数・時間の上限に到達      → ESCALATE(budget_exhausted)
 *     Gap が無く unresolved も無い      → COMPLETE
 *     Gap は無いが unresolved がある    → WAIT
 *   COMPLETE を LLM に決めさせないのは、§3.1「完了判定は VERIFIED のみ」を
 *   推論で迂回させないため。予算超過も、暴走の停止条件を LLM に依存させない
 * - guard の判定順は上のとおり。予算超過は他のどの状態よりも優先する
 * - WAIT の reason は unresolved と criteria から決める
 *     port_failed が1件でもある                  → observation_failed
 *     pending だけで、対応する criterion が human → review_pending
 *     pending だけで、それ以外                     → ci_running
 * - それ以外は LlmPort に渡し、戻り値を Zod で検証する。
 *   通らなければ MAX_LLM_RETRIES 回まで再試行し、それでも駄目なら
 *   ESCALATE(invalid_decision)。検証を通らない出力は受け取らない
 * - rationale は必ず埋める。§4.5 の Decision テーブルに残す
 */
export async function decide(target: DecideTarget, deps: DecideDeps): Promise<Decision> {
  // 1 回だけ読む。同じ判断に含まれる時刻を揃える。
  const decidedAt = deps.now().toISOString();
  const guard = (action: Action, rationale: string): Decision => ({
    decidedAt,
    action,
    rationale,
    decidedBy: "guard",
  });

  // 1. 予算超過。暴走の停止条件を LLM の判断に依存させない（design.md §7）ので、
  //    満たしている・満たしていないより先に見る。
  const exhausted = exhaustedBudget(target.budget, target.usage);
  if (exhausted !== null) {
    return guard(
      { type: "ESCALATE", reason: "budget_exhausted" },
      `予算の上限に到達したので停止する: ${exhausted}`,
    );
  }

  // 2. / 3. Gap が無い場合。完了判定は VERIFIED な Fact のみで行う（design.md §3.1）ため、
  //    COMPLETE と WAIT の選び分けは LLM に委ねない。
  //    satisfied ではなく gaps を見るのは、両者がずれた入力を渡されても
  //    「Gap が残っているのに完了」を作らないため。
  if (target.assessment.gaps.length === 0) {
    if (target.unresolved.length === 0) {
      return guard(
        { type: "COMPLETE" },
        "全 criteria が VERIFIED な Fact で満たされ、結論の出ていない対象も無い",
      );
    }

    const reason = waitReason(target);
    return guard(
      { type: "WAIT", reason, resumeAfter: null },
      `Gap は無いが結論の出ていない対象が ${target.unresolved.length} 件ある（${reason}）: ${describeUnresolved(target.unresolved)}`,
    );
  }

  // 4. Gap がある。どう埋めるかは状況依存なので LlmPort に委ねる。
  return await askLlm(target, deps, decidedAt);
}

/**
 * 上限に到達した項目を1つ返す。到達していなければ null。
 *
 * 「到達」を >= で判定する。max_actor_runs: 10 なら 10 回目を終えた時点で止める。
 */
function exhaustedBudget(budget: Budget, usage: BudgetUsage): string | null {
  if (usage.actorRuns >= budget.max_actor_runs) {
    return `actor 実行 ${usage.actorRuns}/${budget.max_actor_runs}`;
  }
  if (usage.reconciles >= budget.max_reconciles) {
    return `reconcile ${usage.reconciles}/${budget.max_reconciles}`;
  }
  if (usage.consecutiveFailures >= budget.max_consecutive_failures) {
    return `連続失敗 ${usage.consecutiveFailures}/${budget.max_consecutive_failures}`;
  }

  const limit = durationSeconds(budget.max_wall_clock);
  if (limit === null) {
    // goalSchema を通っていれば起きない。解釈できない上限を「上限なし」と読むと
    // 停止条件が黙って消えるので、人間を呼ぶ側に倒す。
    return `max_wall_clock を解釈できない: ${budget.max_wall_clock}`;
  }
  if (usage.elapsedSeconds >= limit) {
    return `経過時間 ${usage.elapsedSeconds}s/${budget.max_wall_clock}`;
  }

  return null;
}

/** `30s` / `10m` / `6h` を秒に直す。goalSchema の durationSchema と同じ形式 */
function durationSeconds(duration: string): number | null {
  const matched = /^(\d+)([smh])$/.exec(duration);
  if (matched === null) {
    return null;
  }

  const amount = Number(matched[1]);
  switch (matched[2]) {
    case "s":
      return amount;
    case "m":
      return amount * 60;
    default:
      return amount * 3600;
  }
}

/**
 * 待ちの理由を決める。
 *
 * port_failed を最優先にするのは、観測できていない状態で「承認待ち」と決めつけると
 * 状態を取り違えるため。GitHub が落ちているだけかもしれない。
 */
function waitReason(target: DecideTarget): WaitReason {
  if (target.unresolved.some((u) => u.reason === "port_failed")) {
    return "observation_failed";
  }

  // pending の中身は unresolved の reason だけでは分からない。
  // 人間の承認待ちか CI 待ちかは criteria の verification 形式で分かれる。
  const humanKeys = new Set(
    target.criteria
      .filter((c) => c.verification.type === "human")
      .map((c) => criterionFactKey(c.id)),
  );
  if (target.unresolved.some((u) => humanKeys.has(u.key))) {
    return "review_pending";
  }

  return "ci_running";
}

function describeUnresolved(unresolved: readonly Unresolved[]): string {
  return unresolved.map((u) => `${u.key}(${u.reason}): ${u.detail}`).join(" / ");
}

/**
 * LLM が選んでよい行動。ここに無いものは受け取らない。
 *
 * COMPLETE と ESCALATE を除くのは、収束と停止の判定を推論で迂回させないため。
 * COMPLETE は design.md §3.1 の「完了判定は VERIFIED のみで行う」、
 * ESCALATE は §7 の「暴走の停止条件を LLM の判断に依存させない」にあたる。
 *
 * ESCALATE を最初から閉じていなかったのは、`llmActionSchema` が COMPLETE だけを
 * 弾いていたため。実際に全周させたところ、reconcile の2回目で LLM が
 * `ESCALATE(loop_detected)` を返し、ループしていないのに採用された。
 * `budget_exhausted` も同じ口から入る。どちらも guard が持つべき判断になる。
 *
 * guard 側から `loop_detected` を出す実装はまだ無い（design.md §10-2）。
 * ここで閉じるのは LLM 側の口だけで、§10-2 は未決のまま残る。
 */
const LLM_ACTIONS = new Set(["ACT", "VERIFY", "WAIT", "REPLAN"]);

const llmActionSchema = actionSchema.refine((action) => LLM_ACTIONS.has(action.type), {
  message: `LLM が選べるのは ${[...LLM_ACTIONS].join(" / ")} だけ。COMPLETE と ESCALATE は guard が決める`,
});

/**
 * LlmPort に委ねる。戻り値は必ず Zod で検証し、通らなければ受け取らない（design.md §3.5）。
 * 失敗した理由は次の prompt に載せる。同じ誤りを繰り返させても回数を消費するだけなので。
 */
async function askLlm(
  target: DecideTarget,
  deps: DecideDeps,
  decidedAt: string,
): Promise<Decision> {
  const failures: string[] = [];

  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    let raw: unknown;
    try {
      raw = await deps.llm.chooseAction(buildPrompt(target, failures));
    } catch (error) {
      // 使用量上限だけは名指しで分かる（design.md §10-3）。待てば直るので
      // ESCALATE ではなく WAIT にし、§4.4 の WAITING_EXTERNAL(usage_limit) へ繋ぐ。
      // 再試行しない。上限に当たっている間は何度呼んでも同じで、回数を消費するだけ。
      if (isUsageLimit(error)) {
        return {
          decidedAt,
          action: { type: "WAIT", reason: "usage_limit", resumeAfter: resumeAfterOf(error) },
          rationale: `LlmPort が使用量上限に達した: ${errorMessage(error)}`,
          decidedBy: "guard",
        };
      }
      // Port 自身が失敗したなら、呼び直しても同じ結果になる。未ログイン・
      // 認証切れ・モデル名の誤りはここに来る。再試行の回数を消費させない。
      if (isUnavailable(error)) {
        return {
          decidedAt,
          action: { type: "ESCALATE", reason: "invalid_decision" },
          rationale: `LlmPort が呼べなかった。呼び直しても直らないので再試行しない: ${errorMessage(error)}`,
          decidedBy: "guard",
        };
      }
      // それ以外は、Port が落ちているのか出力が壊れているのかを区別できない。
      // どちらも「採用できなかった試行」として同じ回数制限に載せる。
      failures.push(`LlmPort が失敗した: ${errorMessage(error)}`);
      continue;
    }

    const parsed = llmActionSchema.safeParse(raw);
    if (parsed.success) {
      return {
        decidedAt,
        action: parsed.data,
        rationale: `Gap が ${target.assessment.gaps.length} 件あるので LlmPort に委ね、${describeAction(parsed.data)} を採用した`,
        decidedBy: "llm",
      };
    }

    failures.push(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  // 採用できる出力が出なかった。捏造して進めるより人間を呼ぶ。
  // 判断したのは LLM ではなくこの guard なので decidedBy は "guard" にする。
  return {
    decidedAt,
    action: { type: "ESCALATE", reason: "invalid_decision" },
    rationale: `LlmPort の出力を ${MAX_LLM_RETRIES + 1} 回とも採用できなかった: ${failures.join(" / ")}`,
    decidedBy: "guard",
  };
}

function buildPrompt(target: DecideTarget, failures: readonly string[]): string {
  const criteria = target.criteria
    .map((c) => `- ${c.id} (${c.verification.type}): ${c.description}`)
    .join("\n");
  const gaps = target.assessment.gaps
    .map((g) => `- ${g.criterionId} [${g.kind}] ${g.detail}`)
    .join("\n");
  const unresolved =
    target.unresolved.length === 0 ? "- なし" : `- ${describeUnresolved(target.unresolved)}`;

  const sections = [
    "Goal の Acceptance Criteria に対して埋まっていない差分がある。次に取る行動を1つ選べ。",
    `## Acceptance Criteria\n${criteria}`,
    `## Gap\n${gaps}`,
    `## 結論が出ていない対象\n${unresolved}`,
    `## 予算の残り\n- actor 実行: ${target.usage.actorRuns}/${target.budget.max_actor_runs}\n- reconcile: ${target.usage.reconciles}/${target.budget.max_reconciles}\n- 連続失敗: ${target.usage.consecutiveFailures}/${target.budget.max_consecutive_failures}\n- 経過時間: ${target.usage.elapsedSeconds}s/${target.budget.max_wall_clock}`,
    [
      "## 選べる行動",
      '- {"type":"ACT","intent":"Actor に何をさせるか"} — 実装や修正で Gap を埋める',
      '- {"type":"VERIFY"} — 検証していない criteria を確かめる。kind が unknown の Gap に使う',
      '- {"type":"WAIT","reason":"review_pending|ci_running|usage_limit|observation_failed","resumeAfter":null}',
      '- {"type":"REPLAN"} — いまの進め方では Gap が埋まらない',
      "",
      "COMPLETE と ESCALATE は選べない。完了判定と停止条件は controller が決める。",
      "人間を待つべきだと判断したら WAIT(review_pending) を選ぶ。",
      "JSON オブジェクトだけを返す。",
    ].join("\n"),
  ];

  if (failures.length > 0) {
    sections.push(
      `## 直前の出力が採用されなかった理由\n${failures.map((f) => `- ${f}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "ACT":
      return `ACT(${action.intent})`;
    case "WAIT":
      return `WAIT(${action.reason})`;
    case "ESCALATE":
      return `ESCALATE(${action.reason})`;
    default:
      return action.type;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
