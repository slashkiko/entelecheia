import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { APPROVAL_RULE_FLOOR } from "../src/factory/approval-rules.js";
import { AUTO_MERGEABLE_KINDS } from "../src/factory/kind.js";
import {
  composePolicy,
  DISCOVERY_SOURCES,
  policySchema,
  profileSchema,
} from "../src/factory/policy.js";
import { effective, policy, profile } from "./factory-fixtures.js";

describe("policy.yaml のスキーマ", () => {
  it("version と limits だけ書けば、残りは安全側の既定値になる", () => {
    const parsed = policySchema.parse({
      version: 1,
      limits: { wip: 1, daily_starts: 1, max_diff_lines: 100 },
    });

    expect(parsed.auto_merge).toEqual([]);
    expect(parsed.approval_rules).toEqual([]);
    expect(parsed.release).toBe("human");
    expect(parsed.holdout.review).toBe("all");
    expect(parsed.criteria.review).toBe("all");
    expect(parsed.actor).toEqual({ auth: "subscription", api_monthly_cap_usd: null });
    expect(Object.values(parsed.discovery).every((value) => value === false)).toBe(true);
  });

  it("上限は既定値を持たない。書き忘れたら落ちる", () => {
    // 数字は監査ログの実測後に決める。大きめの既定値で黙って回り始めないようにする。
    expect(policySchema.safeParse({ version: 1 }).success).toBe(false);
  });

  it("知らないキーは誤字として落とす", () => {
    const result = policySchema.safeParse({
      version: 1,
      limits: { wip: 1, daily_starts: 1, max_diff_lines: 100 },
      auto_marge: ["docs"],
    });

    expect(result.success).toBe(false);
  });

  it("harness と migration は auto_merge に書けない", () => {
    for (const kind of ["harness", "migration"]) {
      const result = policySchema.safeParse({
        version: 1,
        limits: { wip: 1, daily_starts: 1, max_diff_lines: 100 },
        auto_merge: [kind],
      });
      expect(result.success, kind).toBe(false);
    }
  });

  it("承認ルールは paths か kinds の少なくとも一方が要る", () => {
    const base = { version: 1, limits: { wip: 1, daily_starts: 1, max_diff_lines: 100 } };

    expect(policySchema.safeParse({ ...base, approval_rules: [{ reason: "x" }] }).success).toBe(
      false,
    );
    expect(
      policySchema.safeParse({ ...base, approval_rules: [{ paths: ["src/calc/**"], reason: "x" }] })
        .success,
    ).toBe(true);
    expect(
      policySchema.safeParse({ ...base, approval_rules: [{ kinds: ["migration"], reason: "x" }] })
        .success,
    ).toBe(true);
  });

  it("承認ルールに id は書けない。下限の規則を名乗って例外に紛れ込ませないため", () => {
    const result = policySchema.safeParse({
      version: 1,
      limits: { wip: 1, daily_starts: 1, max_diff_lines: 100 },
      approval_rules: [{ id: "lockfile-and-manifest", paths: ["x/**"], reason: "x" }],
    });

    expect(result.success).toBe(false);
  });

  it("設計の例をそのまま読める", () => {
    const parsed = policySchema.parse({
      version: 1,
      presets: ["base", "example-c"],
      profile_presets: ["example-a", "example-b"],
      auto_merge: ["deps", "lint", "docs", "flaky", "refactor"],
      approval_rules: [
        { paths: ["src/calc/**"], reason: "重要な計算" },
        { kinds: ["migration"], reason: "永続データの形式" },
      ],
      discovery: {
        failing_tests: true,
        doctor: true,
        lint_warnings: true,
        todo: true,
        roadmap: { path: "docs/roadmap.md", charter: "docs/charter.md" },
      },
      holdout: { review: "auto" },
      criteria: { review: "auto" },
      release: "human",
      limits: { wip: 3, daily_starts: 5, max_diff_lines: 400 },
      actor: { auth: "subscription", api_monthly_cap_usd: null },
    });

    expect(parsed.discovery.roadmap).toEqual({
      path: "docs/roadmap.md",
      charter: "docs/charter.md",
    });
  });
});

