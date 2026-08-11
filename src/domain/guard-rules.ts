import type { Action, Decision } from "./action.js";
import type { Fact } from "./fact.js";
import type { Goal } from "./goal.js";
import type { GoalState } from "./goal-state.js";
import { type GoalStatus, isTerminal } from "./goal-state.js";
import type { Run } from "./run.js";
import type { Verification } from "./verification.js";

/**
 * guard が読む判断規則。**依存を1つも持たない**（design.md §7）。
 *
 * design.md §7 の境界は「完了判定と暴走の停止条件を LLM に決めさせない」で、
 * 決めるのは純ロジックの guard になる。その guard が実際に読む規則が
 * `src/controller/index.ts` の中に散らばっていた。Port も時計も DB も要らない
 * 関数がオーケストレータに同居していると、規則を確かめるのにティック全体を
 * 組み立てることになり、規則そのものをテストで固定しづらい。
 *
 * **1つのファイルに集めるのは、保護の単位と一致させるため。** ここに並ぶのは
 * どれも `PROTECTED_PATH_FLOOR` の基準——書き換えられると関門そのものが
 * 働かなくなるもの——に当たる。`guardBaseOf` を書き換えれば関門は毎ティック
 * 空の差分を見るし、`claimsNothingLeft` を書き換えれば未 commit の関門が
 * 一度も鳴らない。`elapsedSecondsSince` は `max_wall_clock` の停止条件そのもの。
 *
 * 語彙ごとに `action.ts` / `fact.ts` / `goal-state.ts` へ配ると、下限はファイル
 * リテラルなので4本を個別に足すことになり、しかもそれらは Goal が正当に触りうる
 * 語彙（Fact のキーを増やす等）と同じファイルになる。**下限は最小に保つ**
 * （`src/domain/goal.ts` の `PROTECTED_PATH_FLOOR`）ので、保護したいものだけを
 * 1本にまとめて、その1本を下限に入れる。
 */

/** 関門の基準として受け付ける形。git の commit id そのもの */
const SHA = /^[0-9a-f]{40}$/;

/**
 * 関門が差分を取る相手。解決できなければ null。
 *
 * `ent start` を叩いた時点の repoRoot の HEAD（`GoalState.guardBaseSha`）を使う。
 * 関門が答えたい問いは「Actor が何を書いたか」で、`repository.default_branch` が
 * 答えるのは「リリース先との差は何か」になる。後者を前者に流用すると、人間が
 * 呼び出し側のブランチに書いたもの——Goal の宣言（`.goals/*.yaml`）を含む——まで
 * Actor の編集として並ぶ。`.goals/**` は `PROTECTED_PATH_FLOOR` にあるので、
 * 宣言を1本置いただけで毎ティック `protected_path_touched` になっていた。
 *
 * 記録が無ければ `default_branch` に落とす。この列より前に start した Goal の
 * worktree は既に default_branch から切られていて、基準だけを別の commit に
 * 変えると、それまで通っていた差分が別の基準で並び直す。
 *
 * **記録があるなら形まで確かめる。** 状態 DB は gitignore 済みで、本体側の
 * 汚れの観測（`repoDirtyState`）には出ない。ここを検証しないまま読むと、
 * リテラル `HEAD` を1回書き込むだけで毎ティック `diff HEAD...HEAD` が空を返し、
 * 関門が恒久的に黙る。`gitDiffAgainst` の catch は解決**できなかった**ときしか
 * 効かないので、この経路は握り潰しではなく fail-open になる。
 *
 * 外れたら `default_branch` に落とさない。落とすと「基準が壊れている」が
 * 「既定で回っている」に化ける。確かめられなかったことは確かめられなかったと
 * して扱う（design.md §3.1）ので、呼び出し側が `guard_unavailable` に倒す。
 */
export function guardBaseOf(goal: Goal, state: GoalState): string | null {
  if (state.guardBaseSha === null) {
    return goal.repository.default_branch;
  }
  return SHA.test(state.guardBaseSha) ? state.guardBaseSha : null;
}

