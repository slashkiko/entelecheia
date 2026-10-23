import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { APPROVAL_RULE_FLOOR, type ApprovalRule } from "../src/factory/approval-rules.js";
import {
  type AutoMergeInput,
  decideAutoMerge,
  type HumanMergeReason,
  MAX_REVIEW_ROUNDS,
} from "../src/factory/auto-merge.js";
import type { ChangedFile } from "../src/factory/change.js";
import { type EvidenceLevel, evidenceLevelSchema } from "../src/factory/evidence.js";
import { AUTO_MERGEABLE_KINDS, type WorkKind, workKindSchema } from "../src/factory/kind.js";
import {
  actorChange,
  autoMergeInput,
  effective,
  FRESH_RELEASE,
  LOCK_BUMP,
  modified,
  renovateChange,
  ZOD_BUMP,
} from "./factory-fixtures.js";

function codes(input: AutoMergeInput): HumanMergeReason["code"][] {
  return decideAutoMerge(input).reasons.map((reason) => reason.code);
}

/** 種別ごとに、自動マージに届く入力。各テストはここから1つだけ崩す */
function passingInputFor(kind: WorkKind): AutoMergeInput {
  if (kind === "deps") {
    return autoMergeInput({ change: renovateChange([ZOD_BUMP, LOCK_BUMP]), evidence: null });
  }
  return autoMergeInput({ change: actorChange(kind, [modified("src/app.ts", ["a"], ["b"])]) });
}

