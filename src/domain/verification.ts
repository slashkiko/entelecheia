import { z } from "zod";
import { type Evidence, evidenceSchema, type Fact, type Unresolved, verifiedOnly } from "./fact.js";
import {
  criterionFactKey,
  LOCAL_HEAD_SHA_KEY,
  REVIEW_REVIEWED_SHA_KEY,
  REVIEW_VERDICT_KEY,
} from "./fact-keys.js";
import type { AcceptanceCriterion } from "./goal.js";

/**
 * criteria 1件の検証結果。design.md §4.5 の Verification テーブルに対応する。
 *
 * `criteria.<id>.passed` の Fact と同じ結果の二重表現になるが、§4.5 が
 * 役割分担を明記している。こちらは criteria 単位の索引で、Fact は ASSESS に渡る観測値。
 * §9 の完了判定は「全 criteria の `Verification.result` が `passed`」と書かれており、
 * その文面が指すものが実装に無かった。
 *
 * result を3値にするのは §3.1 と同じ理由で、「落ちた」と「検証できなかった」を
 * 混ぜないため。`unresolved` のときだけ reason が埋まり、evidence は無い。
 */
export const verificationResultSchema = z.enum(["passed", "failed", "unresolved"]);
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const verificationSchema = z.object({
  criterionId: z.string().min(1),
  result: verificationResultSchema,
  /** `unresolved` のときだけ埋まる。port_failed / pending のどちらか */
  reason: z.string().nullable(),
  /** 結論を出せたときだけ埋まる。追跡の手がかりを criteria 単位でも引けるようにする */
  evidence: evidenceSchema.nullable(),
  /** 何を確かめられなかったか、あるいはどう判定したかの説明 */
  detail: z.string(),
  verifiedAt: z.string().datetime(),
});
export type Verification = z.infer<typeof verificationSchema>;

/**
 * 1ティックの結果から criteria 単位の検証結果を組み立てる。
 *
 * VERIFY をもう一度回すのではなく、reconcile が返した Fact と unresolved から導く。
 * 検証そのものは `src/verify/` が持ち、ここは同じ結果を別の索引で並べ直すだけ。
 * 二重に検証すると、同じティックで結果が食い違う余地が生まれる。
 *
 * 満たすべき性質:
 * - criteria の並び順をそのまま保つ。人間が YAML と突き合わせて読むため
 * - 完了判定に使ってよいのは VERIFIED だけ（design.md §3.1）。
 *   INFERRED な `criteria.<id>.passed` は passed にも failed にもしない
 * - Fact も unresolved も無い criteria は `unresolved` にする。
 *   結論が出なかったことを「合格」にも「不合格」にも畳まない
 * - 同じ criterion に前ティックの Fact と今ティックの unresolved が両方あるなら、
 *   unresolved を採る。今ティックで確かめられなかったことのほうが新しい
 */
export function toVerifications(
  criteria: readonly AcceptanceCriterion[],
  facts: readonly Fact[],
  unresolved: readonly Unresolved[],
  verifiedAt: string,
): Verification[] {
  const verifiedFacts = new Map(verifiedOnly(facts).map((fact) => [fact.key, fact]));
  const unresolvedByKey = new Map(unresolved.map((entry) => [entry.key, entry]));

  return criteria.map((criterion) => {
    const key = criterionFactKey(criterion.id);

    // unresolved を Fact より先に見る。reconcile は前ティックの Fact を土台に
    // 今ティックの観測を重ねるので、今ティックで検証できなかった criterion にも
    // 前ティックの `passed: true` が残っている。Fact を先に引いていたころは、
    // それを今ティックの結果として 🟢 passed と表示していた。
    // 完了判定は decide の unresolved チェックが守っているので COMPLETED には
    // ならないが、人間が読む索引が「確かめられなかった」を「合格」に畳んでいた。
    const entry = unresolvedByKey.get(key);
    if (entry !== undefined) {
      return {
        criterionId: criterion.id,
        result: "unresolved",
        reason: entry.reason,
        evidence: null,
        detail: entry.detail,
        verifiedAt,
      };
    }

    const fact = verifiedFacts.get(key);
    if (fact !== undefined) {
      const evidence: Evidence = fact.evidence;
      return {
        criterionId: criterion.id,
        result: fact.value === true ? "passed" : "failed",
        reason: null,
        evidence,
        detail: evidence.detail,
        verifiedAt,
      };
    }

    // 結論が出なかったことを合格にも不合格にも畳まない（design.md §3.1）。
    return {
      criterionId: criterion.id,
      result: "unresolved",
      reason: "pending",
      evidence: null,
      detail: `${key} is present neither as a VERIFIED Fact nor as unresolved`,
      verifiedAt,
    };
  });
}

