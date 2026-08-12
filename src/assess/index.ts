import { type Fact, type Unresolved, verifiedOnly } from "../domain/fact.js";
import { criterionFactKey } from "../domain/fact-keys.js";
import type { Assessment, Gap } from "../domain/gap.js";
import type { AcceptanceCriterion } from "../domain/goal.js";

/**
 * ASSESS は外部世界を触らない。OBSERVE と VERIFY が集めた Fact だけを読む。
 * Port が要らないのは、ここで新たに観測してしまうと
 * 「どのティックで見た値か」が Fact ごとにずれるため。
 */
export interface AssessTarget {
  criteria: readonly AcceptanceCriterion[];
  /** OBSERVE と VERIFY が返した Fact を合わせたもの */
  facts: readonly Fact[];
  /** unobserved と unverified を合わせたもの */
  unresolved: readonly Unresolved[];
}

export interface AssessDeps {
  /** テスト時に固定するための時刻ソース */
  now: () => Date;
}

/**
 * Acceptance Criteria と Fact を突き合わせ、埋まっていない差分を返す。
 *
 * 満たすべき性質:
 * - satisfied の判定に使ってよいのは VERIFIED な Fact だけ（design.md §3.1）。
 *   INFERRED しか無い criteria は満たしたことにしない
 * - 「検証して落ちた」（unmet）と「まだ検証していない」（unknown）を分ける。
 *   混ぜると DECIDE が「直す」と「確かめる」を選び分けられない
 * - unresolved に残っている criteria は unknown。落ちたことにしない
 * - gaps が空であることと satisfied は一致する
 *
 * `src/domain/verification.ts` の `toVerifications` と似た3値判定をするが、
 * **答えている問いが違うので1つに畳まない**（design.md §4.5）。
 * ここは「VERIFIED な根拠で満たされているか」で、前ティックから繰り越した Fact も
 * 根拠に数える。そうしないと、GitHub が一時的に落ちただけで直したはずの Gap が復活する。
 * 向こうは「このティックで何が起きたか」なので、繰り越しより今ティックの
 * unresolved を優先する。
 */
export function assess(target: AssessTarget, deps: AssessDeps): Assessment {
  // 1 回だけ読む。同じ評価に含まれる Gap の時刻を揃える。
  const assessedAt = deps.now().toISOString();

  // 完了判定に使ってよいのは VERIFIED だけ（design.md §3.1）。
  // ここで絞っておけば、以降の分岐で confidence を気にしなくて済む。
  const verified = verifiedOnly(target.facts);
  const gaps: Gap[] = [];

  for (const criterion of target.criteria) {
    const key = criterionFactKey(criterion.id);
    const fact = verified.find((f) => f.key === key);

    if (fact === undefined) {
      // 「まだ確かめていない」を「落ちた」と同じにすると、
      // DECIDE が VERIFY ではなく ACT を選んでしまう。
      gaps.push({ criterionId: criterion.id, kind: "unknown", detail: unknownDetail(key, target) });
      continue;
    }

    if (fact.value === true) {
      continue;
    }

    gaps.push({
      criterionId: criterion.id,
      kind: "unmet",
      detail: `${criterion.description} is not satisfied (${fact.evidence.source}: ${fact.evidence.detail})`,
    });
  }

  // gaps が空であることと satisfied は同値。§3.1 の完了判定という意味を残すため別に持つ。
  return { assessedAt, gaps, satisfied: gaps.length === 0 };
}

/**
 * なぜ unknown と判定したかを書く。人間と LLM の両方が読むので、
 * 「Fact が無い」「確かめられなかった」「INFERRED しか無い」を区別して残す。
 */
function unknownDetail(key: string, target: AssessTarget): string {
  const unresolved = target.unresolved.find((u) => u.key === key);
  if (unresolved !== undefined) {
    return `${key} has no conclusion (${unresolved.reason}: ${unresolved.detail})`;
  }

  // verified に無くて facts にあるなら INFERRED しか無いということ。
  // 落ちたのではなく、完了判定に使えないだけ（design.md §3.1）。
  if (target.facts.some((f) => f.key === key)) {
    return `${key} has only an INFERRED Fact. Inference cannot judge completion, so it counts as unverified`;
  }

  return `No Fact has verified ${key} yet`;
}