describe("自動マージの判定", () => {
  it("揃った入力は自動マージになる", () => {
    expect(decideAutoMerge(autoMergeInput())).toEqual({ decision: "auto_merge", reasons: [] });
  });

  it.each(AUTO_MERGEABLE_KINDS)("%s は要るものが揃えば自動マージになる", (kind) => {
    expect(decideAutoMerge(passingInputFor(kind)).decision).toBe("auto_merge");
  });

  it.each([
    ["halted", { repo: { phase: "normal", halted: true } }],
    ["repo_onboarding", { repo: { phase: "onboarding", halted: false } }],
    ["repo_suspended", { repo: { phase: "suspended", halted: false } }],
    ["evidence_missing", { evidence: null }],
    [
      "unresolved_important_review",
      { review: { completed: true, unresolvedImportant: 1, rounds: 1 } },
    ],
    [
      "review_rounds_exceeded",
      { review: { completed: true, unresolvedImportant: 0, rounds: MAX_REVIEW_ROUNDS + 1 } },
    ],
    ["review_not_completed", { review: { completed: false, unresolvedImportant: 0, rounds: 1 } }],
    ["classifier_needs_human", { classifierNeedsHuman: true }],
  ] as const)("%s なら人がマージする", (code, overrides) => {
    expect(codes(autoMergeInput(overrides as Partial<AutoMergeInput>))).toEqual([code]);
  });

  it("レビューの巡回はちょうど上限までなら通す", () => {
    const input = autoMergeInput({
      review: { completed: true, unresolvedImportant: 0, rounds: MAX_REVIEW_ROUNDS },
    });

    expect(decideAutoMerge(input).decision).toBe("auto_merge");
  });

  it("レビューの巡回の上限は3", () => {
    // 境界のテストと性質は、どちらも定数から期待値を作る。値そのものはここで固定する。
    expect(MAX_REVIEW_ROUNDS).toBe(3);
  });

  it.each([
    ["NaN の指摘数", { completed: true, unresolvedImportant: Number.NaN, rounds: 1 }],
    ["負の指摘数", { completed: true, unresolvedImportant: -1, rounds: 1 }],
    ["NaN の巡回数", { completed: true, unresolvedImportant: 0, rounds: Number.NaN }],
  ])("%s は、数が読めないものとして人がマージする", (_label, review) => {
    expect(codes(autoMergeInput({ review }))).toEqual(["review_count_invalid"]);
  });

  it.each(["harness", "migration"] as const)(
    "auto_merge に %s が紛れ込んでいても、自動マージしない",
    (kind) => {
      // 型と schema は入れさせないが、型を外して組み立てた値でも判定の側で止める。
      const policy = effective({}, { auto_merge: ["docs"] });
      const input = autoMergeInput({
        policy: { ...policy, autoMerge: [kind] as unknown as typeof policy.autoMerge },
        change: actorChange(kind, [modified("src/app.ts", ["a"], ["b"])]),
      });

      expect(codes(input)).toContain("kind_not_auto_merge");
    },
  );

  it("当たった理由をすべて返す。1つ目で止めない", () => {
    const input = autoMergeInput({
      repo: { phase: "suspended", halted: true },
      evidence: null,
      classifierNeedsHuman: true,
    });

    expect(codes(input)).toEqual([
      "halted",
      "repo_suspended",
      "evidence_missing",
      "classifier_needs_human",
    ]);
  });

  it("種別がポリシーの auto_merge に無ければ人がマージする", () => {
    const input = autoMergeInput({ policy: effective({}, { auto_merge: ["lint"] }) });

    expect(decideAutoMerge(input).reasons).toEqual([{ code: "kind_not_auto_merge", kind: "docs" }]);
  });

  it.each(["harness", "migration"] as const)(
    "%s は auto_merge に書けず、必ず人がマージする",
    (kind) => {
      const input = autoMergeInput({ change: actorChange(kind, [modified("src/app.ts")]) });

      expect(codes(input)).toEqual(["kind_not_auto_merge"]);
    },
  );

  it("fix は E4 に届かなければ人がマージする", () => {
    const input = passingInputFor("fix");
    input.evidence = { level: "E3", typesChanged: false, snapshotsChanged: false };

    expect(decideAutoMerge(input).reasons).toEqual([
      { code: "evidence_insufficient", required: "E4", actual: "E3" },
    ]);
  });

  it("docs は E2 で足りる", () => {
    const input = autoMergeInput({
      evidence: { level: "E2", typesChanged: false, snapshotsChanged: false },
    });

    expect(decideAutoMerge(input).decision).toBe("auto_merge");
  });

  it("refactor は型かスナップショットが動けば、E4 でも人がマージする", () => {
    const input = passingInputFor("refactor");
    input.evidence = { level: "E4", typesChanged: true, snapshotsChanged: false };

    expect(decideAutoMerge(input).reasons).toEqual([
      { code: "surface_changed", types: true, snapshots: false },
    ]);
  });

  it.each([
    ["lint", "E1", "E2"],
    ["docs", "E1", "E2"],
    ["flaky", "E1", "E2"],
    ["refactor", "E1", "E2"],
    ["fix", "E3", "E4"],
    ["feat", "E3", "E4"],
  ] as const)("%s は %s では足りず、%s が要る", (kind, actual, required) => {
    const input = passingInputFor(kind);
    input.evidence = { level: actual, typesChanged: false, snapshotsChanged: false };

    expect(decideAutoMerge(input).reasons).toEqual([
      { code: "evidence_insufficient", required, actual },
    ]);
    input.evidence = { level: required, typesChanged: false, snapshotsChanged: false };
    expect(decideAutoMerge(input).decision).toBe("auto_merge");
  });

  it.each(["lint", "docs", "flaky", "refactor"] as const)(
    "%s は型だけ、スナップショットだけが動いても人がマージする",
    (kind) => {
      const typesOnly = passingInputFor(kind);
      typesOnly.evidence = { level: "E4", typesChanged: true, snapshotsChanged: false };
      const snapshotsOnly = passingInputFor(kind);
      snapshotsOnly.evidence = { level: "E4", typesChanged: false, snapshotsChanged: true };

      expect(decideAutoMerge(typesOnly).reasons).toEqual([
        { code: "surface_changed", types: true, snapshots: false },
      ]);
      expect(decideAutoMerge(snapshotsOnly).reasons).toEqual([
        { code: "surface_changed", types: false, snapshots: true },
      ]);
    },
  );

  it("fix は型が動いても、それだけでは人に回さない", () => {
    const input = passingInputFor("fix");
    input.evidence = { level: "E4", typesChanged: true, snapshotsChanged: true };

    expect(decideAutoMerge(input).decision).toBe("auto_merge");
  });

  it("承認ルールに当たれば、ファイルと理由を返す", () => {
    const input = autoMergeInput({
      change: actorChange("docs", [modified("docs/guide.md"), modified("CLAUDE.md")]),
    });

    expect(decideAutoMerge(input).reasons).toEqual([
      {
        code: "approval_rule",
        reason: APPROVAL_RULE_FLOOR.find((rule) => rule.id === "agent-and-factory-config")?.reason,
        files: ["CLAUDE.md"],
      },
    ]);
  });
  it("ポリシーの承認ルールから下限が抜けていても、下限には当たる", () => {
    // composePolicy を通らずに組んだポリシーでも、判定の側で下限を足し直す。
    const input = autoMergeInput({
      policy: { ...effective(), approvalRules: [] },
      change: actorChange("docs", [modified("CLAUDE.md")]),
    });

    expect(codes(input)).toEqual(["approval_rule"]);
  });

  it.each([
    ["プロファイル", { approval_rules: [{ paths: ["docs/**"], reason: "from profile" }] }, {}],
    ["ポリシー", {}, { approval_rules: [{ kinds: ["docs"], reason: "from policy" }] }],
  ])("%sで足した承認ルールにも当たる", (_, profileOverrides, policyOverrides) => {
    const input = autoMergeInput({ policy: effective(profileOverrides, policyOverrides) });

    expect(codes(input)).toEqual(["approval_rule"]);
  });
});

