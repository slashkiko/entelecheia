import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { workKindSchema } from "../src/factory/kind.js";
import { DISCOVERY_SOURCES } from "../src/factory/policy.js";
import {
  TEMPLATE_KINDS,
  type TriageItem,
  type TriageState,
  triage,
  type WorkSource,
} from "../src/factory/triage.js";
import { effective } from "./factory-fixtures.js";

const POLICY = effective(
  {},
  {
    auto_merge: ["deps", "lint", "docs", "flaky", "refactor"],
    discovery: {
      failing_tests: true,
      doctor: true,
      lint_warnings: true,
      todo: false,
      roadmap: { path: "docs/roadmap.md", charter: "docs/charter.md" },
      ai_review: true,
    },
  },
);

function item(overrides: Partial<TriageItem> = {}): TriageItem {
  return { source: "owner", kind: "feat", duplicate: false, revertedTarget: false, ...overrides };
}

function state(overrides: Partial<TriageState> = {}): TriageState {
  return { halted: false, waitingHuman: 0, startedToday: 0, quotaLow: false, ...overrides };
}

describe("トリアージ", () => {
  it("オーナーの Issue は着手し、意図は本文から作る", () => {
    expect(triage(item(), state(), POLICY)).toEqual({ decision: "start", template: false });
  });

  it("factory が見つけた auto_merge の種別の作業は、意図をテンプレートで作る", () => {
    expect(triage(item({ source: "lint_warnings", kind: "lint" }), state(), POLICY)).toEqual({
      decision: "start",
      template: true,
    });
  });

  it("オーナーの Issue は auto_merge の種別でも本文から作る", () => {
    expect(triage(item({ kind: "docs" }), state(), POLICY)).toEqual({
      decision: "start",
      template: false,
    });
  });

  it("halt 中はどれも拒否する", () => {
    expect(triage(item(), state({ halted: true }), POLICY)).toEqual({
      decision: "reject",
      reason: "halted",
    });
  });

  it("同じ作業が開いていれば拒否する", () => {
    expect(triage(item({ duplicate: true }), state(), POLICY)).toEqual({
      decision: "reject",
      reason: "duplicate",
    });
  });

  it("ポリシーで無効にした出どころの作業は拒否する", () => {
    expect(triage(item({ source: "todo", kind: "fix" }), state(), POLICY)).toEqual({
      decision: "reject",
      reason: "source_disabled",
    });
  });

  it("revert された対象は proposed にして人を待つ。オーナーの Issue でも同じ", () => {
    expect(triage(item({ revertedTarget: true }), state(), POLICY)).toEqual({
      decision: "propose",
      reason: "reverted_target",
    });
  });

  it("1日の上限に達したら保留する", () => {
    const limit = POLICY.limits.daily_starts;

    expect(triage(item(), state({ startedToday: limit - 1 }), POLICY).decision).toBe("start");
    expect(triage(item(), state({ startedToday: limit }), POLICY)).toEqual({
      decision: "hold",
      reason: "daily_limit",
    });
  });

  it("枠の残りが少なければ保留する。Actor を動かさない deps は除く", () => {
    expect(triage(item(), state({ quotaLow: true }), POLICY)).toEqual({
      decision: "hold",
      reason: "quota_low",
    });
    expect(
      triage(item({ source: "doctor", kind: "deps" }), state({ quotaLow: true }), POLICY).decision,
    ).toBe("start");
  });

  it("枠の残りが少なければ、auto_merge の種別の見つけた作業も保留する", () => {
    // 枠の判定は auto_merge の近道より先に見る。lint は Actor を動かす。
    expect(
      triage(item({ source: "lint_warnings", kind: "lint" }), state({ quotaLow: true }), POLICY),
    ).toEqual({ decision: "hold", reason: "quota_low" });
  });

  it("テンプレートで着手する近道は、設計が挙げる4つの種別に限る", () => {
    expect(TEMPLATE_KINDS).toEqual(["deps", "lint", "flaky", "docs"]);
  });

  it("auto_merge に refactor があっても、見つけた refactor は近道に乗らず WIP の上限に掛かる", () => {
    const todo = item({ source: "todo", kind: "refactor" });
    const policy = effective({}, { auto_merge: ["refactor"], discovery: { todo: true } });

    expect(triage(todo, state(), policy)).toEqual({ decision: "start", template: false });
    expect(triage(todo, state({ waitingHuman: policy.limits.wip }), policy)).toEqual({
      decision: "hold",
      reason: "wip_limit",
    });
  });

  it.each([
    ["accept", { decision: "start", template: false }],
    ["reject", { decision: "reject", reason: "charter_rejected" }],
    ["absent", { decision: "propose", reason: "no_charter" }],
  ] as const)(
    "auto_merge に feat があっても、ロードマップの feat は憲章の判定 %s に従う",
    (charter, expected) => {
      const withFeat = effective(
        {},
        {
          auto_merge: ["deps", "lint", "fix", "feat"],
          discovery: { roadmap: { path: "docs/roadmap.md", charter: "docs/charter.md" } },
        },
      );

      expect(triage(item({ source: "roadmap", kind: "feat", charter }), state(), withFeat)).toEqual(
        expected,
      );
      // 人の対応待ちが詰まっていれば、憲章が認めても着手しない。
      expect(
        triage(
          item({ source: "roadmap", kind: "feat", charter: "accept" }),
          state({ waitingHuman: withFeat.limits.wip }),
          withFeat,
        ),
      ).toEqual({ decision: "hold", reason: "wip_limit" });
    },
  );

  it("人の対応待ちが WIP の上限以上なら、auto_merge に無い種別は保留する", () => {
    const busy = state({ waitingHuman: POLICY.limits.wip });

    expect(triage(item({ kind: "fix" }), busy, POLICY)).toEqual({
      decision: "hold",
      reason: "wip_limit",
    });
    // auto_merge の種別は人の手を待たないので、WIP の上限で止めない
    expect(triage(item({ source: "lint_warnings", kind: "lint" }), busy, POLICY).decision).toBe(
      "start",
    );
  });

  it.each([
    ["accept", { decision: "start", template: false }],
    ["reject", { decision: "reject", reason: "charter_rejected" }],
    ["absent", { decision: "propose", reason: "no_charter" }],
    [undefined, { decision: "propose", reason: "no_charter" }],
  ] as const)("ロードマップの feat は憲章の判定 %s に従う", (charter, expected) => {
    const roadmap = item({ source: "roadmap", kind: "feat", ...(charter ? { charter } : {}) });

    expect(triage(roadmap, state(), POLICY)).toEqual(expected);
  });

  it("落ちたテストから見つけた fix は着手する", () => {
    expect(triage(item({ source: "failing_tests", kind: "fix" }), state(), POLICY)).toEqual({
      decision: "start",
      template: false,
    });
  });

  it("順番どおりに見る。halt は重複より、重複は revert より先", () => {
    expect(
      triage(item({ duplicate: true, revertedTarget: true }), state({ halted: true }), POLICY),
    ).toEqual({ decision: "reject", reason: "halted" });
    expect(triage(item({ duplicate: true, revertedTarget: true }), state(), POLICY)).toEqual({
      decision: "reject",
      reason: "duplicate",
    });
  });
});