/**
 * 「あとは人間か外部の番だ」と言い切る Decision か。
 *
 * COMPLETE はそのまま終端になり、WAIT は次のティックまで機械側が何もしない。
 * どちらも「機械側にやることは残っていない」を意味するので、同じ関門で見る。
 */
export function claimsNothingLeft(decision: Decision): boolean {
  const action = decision.action;
  if (action.type === "COMPLETE") {
    return true;
  }
  if (action.type !== "WAIT") {
    return false;
  }
  // guard が出す WAIT(usage_limit) だけは意味が違う。LlmPort が上限に当たって
  // 判断を保留しただけで、Gap は残っているかもしれない（design.md §10-3）。
  return !(decision.decidedBy === "guard" && action.reason === "usage_limit");
}

/** 差し替えなければ何になっていたかを、人間が読む形にする */
export function describeClaim(action: Action): string {
  switch (action.type) {
    case "COMPLETE":
      return "COMPLETE にすると";
    case "WAIT":
      return `WAIT(${action.reason}) で待つと`;
    default:
      return `${action.type} にすると`;
  }
}

/**
 * 今ティックの観測が、そのキーをその値で確かめたか。
 *
 * Fact が無い（観測できなかった）を false に畳んでよいのは、呼び出し側が
 * 「確かめられたときだけ止める」側に倒しているため。確かめられなかったティックは
 * Fact が欠けるので criteria も揃わず、止めるべき COMPLETE には届かない。
 */
export function observedValue(facts: readonly Fact[], key: string, value: unknown): boolean {
  const fact = facts.find((f) => f.key === key);
  return fact !== undefined && fact.confidence === "VERIFIED" && fact.value === value;
}

/**
 * まだ寝ているなら、その時刻を返す。起きてよければ null。
 *
 * 解釈できない値は「起きてよい」と読む。resume_after が壊れているせいで
 * Goal が永久に止まる方が、1ティック早く起きるより悪い。
 */
export function sleepingUntil(resumeAfter: string | null, now: Date): string | null {
  if (resumeAfter === null) {
    return null;
  }
  const at = Date.parse(resumeAfter);
  if (Number.isNaN(at) || at <= now.getTime()) {
    return null;
  }
  return resumeAfter;
}

/**
 * ACTIVE になってからの経過秒数。max_wall_clock の判定に使う。
 *
 * 解釈できない値は Infinity にして上限側へ倒す。0 にすると、activated_at が
 * 壊れた Goal だけ経過時間の上限が黙って効かなくなる。
 * ダイジェストの計算はここには無い。`src/domain/digest.ts` が正で、
 * ループ検知が使う値と記録する値を1箇所に保つ。
 */
export function elapsedSecondsSince(activatedAt: string | null, now: Date): number {
  if (activatedAt === null) {
    // まだ ACTIVE になっていない。経過時間はゼロで正しい。
    return 0;
  }
  const parsed = Date.parse(activatedAt);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}

/**
 * 末尾から連続する failed の数。`max_consecutive_failures` の判定に使う。
 *
 * 間に成功が挟まれば連続は切れる。累計の失敗数を使うと、成功を挟みながら
 * 進んでいる Goal も、いずれ必ず上限に当たって止まる。
 */
