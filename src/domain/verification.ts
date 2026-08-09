import { z } from "zod";
import { type Evidence, evidenceSchema, type Fact, type Unresolved, verifiedOnly } from "./fact.js";
import { criterionFactKey } from "./fact-keys.js";
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

    // 結論が出なかったことを合格にも不合格にも畳まない（design.md §3.1）。
    return {
      criterionId: criterion.id,
      result: "unresolved",
      reason: "pending",
      evidence: null,
      detail: `${key} が VERIFIED な Fact としても unresolved としても残っていない`,
      verifiedAt,
    };
  });
}