describe("依存更新の自動マージ", () => {
  it("deps はエビデンスではなく、依存更新の例外の4条件で決まる", () => {
    expect(decideAutoMerge(passingInputFor("deps")).decision).toBe("auto_merge");
  });

  it("src も触る deps の PR は人がマージする（known-bad）", () => {
    const input = autoMergeInput({
      change: renovateChange([ZOD_BUMP, LOCK_BUMP, modified("src/app.ts", ["a"], ["b"])]),
      evidence: null,
    });

    expect(decideAutoMerge(input).decision).toBe("human_merge");
    expect(codes(input)).toContain("renovate_conditions_unmet");
    // 例外が外れたので、manifest と lockfile の承認ルールにも当たる
    expect(codes(input)).toContain("approval_rule");
  });

  it("lockfile が動く feat の PR は人がマージする（known-bad）", () => {
    const input = autoMergeInput({
      change: actorChange("feat", [modified("src/app.ts", ["a"], ["b"]), LOCK_BUMP]),
    });

    // lockfile に何が入ったかを呼ぶ側が読んでいないので、新しい依存としても数える
    expect(codes(input)).toEqual(["approval_rule", "new_dependency"]);
  });

  it("依存を足す PR は、新しい依存として人がマージする", () => {
    const input = autoMergeInput({
      change: renovateChange([
        modified(
          "package.json",
          ['    "zod": "^4.4.4",', '    "left-pad": "^1.3.0",'],
          ['    "zod": "^4.4.3",'],
        ),
        LOCK_BUMP,
      ]),
      evidence: null,
    });

    expect(codes(input)).toContain("new_dependency");
  });

  it.each([
    ["lockfile に新しいパッケージが入る", { addedPackages: ["new-transitive"] }],
    ["lockfile の新しいパッケージを読めなかった", { addedPackages: undefined }],
  ])("%sなら、新しい依存として人がマージする", (_, overrides) => {
    const { addedPackages: __, ...base } = renovateChange([ZOD_BUMP, LOCK_BUMP]);
    const change =
      overrides.addedPackages === undefined
        ? base
        : { ...base, addedPackages: overrides.addedPackages };
    const input = autoMergeInput({ change, evidence: null });

    expect(codes(input)).toContain("new_dependency");
    expect(decideAutoMerge(input).reasons).toContainEqual({
      code: "new_dependency",
      files: ["pnpm-lock.yaml"],
    });
  });

  it("公開から日の浅いバージョンは待つ", () => {
    const input = autoMergeInput({
      change: renovateChange([ZOD_BUMP, LOCK_BUMP], FRESH_RELEASE),
      evidence: null,
    });

    expect(decideAutoMerge(input).reasons).toContainEqual({
      code: "renovate_conditions_unmet",
      unmet: ["release_age"],
    });
  });
});

// --- 性質 ---------------------------------------------------------------------

const EVIDENCE_LEVELS = evidenceLevelSchema.options;
const WORK_KINDS = workKindSchema.options;

const arbitraryLevel = fc.constantFrom(...EVIDENCE_LEVELS);
const arbitraryKind = fc.constantFrom(...WORK_KINDS);