export function consecutiveFailuresOf(runs: readonly Run[]): number {
  let count = 0;
  for (const run of [...runs].reverse()) {
    if (run.status !== "failed") {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * 依存する Goal が揃っているか（design.md §10-12）。
 *
 * 分解した1本ごとに Goal を立てる方針を採ったので、順序の判定はここに来る。
 * 純ロジックにしてあるのは、これが**停止条件**だから。「先に進んでよいか」を
 * LLM に決めさせない境界（§7）の内側にある。
 *
 * 3値に分けるのは §3.1 と同じ理由になる。「まだ終わっていない」と
 * 「もう終わらない」を1つに畳むと、待っても解けない待ちを永久に待つ。
 *
 * - `pending`     — まだ COMPLETED でない。待てば進む可能性がある。
 *                   **登録されていない依存もここに入れる。** `ent start` を
 *                   打ち忘れただけかもしれないので、無いことを「もう終わらない」
 *                   とは読まない
 * - `unreachable` — 終端に落ちたが COMPLETED ではない（FAILED / ABANDONED）。
 *                   待っても解けないので、待ち側は人間を呼ぶ側に倒す
 */
export interface DependencyGate {
  /** 依存がすべて COMPLETED なら true。depends_on が空なら常に true */
  ready: boolean;
  /** COMPLETED になっていない依存。宣言順を保つ */
  pending: string[];
  /** 終端だが COMPLETED ではない依存。宣言順を保つ */
  unreachable: string[];
}

/**
 * `statusOf` は「登録されていない」を null で返す。Store を引く側の都合を
 * ここに持ち込まないための引数で、この関数自体は DB も時計も知らない。
 */
export function dependencyGate(
  dependsOn: readonly string[],
  statusOf: (goalId: string) => GoalStatus | null,
): DependencyGate {
  const pending: string[] = [];
  const unreachable: string[] = [];

  for (const id of dependsOn) {
    const status = statusOf(id);
    if (status === "COMPLETED") {
      continue;
    }
    if (status !== null && isTerminal(status)) {
      unreachable.push(id);
      continue;
    }
    pending.push(id);
  }

  return { ready: pending.length === 0 && unreachable.length === 0, pending, unreachable };
}

/**
 * なぜ進めないかの1行。人間に届く唯一の説明になるので、次の一手まで書く。
 *
 * 揃っているときに呼ぶと null。呼び出し側が「進めない理由」としてしか使わない
 * ことを、戻り値の型で示しておく。
 */
export function describeDependencyGate(gate: DependencyGate): string | null {
  if (gate.ready) {
    return null;
  }
  const parts: string[] = [];
  if (gate.unreachable.length > 0) {
    parts.push(
      `依存が終端に落ちている（${gate.unreachable.join(", ")}）。待っても解けないので、` +
        "依存側をやり直すか depends_on を書き換える",
    );
  }
  if (gate.pending.length > 0) {
    parts.push(`依存の完了待ち（${gate.pending.join(", ")}）`);
  }
  return parts.join("。");
}

/**
 * 機械だけで確かめられる criteria が、このティックで全部通ったか。
 *
 * controller が Actor の書いたものを commit してよいかの判定になる
 * （design.md §10-11）。**「Actor が commit する」という前提を置くのをやめた。**
 * intent に書いても、プロンプトに書いても、従ったことは確かめられない（§3.2）。
 * 実測でも、同じ設定・同じモデルの Actor が commit するティックとしないティックの
 * 両方が出た。確かめられるのは controller 側の観測だけなので、判断もそちらに置く。
 *
 * **見るのは `command` 型の criteria だけにする。** `fact` 型には
 * `github.ci.conclusion` のように push されて初めて決まるものがあり、
 * それを commit の前提にすると「commit しないと CI が回らず、CI が通らないと
 * commit しない」で閉じる。`human` 型は定義上ここでは決まらない。
 *
 * **1本も無ければ false。** 機械側で確かめたものが1つも無いのに commit すると、
 * Actor が書いただけのものが commit 済みとして push される。criteria を
 * 検証手段に落とすことを入口で強制している（§3.2）以上、`command` 型が
 * 1本も無い Goal は「機械側では確かめない」と宣言しているのと同じになる。
 */
export function machineCriteriaSatisfied(
  criteria: readonly { id: string; verification: { type: string } }[],
  verifications: readonly Verification[],
): boolean {
  const byCriterion = new Map(verifications.map((v) => [v.criterionId, v.result]));
  const machine = criteria.filter((c) => c.verification.type === "command");
  if (machine.length === 0) {
    return false;
  }
  return machine.every((c) => byCriterion.get(c.id) === "passed");
}