/**
 * レビューの鮮度に依存する criterion か。
 *
 * `review.verdict` は「どの commit を読んだ結論か」（`review.reviewed_sha`）と
 * 対でしか意味を持たないので、どちらのキーを見る criterion も同じ扱いにする
 * （`src/verify/index.ts` の `judgeReviewVerdict`）。
 */
function dependsOnReview(criterion: AcceptanceCriterion): boolean {
  const verification = criterion.verification;
  return (
    verification.type === "fact" &&
    (verification.key === REVIEW_VERDICT_KEY || verification.key === REVIEW_REVIEWED_SHA_KEY)
  );
}

/**
 * 判定を見送った理由。`ent get` と PR の進捗コメントに出る唯一の説明になる。
 *
 * 定数にしておくのは、読む人間が「落ちた」と読み違えないことがこの表現の
 * 目的そのもので、文面が仕様にあたるため。
 */
export const REVIEW_PENDING_DETAIL =
  `The implement role ran this tick, so review criteria are not judged this tick. ` +
  `Both ${REVIEW_REVIEWED_SHA_KEY} and ${LOCAL_HEAD_SHA_KEY} were observed before ACT, ` +
  `and nobody has read the commits added during this tick yet`;

/**
 * 実装役が走ったティックの検証結果から、レビュー系の criteria を pending に倒す。
 *
 * 1ティックの中は OBSERVE → ACT → publish の順に進むので、VERIFY が読む
 * `local.head_sha` は ACT より前の観測になる。実装役が commit を積むと、ティックが
 * 終わる時点の HEAD は誰も読んでいない commit になっているのに、`review.reviewed_sha`
 * との一致だけを見た結果が「現在の HEAD へのレビュー」として残る。
 *
 * 満たすべき性質:
 * - 倒す先は「不合格」ではなく「判定しない」にする。ACT のあとの HEAD を誰かが
 *   読んだかどうかは、このティックでは確かめようがない。確かめられないものを
 *   不合格として記録すると、観測の穴が実装の不備として PR に出る（design.md §3.1、
 *   `findViolations` の「判定できないものを違反にしない」と同じ考え方）
 * - `criteria.<id>.passed` の Fact を落とす。Fact は次のティックへ引き継がれるので、
 *   残すと誰も読んでいない commit への承認が VERIFIED なまま生き続ける
 * - 落とすだけにしない。Fact の不在は「対象が無い」とも読めるので、同じキーを
 *   pending として unresolved に積む（design.md §3.1）
 * - 既に unresolved に積まれている criterion は触らない。検証できなかった理由が
 *   あるなら、そちらのほうが具体的になる
 * - 観測そのものの Fact（`review.verdict` / `review.reviewed_sha`）は落とさない。
 *   いつどの commit を読んだかは、後から追えるようにしておく
 * - レビューに依存しない criteria には触らない。CI の結論のように「どの commit を
 *   読んだか」を持たない観測まで巻き込むと、実装役が走るたびに全部が未検証になる
 */
export function pendingReviewCriteria(
  criteria: readonly AcceptanceCriterion[],
  facts: readonly Fact[],
  unresolved: readonly Unresolved[],
): { facts: Fact[]; unresolved: Unresolved[] } {
  const keys = new Set(criteria.filter(dependsOnReview).map((c) => criterionFactKey(c.id)));
  if (keys.size === 0) {
    return { facts: [...facts], unresolved: [...unresolved] };
  }

  const already = new Set(unresolved.map((entry) => entry.key));
  const pending: Unresolved[] = [...keys]
    .filter((key) => !already.has(key))
    .map((key) => ({ key, reason: "pending", detail: REVIEW_PENDING_DETAIL }));

  return {
    facts: facts.filter((fact) => !keys.has(fact.key)),
    unresolved: [...unresolved, ...pending],
  };
}