const arbitraryPath = fc.constantFrom(
  "src/app.ts",
  "src/lib/calc.ts",
  "docs/guide.md",
  "README.md",
  "pnpm-lock.yaml",
  "package.json",
  ".github/workflows/verify.yml",
  "CLAUDE.md",
  ".factory/policy.yaml",
  "verify/expected.json",
  "packages/core/src/factory/triage.ts",
);

const arbitraryFile: fc.Arbitrary<ChangedFile> = fc.oneof(
  arbitraryPath.map((path) => modified(path, ["a"], ["b"])),
  fc
    .tuple(arbitraryPath, arbitraryPath)
    .map(([path, previousPath]) => ({ path, previousPath, status: "renamed" as const })),
  arbitraryPath.map((path) => ({ path, status: "removed" as const })),
);

const arbitraryInput: fc.Arbitrary<AutoMergeInput> = fc
  .record({
    kind: arbitraryKind,
    files: fc.array(arbitraryFile, { minLength: 1, maxLength: 4 }),
    renovate: fc.boolean(),
    evidence: fc.option(
      fc.record({
        level: arbitraryLevel,
        typesChanged: fc.boolean(),
        snapshotsChanged: fc.boolean(),
      }),
    ),
    reviewCompleted: fc.boolean(),
    unresolvedImportant: fc.nat(2),
    rounds: fc.integer({ min: 1, max: MAX_REVIEW_ROUNDS + 1 }),
    classifierNeedsHuman: fc.boolean(),
    phase: fc.constantFrom("onboarding", "normal", "suspended" as const),
    halted: fc.boolean(),
    autoMerge: fc.subarray([...AUTO_MERGEABLE_KINDS]),
  })
  .map((r) =>
    autoMergeInput({
      policy: effective({}, { auto_merge: r.autoMerge }),
      change: r.renovate
        ? { ...renovateChange(r.files), kind: r.kind }
        : actorChange(r.kind, r.files),
      evidence: r.evidence,
      review: {
        completed: r.reviewCompleted,
        unresolvedImportant: r.unresolvedImportant,
        rounds: r.rounds,
      },
      classifierNeedsHuman: r.classifierNeedsHuman,
      repo: { phase: r.phase, halted: r.halted },
    }),
  );

/** 揃った入力に、1つずつ崩す操作を当てたもの。性質を「自動マージ側」でも試すため */
const arbitraryNearPassing: fc.Arbitrary<AutoMergeInput> = fc
  .constantFrom(...AUTO_MERGEABLE_KINDS)
  .map(passingInputFor);

const arbitraryAny = fc.oneof(arbitraryInput, arbitraryNearPassing);

function lower(level: EvidenceLevel): EvidenceLevel[] {
  return EVIDENCE_LEVELS.slice(0, EVIDENCE_LEVELS.indexOf(level));
}