describe("profile.yaml のスキーマ", () => {
  it("オーナーの ID は正の整数でなければならない", () => {
    // 設計の例の `github_user_id: 0` はそのままでは通らない。誰の Issue も Goal に
    // ならない設定で黙って回るより、書き忘れとして落とす。
    const result = profileSchema.safeParse({
      version: 1,
      owner: { github_user_id: 0 },
      max: { limits: { wip: 1, daily_starts: 1, max_diff_lines: 1 } },
    });

    expect(result.success).toBe(false);
  });

  it("fleet の repo は owner/name の形だけ", () => {
    const result = profileSchema.safeParse({
      version: 1,
      owner: { github_user_id: 1 },
      fleet: [{ repo: "not-a-repo", since: "2000-02-01" }],
      max: { limits: { wip: 1, daily_starts: 1, max_diff_lines: 1 } },
    });

    expect(result.success).toBe(false);
  });

  it("既定では release の自動も API キーも許さない", () => {
    const parsed = profileSchema.parse({
      version: 1,
      owner: { github_user_id: 1 },
      max: { limits: { wip: 1, daily_starts: 1, max_diff_lines: 1 } },
    });

    expect(parsed.allow).toEqual({ release_auto: false, api_key: false });
    expect(parsed.notify.channel).toBe("github");
  });
});

