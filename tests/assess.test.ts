import { describe, expect, it } from "vitest";
import { assess } from "../src/assess/index.js";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import { assessmentSchema, type Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");
const deps = { now: () => NOW };

function criterion(id: string): AcceptanceCriterion {
  return {
    id,
    description: `${id} を満たす`,
    verification: { type: "command", run: "mise run test" },
  };
}

function passedFact(id: string, passed: boolean): Fact {
  return {
    key: criterionFactKey(id),
    value: passed,
    observedAt: NOW.toISOString(),
    confidence: "VERIFIED",
    evidence: { source: "mise run test", detail: `exit_code=${passed ? 0 : 1}` },
  };
}

function gapFor(gaps: readonly Gap[], id: string): Gap | undefined {
  return gaps.find((g) => g.criterionId === id);
}

describe("assess", () => {
  it("全 criteria が VERIFIED で合格なら satisfied になる", () => {
    const result = assess(
      {
        criteria: [criterion("ac-1"), criterion("ac-2")],
        facts: [passedFact("ac-1", true), passedFact("ac-2", true)],
        unresolved: [],
      },
      deps,
    );

    expect(result.gaps).toEqual([]);
    expect(result.satisfied).toBe(true);
    expect(result.assessedAt).toBe(NOW.toISOString());
  });

  it("検証して落ちた criteria は unmet の Gap になる", () => {
    const result = assess(
      {
        criteria: [criterion("ac-1")],
        facts: [passedFact("ac-1", false)],
        unresolved: [],
      },
      deps,
    );

    expect(gapFor(result.gaps, "ac-1")?.kind).toBe("unmet");
    expect(result.satisfied).toBe(false);
  });

  it("Fact が無い criteria は unknown の Gap になる", () => {
    // 「まだ確かめていない」を「落ちた」と同じにすると、
    // DECIDE が VERIFY ではなく ACT を選んでしまう。
    const result = assess({ criteria: [criterion("ac-1")], facts: [], unresolved: [] }, deps);

    expect(gapFor(result.gaps, "ac-1")?.kind).toBe("unknown");
    expect(result.satisfied).toBe(false);
  });

  it("unresolved に残っている criteria は unknown であって不合格ではない", () => {
    const unresolved: Unresolved[] = [
      { key: criterionFactKey("ac-1"), reason: "pending", detail: "承認待ち" },
    ];
    const result = assess({ criteria: [criterion("ac-1")], facts: [], unresolved }, deps);

    expect(gapFor(result.gaps, "ac-1")?.kind).toBe("unknown");
  });

  it("INFERRED な Fact しか無い criteria は満たしたことにしない", () => {
    // design.md §3.1「Goal を COMPLETED にする判定に INFERRED は使わない」
    const inferred: Fact = {
      key: criterionFactKey("ac-1"),
      value: true,
      observedAt: NOW.toISOString(),
      confidence: "INFERRED",
    };

    const result = assess(
      { criteria: [criterion("ac-1")], facts: [inferred], unresolved: [] },
      deps,
    );

    expect(result.satisfied).toBe(false);
    expect(gapFor(result.gaps, "ac-1")?.kind).toBe("unknown");
  });

  it("unmet と unknown が混ざっても両方 Gap として残る", () => {
    const result = assess(
      {
        criteria: [criterion("ac-1"), criterion("ac-2"), criterion("ac-3")],
        facts: [passedFact("ac-1", true), passedFact("ac-2", false)],
        unresolved: [],
      },
      deps,
    );

    expect(gapFor(result.gaps, "ac-1")).toBeUndefined();
    expect(gapFor(result.gaps, "ac-2")?.kind).toBe("unmet");
    expect(gapFor(result.gaps, "ac-3")?.kind).toBe("unknown");
    expect(result.satisfied).toBe(false);
  });

  it("gaps が空であることと satisfied は一致する", () => {
    const criteria = [criterion("ac-1")];

    const met = assess({ criteria, facts: [passedFact("ac-1", true)], unresolved: [] }, deps);
    expect(met.gaps.length === 0).toBe(met.satisfied);

    const unmet = assess({ criteria, facts: [passedFact("ac-1", false)], unresolved: [] }, deps);
    expect(unmet.gaps.length === 0).toBe(unmet.satisfied);
  });

  it("Gap には判定の根拠が入る", () => {
    const result = assess(
      { criteria: [criterion("ac-1")], facts: [passedFact("ac-1", false)], unresolved: [] },
      deps,
    );

    expect(gapFor(result.gaps, "ac-1")?.detail.length).toBeGreaterThan(0);
  });

  it("戻り値が Assessment スキーマを通る", () => {
    const result = assess({ criteria: [criterion("ac-1")], facts: [], unresolved: [] }, deps);
    expect(() => assessmentSchema.parse(result)).not.toThrow();
  });
});
