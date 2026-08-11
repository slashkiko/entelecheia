import { z } from "zod";
import type { Action, WaitReason } from "./action.js";

/**
 * Goal のライフサイクル。design.md §4.4 の状態機械をそのまま型にする。
 *
 * ESCALATE は reconcile が選ぶ行動、BLOCKED は Goal の状態でレイヤーが違う。
 * 同じ「止まっている」でも、前者は1ティックの出力、後者は次のティックが読む前提になる。
 */
export const goalStatusSchema = z.enum([
  /** 登録されたが criteria が承認されていない */
  "DRAFT",
  /** criteria の承認待ち。design.md §3.2 では YAML のレビューがこれにあたる */
  "AWAITING_CRITERIA_APPROVAL",
  "ACTIVE",
  /** 人間の承認待ち。reconcile は即 return している */
  "WAITING_HUMAN",
  /** CI や使用量上限の待ち。resume_after を持つことがある */
  "WAITING_EXTERNAL",
  /** 予算・回数・時間の上限に到達した */
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "ABANDONED",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

/**
 * 終端状態。ここからは遷移しない。
 * 終端に落ちた Goal を次のティックが拾って動かし続けると、完了判定が意味を失う。
 */
export function isTerminal(status: GoalStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "ABANDONED";
}

/**
 * Decision の action から次の状態を決める。
 *
 * 満たすべき性質:
 * - 終端状態からは遷移しない。現在の状態をそのまま返す
 * - COMPLETE → COMPLETED
 * - WAIT(human_review_pending | review_pending) → WAITING_HUMAN、
 *   それ以外の WAIT → WAITING_EXTERNAL
 * - ESCALATE(budget_exhausted) → BLOCKED、それ以外の ESCALATE → WAITING_HUMAN
 * - ACT / VERIFY / REPLAN → ACTIVE
 * - ACTIVE でない状態からでも、上の対応で ACTIVE に戻れる（design.md §4.4 の ⇅）
 */
/**
 * 待つ相手が人間である WAIT の理由。ここに載っている分だけ WAITING_HUMAN になる。
 *
 * 2語あるのは名前を入れ替えたからで、意味は1つになる。`review_pending` を
 * 落とすと、その語で書かれた過去の Decision が WAITING_EXTERNAL に化け、
 * 人間の承認待ちが「外部待ち」として再開を待ち続ける。
 */
const HUMAN_WAIT_REASONS = new Set<WaitReason>(["human_review_pending", "review_pending"]);

export function nextStatus(current: GoalStatus, action: Action): GoalStatus {
  if (isTerminal(current)) {
    return current;
  }

  switch (action.type) {
    case "COMPLETE":
      return "COMPLETED";

    case "WAIT":
      // 待つ相手が人間か外部かで、次のティックが何を見に行くかが変わる。
      // `review_pending` は `human_review_pending` の旧名で、過去の Decision を
      // 読み直したときに同じ WAITING_HUMAN に落ちる必要がある。
      return HUMAN_WAIT_REASONS.has(action.reason) ? "WAITING_HUMAN" : "WAITING_EXTERNAL";

    case "ESCALATE":
      // 人間を呼ぶ点は同じだが、上限に達したかどうかで再開の条件が違う。
      return action.reason === "budget_exhausted" ? "BLOCKED" : "WAITING_HUMAN";

    // 待機や BLOCKED からでも動き出せる（design.md §4.4 の ⇅）
    case "ACT":
    case "VERIFY":
    case "REPLAN":
      return "ACTIVE";

    default:
      // Action に種類を足したらここで型エラーになる。状態機械の中心を
      // default に畳んでおくと、新しい行動が黙って ACTIVE 扱いになる。
      return assertNever(action);
  }
}

function assertNever(action: never): never {
  throw new Error(`未知の Action: ${JSON.stringify(action)}`);
}

/** Goal の実行時状態。Goal YAML には現れない側 */
export interface GoalState {
  id: string;
  status: GoalStatus;
  /** lease の所有者。誰も持っていなければ null */
  leaseOwner: string | null;
  leaseUntil: string | null;
  /** 使用量上限などで待つ場合の再開時刻。分からなければ null */
  resumeAfter: string | null;
  /** ACTIVE にした時刻。経過時間の上限判定に使う */
  activatedAt: string | null;
  /** これまでに回した reconcile の回数 */
  reconciles: number;
  /**
   * 観測対象。Goal YAML は宣言部だけを持つので、ここが置き場になる。
   * PR が未作成なら null。
   */
  prNumber: number | null;
  issueNumber: number | null;
  /**
   * 人間が「もう追わない」と宣言したときの理由。ABANDONED でなければ null。
   *
   * status だけでは、なぜ出荷済みの Goal が放棄されているのかが読めない。
   * ここが `sqlite3` で直接書き換えるのとの差になる（`ent abandon --reason`）。
   */
  abandonReason: string | null;
  /**
   * 関門が差分を取る相手。`ent start` を叩いた時点の repoRoot の HEAD。
   *
   * 関門が答えたい問いは「Actor が何を書いたか」で、PR が答えたい問いは
   * 「リリース先との差は何か」になる。`repository.default_branch` は後者なので、
   * 前者の基準に流用すると、**人間が呼び出し側のブランチに書いたものまで
   * Actor の編集として並ぶ**。Goal の宣言（`.goals/*.yaml`）がまさにそれで、
   * `.goals/**` は PROTECTED_PATH_FLOOR にあるため毎ティック
   * `protected_path_touched` になっていた。
   *
   * ブランチ名ではなく sha で持つ。差分は3点表記（`base...HEAD`）なので、
   * base が先に進むだけなら分岐点は動かない。動くのは**分岐点の commit 自体を
   * 書き換えたとき**で、そのとき `merge-base` が消えて
   * `ESCALATE(guard_unavailable)` になる。作業ブランチでは amend も rebase も
   * 日常的なので、ent を回している最中に1回打つだけで関門が張れなくなる。
   * sha で固定しておけば、その commit が生きている限り差分は取れる。
   *
   * 記録が無い Goal（この列より前に start した分）は null で、呼び出し側が
   * `default_branch` に落とす。移行のために古い挙動を残してある。
   */
  guardBaseSha: string | null;
}

/** `ent list` / Store.listGoals が返す1件分。宣言部と実行時状態の要点だけをまとめる */
export interface GoalListItem {
  id: string;
  name: string;
  status: GoalStatus;
  reconciles: number;
  prNumber: number | null;
  resumeAfter: string | null;
}
