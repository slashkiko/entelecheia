import { describe, expect, it } from "vitest";
import { assess } from "../src/assess/index.js";
import type { Fact } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";
import { type VerifyDeps, verify } from "../src/verify/index.js";

/**
 * 古い commit へのレビューを、完了判定に使わせない
 * （.goals/start-the-review-we-wired.yaml の 5）。
 *
 * `review.verdict` と `review.reviewed_sha` を対にしているのは、実装が進んだ
 * あとの結論をそのまま完了判定に使わせないため（src/domain/fact-keys.ts）。
 * verdict が approved でも、それが3コミット前のコードに対する結論なら、
 * いまの実装は誰も読んでいない。
 *
 * **Fact は消さない。** 観測できたものは観測できたとおりに残し、突き合わせる段で
 * 「まだ満たしていない」と判定する。いつどの commit を読んだかを後から追えるように
 * するためで、その代わり「VERIFIED だが完了判定には使えない Fact」という状態が
 * 1つ増える。読む人間が取り違えないところまで、ここで固定する。
 *
 * 突き合わせる段は VERIFY になる。`type: fact` の criterion を判定して
 * `criteria.<id>.passed` を作るのは `src/verify/` の `judge` で、ASSESS は
 * その結果を読んで Gap にする。
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

const REVIEW_CRITERION: AcceptanceCriterion = {
  id: "ac-6",
  description: "controller が起動したレビュー役が、この実装を読んで approved を返している",
  verification: { type: "fact", key: "review.verdict", equals: "approved" },
};

const CI_CRITERION: AcceptanceCriterion = {
  id: "ac-5",
  description: "変更を載せた PR の CI が成功している",
  verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
};

function fact(key: string, value: unknown): Fact {
  return {
    key,
    value,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "ReviewPort.latest()", detail: "run-7" },
  };
}

function deps(): VerifyDeps {
  return {
    command: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    approval: {
      getApproval: async () => null,
    },
    now: () => NOW,
  };
}

async function verifyReview(facts: readonly Fact[], criteria = [REVIEW_CRITERION]) {
  return await verify({ setup: [], criteria, facts }, deps());
}

function passedValue(facts: readonly Fact[], id: string): unknown {
  return facts.find((f) => f.key === criterionFactKey(id))?.value;
}

describe("レビューした commit と実装の HEAD を突き合わせる", () => {
  it("同じ commit を読んだ approved は合格になる", async () => {
    const result = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "approved"),
      fact("review.reviewed_sha", HEAD),
    ]);

    expect(passedValue(result.facts, "ac-6")).toBe(true);
  });

  it("実装が進んだあとの approved は不合格にする", async () => {
    const result = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "approved"),
      fact("review.reviewed_sha", OLDER),
    ]);

    // 「検証できなかった」ではない。読んだ commit も現在の HEAD も観測できて
    // いるので、合否は出せている。出た答えが「まだ満たしていない」になる。
    expect(passedValue(result.facts, "ac-6")).toBe(false);
    expect(result.unverified).toHaveLength(0);
  });

  it("なぜ不合格なのかを、両方の sha ごと evidence に残す", async () => {
    const result = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "approved"),
      fact("review.reviewed_sha", OLDER),
    ]);

    const evidence = result.facts.find((f) => f.key === criterionFactKey("ac-6"))?.evidence;
    expect(evidence?.detail).toContain(OLDER);
    expect(evidence?.detail).toContain(HEAD);
  });

  it("changes_requested は sha が一致していても不合格のまま", async () => {
    const result = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "changes_requested"),
      fact("review.reviewed_sha", HEAD),
    ]);

    expect(passedValue(result.facts, "ac-6")).toBe(false);
  });

  it("reviewed_sha が無ければ、合否を出さず未検証として残す", async () => {
    const result = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "approved"),
    ]);

    // 「確かめられなかった」を「不合格」にしない（design.md §3.1）。
    // ここを false にすると、観測の穴が実装の不備として PR に出る。
    expect(passedValue(result.facts, "ac-6")).toBeUndefined();
    expect(result.unverified.map((u) => u.key)).toContain(criterionFactKey("ac-6"));
  });

  it("実装側の HEAD が観測できていなければ、同じく未検証にする", async () => {
    const result = await verifyReview([
      fact("review.verdict", "approved"),
      fact("review.reviewed_sha", HEAD),
    ]);

    expect(passedValue(result.facts, "ac-6")).toBeUndefined();
    expect(result.unverified.map((u) => u.key)).toContain(criterionFactKey("ac-6"));
  });

  it("review.verdict 以外の fact criterion は、これまでどおり値だけで判定する", async () => {
    const result = await verifyReview(
      [fact("github.ci.conclusion", "success"), fact("local.head_sha", HEAD)],
      [CI_CRITERION],
    );

    // sha の突き合わせを fact criterion 全体に広げない。CI の結論は
    // 「どの commit を読んだか」を持たないので、広げると全部が未検証になる。
    expect(passedValue(result.facts, "ac-5")).toBe(true);
  });
});

describe("止まっている理由が人間に届く", () => {
  it("ASSESS は unmet の Gap にし、detail に理由を残す", async () => {
    const verified = await verifyReview([
      fact("local.head_sha", HEAD),
      fact("review.verdict", "approved"),
      fact("review.reviewed_sha", OLDER),
    ]);

    const assessment = assess(
      {
        criteria: [REVIEW_CRITERION],
        facts: verified.facts,
        unresolved: verified.unverified,
      },
      { now: () => NOW },
    );

    const gap = assessment.gaps.find((g) => g.criterionId === "ac-6");
    expect(gap?.kind).toBe("unmet");
    // 「レビュー自体は落ちている」と「レビューは通ったが古い」を読み分けられる
    // ようにする。ここは PR の進捗コメントと `ent show` に出る唯一の説明になる。
    expect(gap?.detail).toContain(OLDER);
  });
});