describe("自動マージの判定の性質", () => {
  it("自動マージなら、種別はポリシーの auto_merge にある", () => {
    fc.assert(
      fc.property(arbitraryAny, (input) => {
        const result = decideAutoMerge(input);
        return (
          result.decision !== "auto_merge" ||
          input.policy.autoMerge.includes(input.change.kind as never)
        );
      }),
    );
  });

  it("自動マージなら、理由は空。人がマージするなら、理由は1つ以上", () => {
    fc.assert(
      fc.property(arbitraryAny, (input) => {
        const result = decideAutoMerge(input);
        return (result.decision === "auto_merge") === (result.reasons.length === 0);
      }),
    );
  });

  it("下限の承認ルールに当たる Actor の変更は、必ず人がマージする", () => {
    const floorPaths = fc.constantFrom(
      ".github/workflows/verify.yml",
      "pnpm-lock.yaml",
      "CLAUDE.md",
      ".factory/policy.yaml",
      "verify/expected.json",
      "packages/core/src/factory/triage.ts",
    );
    fc.assert(
      fc.property(arbitraryNearPassing, floorPaths, (input, path) => {
        // Renovate の変更でない限り、依存更新の例外は成り立たない
        const change = actorChange(input.change.kind, [
          ...input.change.files,
          modified(path, ["a"], ["b"]),
        ]);
        return decideAutoMerge({ ...input, change }).decision === "human_merge";
      }),
    );
  });

  it("承認ルールを足しても、人がマージを自動マージに変えない", () => {
    const extraRule: fc.Arbitrary<ApprovalRule> = fc.oneof(
      arbitraryPath.map((path) => ({ paths: [path], reason: "extra" })),
      arbitraryKind.map((kind) => ({ kinds: [kind], reason: "extra" })),
    );
    fc.assert(
      fc.property(arbitraryAny, fc.array(extraRule, { maxLength: 3 }), (input, rules) => {
        const before = decideAutoMerge(input).decision;
        const policy = {
          ...input.policy,
          approvalRules: [...input.policy.approvalRules, ...rules],
        };
        const after = decideAutoMerge({ ...input, policy }).decision;
        return before === "auto_merge" || after === "human_merge";
      }),
    );
  });

  it("エビデンスを下げても、人がマージを自動マージに変えない", () => {
    fc.assert(
      fc.property(arbitraryAny, fc.nat(), (input, pick) => {
        if (input.evidence === null) {
          return true;
        }
        const before = decideAutoMerge(input).decision;
        const options = lower(input.evidence.level);
        const withoutEvidence = decideAutoMerge({ ...input, evidence: null }).decision;
        if (before === "human_merge" && withoutEvidence === "auto_merge") {
          return false;
        }
        if (options.length === 0) {
          return true;
        }
        const level = options[pick % options.length] as EvidenceLevel;
        const after = decideAutoMerge({
          ...input,
          evidence: { ...input.evidence, level },
        }).decision;
        return before === "auto_merge" || after === "human_merge";
      }),
    );
  });

  it("止める旗（halt・登録直後・一時停止・分類器・未解決の Important）は1つでも立てば人がマージする", () => {
    const flags: fc.Arbitrary<(input: AutoMergeInput) => AutoMergeInput> = fc.constantFrom(
      (input) => ({ ...input, repo: { ...input.repo, halted: true } }),
      (input) => ({ ...input, repo: { ...input.repo, phase: "onboarding" } }),
      (input) => ({ ...input, repo: { ...input.repo, phase: "suspended" } }),
      (input) => ({ ...input, classifierNeedsHuman: true }),
      (input) => ({ ...input, review: { ...input.review, unresolvedImportant: 1 } }),
      (input) => ({ ...input, review: { ...input.review, rounds: MAX_REVIEW_ROUNDS + 1 } }),
      (input) => ({ ...input, review: { ...input.review, completed: false } }),
    );
    fc.assert(
      fc.property(
        arbitraryAny,
        flags,
        (input, raise) => decideAutoMerge(raise(input)).decision === "human_merge",
      ),
    );
  });

  it("依存更新の例外の4条件は、1つ欠けても人がマージする", () => {
    const breakOne: fc.Arbitrary<(input: AutoMergeInput) => AutoMergeInput> = fc.constantFrom(
      // 作成者
      (input) => ({ ...input, change: { ...input.change, author: { type: "user", userId: 1 } } }),
      // 種別。E4 があっても、例外が外れれば lockfile の承認ルールに当たる
      (input) => ({
        ...input,
        change: { ...input.change, kind: "feat" },
        evidence: { level: "E4", typesChanged: false, snapshotsChanged: false },
      }),
      // バージョンの行だけ
      (input) => ({
        ...input,
        change: {
          ...input.change,
          files: [...input.change.files, modified("src/app.ts", ["a"], ["b"])],
        },
      }),
      // 公開からの日数
      (input) => ({
        ...input,
        change: { ...input.change, releases: [{ name: "zod", releasedAt: FRESH_RELEASE }] },
      }),
    );
    fc.assert(
      fc.property(
        breakOne,
        (raise) => decideAutoMerge(raise(passingInputFor("deps"))).decision === "human_merge",
      ),
    );
  });

  it("判定は同じ入力に同じ結果を返す", () => {
    fc.assert(
      fc.property(arbitraryAny, (input) => {
        const copy = structuredClone(input);
        expect(decideAutoMerge(input)).toEqual(decideAutoMerge(copy));
        // 入力を書き換えない
        expect(input).toEqual(copy);
      }),
    );
  });
});