const arbitrarySource: fc.Arbitrary<WorkSource> = fc.constantFrom("owner", ...DISCOVERY_SOURCES);

const arbitraryItem: fc.Arbitrary<TriageItem> = fc.record(
  {
    source: arbitrarySource,
    kind: fc.constantFrom(...workKindSchema.options),
    duplicate: fc.boolean(),
    revertedTarget: fc.boolean(),
    charter: fc.constantFrom("accept" as const, "reject" as const, "absent" as const),
  },
  { requiredKeys: ["source", "kind", "duplicate", "revertedTarget"] },
);

/** auto_merge に何を書いたポリシーでも性質が崩れないかを見る */
const arbitraryPolicy = fc
  .subarray(["deps", "lint", "docs", "flaky", "refactor", "fix", "feat"] as const)
  .map((autoMerge) => ({ ...POLICY, autoMerge: [...autoMerge] }));

const arbitraryState: fc.Arbitrary<TriageState> = fc.record({
  halted: fc.boolean(),
  waitingHuman: fc.nat(6),
  startedToday: fc.nat(12),
  quotaLow: fc.boolean(),
});

describe("トリアージの性質", () => {
  it("halt 中は着手しない", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, (i, s) => {
        return triage(i, { ...s, halted: true }, POLICY).decision === "reject";
      }),
    );
  });

  it("1日の上限を超えて着手しない", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, (i, s) => {
        const decision = triage(i, s, POLICY).decision;
        return s.startedToday < POLICY.limits.daily_starts || decision !== "start";
      }),
    );
  });

  it("revert された対象に、自動で着手しない", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, (i, s) => {
        return triage({ ...i, revertedTarget: true }, s, POLICY).decision !== "start";
      }),
    );
  });

  it("テンプレートで作るのは、factory が見つけた、近道の4種別のうち auto_merge にある作業だけ", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, arbitraryPolicy, (i, s, policy) => {
        const result = triage(i, s, policy);
        if (result.decision !== "start" || !result.template) {
          return true;
        }
        return (
          i.source !== "owner" &&
          (TEMPLATE_KINDS as readonly string[]).includes(i.kind) &&
          (policy.autoMerge as readonly string[]).includes(i.kind)
        );
      }),
    );
  });

  it("ロードマップの feat は、auto_merge に関わらず憲章が認めたときしか着手しない", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, arbitraryPolicy, (i, s, policy) => {
        const roadmap = { ...i, source: "roadmap" as const, kind: "feat" as const };
        return triage(roadmap, s, policy).decision !== "start" || roadmap.charter === "accept";
      }),
    );
  });

  it("枠の残りが少ないときに着手するのは deps だけ", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, arbitraryPolicy, (i, s, policy) => {
        const decision = triage(i, { ...s, quotaLow: true }, policy).decision;
        return decision !== "start" || i.kind === "deps";
      }),
    );
  });

  it("factory が見つけた出どころは、ポリシーで有効なものからしか着手しない", () => {
    fc.assert(
      fc.property(arbitraryItem, arbitraryState, (i, s) => {
        const result = triage(i, s, POLICY);
        return (
          result.decision !== "start" || i.source === "owner" || POLICY.discovery.has(i.source)
        );
      }),
    );
  });
});