describe("プロファイルとポリシーを合わせる", () => {
  it("承認ルールは下限・プロファイル・ポリシーの順に全部足す", () => {
    const result = composePolicy(
      profile({ approval_rules: [{ paths: ["src/calc/**"], reason: "重要な計算" }] }),
      policy({ approval_rules: [{ kinds: ["migration"], reason: "永続データの形式" }] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reasons = result.policy.approvalRules.map((rule) => rule.reason);
    expect(reasons).toEqual([
      ...APPROVAL_RULE_FLOOR.map((rule) => rule.reason),
      "重要な計算",
      "永続データの形式",
    ]);
  });

  it("プロファイルが許していない種別を auto_merge に書くと落ちる", () => {
    const result = composePolicy(
      profile({
        max: {
          auto_merge: ["docs"],
          limits: { wip: 5, daily_starts: 10, max_diff_lines: 800 },
          discovery: [...DISCOVERY_SOURCES],
        },
      }),
      policy({ auto_merge: ["docs", "feat"] }),
    );

    expect(result).toEqual({
      ok: false,
      violations: [{ code: "auto_merge_not_allowed", kinds: ["feat"] }],
    });
  });

  it("上限はプロファイルの最大値を越えられない", () => {
    const result = composePolicy(
      profile(),
      policy({ limits: { wip: 6, daily_starts: 5, max_diff_lines: 801 } }),
    );

    expect(result).toEqual({
      ok: false,
      violations: [
        { code: "limit_exceeds_max", key: "wip", value: 6, max: 5 },
        { code: "limit_exceeds_max", key: "max_diff_lines", value: 801, max: 800 },
      ],
    });
  });

  it("プロファイルが出どころを絞っていれば、その外は有効にできない", () => {
    const result = composePolicy(
      profile({
        max: {
          auto_merge: [],
          limits: { wip: 5, daily_starts: 10, max_diff_lines: 800 },
          discovery: ["failing_tests"],
        },
      }),
      policy({ auto_merge: [], discovery: { failing_tests: true, todo: true } }),
    );

    expect(result).toEqual({
      ok: false,
      violations: [{ code: "discovery_not_allowed", sources: ["todo"] }],
    });
  });

  it("プロファイルが出どころの上限を省くと、どれも有効にできない", () => {
    // auto_merge と同じく、上限を書き忘れたら閉じる側に倒す。
    const { discovery: _omitted, ...max } = profile().max;
    const narrowed = profile({ max });

    expect(narrowed.max.discovery).toEqual([]);
    expect(composePolicy(narrowed, policy({ auto_merge: [] }))).toEqual({
      ok: false,
      violations: [
        {
          code: "discovery_not_allowed",
          sources: ["failing_tests", "doctor", "lint_warnings", "todo"],
        },
      ],
    });
  });

  it("roadmap を有効にしたポリシーは、プロファイルが roadmap を許していなければ落ちる", () => {
    const result = composePolicy(
      profile({
        max: {
          auto_merge: [],
          limits: { wip: 5, daily_starts: 10, max_diff_lines: 800 },
          discovery: ["todo"],
        },
      }),
      policy({
        auto_merge: [],
        discovery: { todo: true, roadmap: { path: "docs/roadmap.md" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      violations: [{ code: "discovery_not_allowed", sources: ["roadmap"] }],
    });
  });

  it("holdout・受け入れ条件・深さ・release・roadmap は、ポリシーの値をそのまま渡す", () => {
    // 同じ型の項目（holdout と criteria）を取り違えても型は通るので、値で確かめる。
    const merged = effective(
      { allow: { release_auto: true } },
      {
        holdout: { review: "sample" },
        criteria: { review: "none" },
        review_depth: "deep",
        release: "auto",
        discovery: { roadmap: { path: "docs/roadmap.md", charter: "docs/charter.md" } },
      },
    );

    expect(merged.holdout).toBe("sample");
    expect(merged.criteria).toBe("none");
    expect(merged.reviewDepth).toBe("deep");
    expect(merged.release).toBe("auto");
    expect(merged.roadmap).toEqual({ path: "docs/roadmap.md", charter: "docs/charter.md" });
    expect(effective({}, { discovery: { roadmap: { path: "docs/roadmap.md" } } }).roadmap).toEqual({
      path: "docs/roadmap.md",
      charter: null,
    });
  });

  it("release: auto はプロファイルが許したときだけ", () => {
    expect(composePolicy(profile(), policy({ release: "auto" }))).toEqual({
      ok: false,
      violations: [{ code: "release_auto_not_allowed" }],
    });
    expect(
      composePolicy(profile({ allow: { release_auto: true } }), policy({ release: "auto" })).ok,
    ).toBe(true);
  });

  it("API キーはプロファイルが許し、月額の上限を書いたときだけ", () => {
    expect(composePolicy(profile(), policy({ actor: { auth: "api_key" } }))).toEqual({
      ok: false,
      violations: [{ code: "api_key_not_allowed" }, { code: "api_key_without_cap" }],
    });

    const allowed = profile({ allow: { api_key: true } });
    expect(composePolicy(allowed, policy({ actor: { auth: "api_key" } }))).toEqual({
      ok: false,
      violations: [{ code: "api_key_without_cap" }],
    });

    const result = composePolicy(
      allowed,
      policy({ actor: { auth: "api_key", api_monthly_cap_usd: 20 } }),
    );
    expect(result.ok && result.policy.actor).toEqual({ auth: "api_key", monthlyCapUsd: 20 });
  });

  it("違反は1つ目で止めず、全部返す", () => {
    const result = composePolicy(
      profile({
        max: { auto_merge: [], limits: { wip: 1, daily_starts: 1, max_diff_lines: 1 } },
      }),
      policy({ release: "auto", auto_merge: ["docs"] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "auto_merge_not_allowed",
      "limit_exceeds_max",
      "limit_exceeds_max",
      "limit_exceeds_max",
      // 出どころの上限を省いたので、ポリシーが有効にした出どころも違反になる
      "discovery_not_allowed",
      "release_auto_not_allowed",
    ]);
  });

  it("Renovate の App が無いプロファイルでは、依存更新の例外の前提が空になる", () => {
    const result = composePolicy(profile({ renovate: undefined }), policy());

    expect(result.ok && result.policy.renovateAppId).toBeNull();
  });
});

describe("合わせた結果の性質", () => {
  const kinds = fc.subarray([...AUTO_MERGEABLE_KINDS]);
  const limit = fc.integer({ min: 1, max: 20 });
  const limits = fc.record({ wip: limit, daily_starts: limit, max_diff_lines: limit });
  const sources = fc.subarray([...DISCOVERY_SOURCES]);
  const rules = fc.array(
    fc.record({ paths: fc.constant(["any/**"]), reason: fc.string({ minLength: 1 }) }),
    { maxLength: 3 },
  );

  const arbitraryProfile = fc
    .record({
      max: fc.record({ auto_merge: kinds, limits, discovery: sources }),
      approval_rules: rules,
      allow: fc.record({ release_auto: fc.boolean(), api_key: fc.boolean() }),
    })
    .map((overrides) => profile(overrides));

  const arbitraryPolicy = fc
    .record({
      auto_merge: kinds,
      limits,
      approval_rules: rules,
      release: fc.constantFrom("human", "auto"),
      discovery: fc.record({
        failing_tests: fc.boolean(),
        doctor: fc.boolean(),
        lint_warnings: fc.boolean(),
        todo: fc.boolean(),
        ai_review: fc.boolean(),
      }),
      actor: fc.oneof(
        fc.constant({ auth: "subscription" }),
        fc.record({
          auth: fc.constant("api_key"),
          api_monthly_cap_usd: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
        }),
      ),
    })
    .map((overrides) => policy(overrides));

  it("通った結果は、どの値もプロファイルの範囲の中にある", () => {
    fc.assert(
      fc.property(arbitraryProfile, arbitraryPolicy, (p, q) => {
        const result = composePolicy(p, q);
        if (!result.ok) return true;
        const merged = result.policy;
        const max = new Set(p.max.auto_merge);
        const allowedSources = new Set(p.max.discovery);
        return (
          merged.autoMerge.every((kind) => max.has(kind)) &&
          merged.limits.wip <= p.max.limits.wip &&
          merged.limits.daily_starts <= p.max.limits.daily_starts &&
          merged.limits.max_diff_lines <= p.max.limits.max_diff_lines &&
          [...merged.discovery].every((source) => allowedSources.has(source)) &&
          (merged.release === "human" || p.allow.release_auto) &&
          (merged.actor.auth === "subscription" || p.allow.api_key)
        );
      }),
    );
  });

  it("下限はどの組み合わせでも先頭に全部残る", () => {
    fc.assert(
      fc.property(arbitraryProfile, arbitraryPolicy, (p, q) => {
        const result = composePolicy(p, q);
        if (!result.ok) return true;
        return APPROVAL_RULE_FLOOR.every((rule, i) => result.policy.approvalRules[i] === rule);
      }),
    );
  });

  it("ポリシーが範囲の中なら必ず通り、外なら必ず落ちる", () => {
    // 丸めて通す経路を作らない。通るか落ちるかは、範囲の中かどうかだけで決まる。
    fc.assert(
      fc.property(arbitraryProfile, arbitraryPolicy, (p, q) => {
        const max = new Set(p.max.auto_merge);
        const allowedSources = new Set(p.max.discovery);
        const enabled = DISCOVERY_SOURCES.filter((source) =>
          source === "roadmap" ? q.discovery.roadmap !== false : q.discovery[source],
        );
        const within =
          q.auto_merge.every((kind) => max.has(kind)) &&
          q.limits.wip <= p.max.limits.wip &&
          q.limits.daily_starts <= p.max.limits.daily_starts &&
          q.limits.max_diff_lines <= p.max.limits.max_diff_lines &&
          enabled.every((source) => allowedSources.has(source)) &&
          (q.release === "human" || p.allow.release_auto) &&
          (q.actor.auth === "subscription" ||
            (p.allow.api_key && q.actor.api_monthly_cap_usd !== null));
        return composePolicy(p, q).ok === within;
      }),
    );
  });
});
