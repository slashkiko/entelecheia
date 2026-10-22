import { describe, expect, it } from "vitest";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";
import { toVerifications } from "../src/domain/verification.js";

/**
 * design.md §4.5 の Verification。§9 の完了判定は
 * 「全 criteria の Verification.result が passed」と書かれているのに、
 * criteria 単位の索引が実装に無かった。
 *
 * 検証そのものは src/verify/ が持つ。ここは1ティックの結果を並べ直すだけで、
 * もう一度検証はしない。二重に検証すると、同じティックで結果が食い違う余地が出る。
 */

const AT = "2026-08-09T05:00:00.000Z";

function criterion(id: string): AcceptanceCriterion {
  return { id, description: id, verification: { type: "command", run: "mise run test" } };
}

function passedFact(id: string, value: boolean): Fact {
  return {
    key: `criteria.${id}.passed`,
    value,
    observedAt: AT,
    confidence: "VERIFIED",
    evidence: { source: "mise run test", detail: `exit_code=${value ? 0 : 1}` },
  };
}

function pending(id: string, detail: string): Unresolved {
  return { key: `criteria.${id}.passed`, reason: "pending", detail };
}

describe("toVerifications", () => {
  it("VERIFIED な true は passed", () => {
    const [verification] = toVerifications([criterion("ac-1")], [passedFact("ac-1", true)], [], AT);

    expect(verification).toEqual({
      criterionId: "ac-1",
      result: "passed",
      reason: null,
      evidence: { source: "mise run test", detail: "exit_code=0" },
      detail: "exit_code=0",
      verifiedAt: AT,
    });
  });

  it("同じ criterion に Fact と unresolved が両方あれば unresolved を採る", () => {
    // reconcile は前ティックの Fact を土台に今ティックの観測を重ねるので、
    // 今ティック検証できなかった criterion にも前ティックの passed: true が残る。
    // Fact を先に引いていたころは、それを今ティックの結果として 🟢 passed と
    // 表示していた。人間が読む索引が「確かめられなかった」を「合格」に畳んでいた。
    const [verification] = toVerifications(
      [criterion("ac-1")],
      [passedFact("ac-1", true)],
      [pending("ac-1", "今ティックは検証できなかった")],
      AT,
    );

    expect(verification?.result).toBe("unresolved");
    expect(verification?.reason).toBe("pending");
    expect(verification?.evidence).toBeNull();
    expect(verification?.detail).toBe("今ティックは検証できなかった");
  });

  it("VERIFIED な false は failed", () => {
    // 不合格も「検証できた」結果なので、unresolved には落とさない。
    const [verification] = toVerifications(
      [criterion("ac-1")],
      [passedFact("ac-1", false)],
      [],
      AT,
    );

    expect(verification?.result).toBe("failed");
    expect(verification?.reason).toBeNull();
  });

  it("unresolved に残っている criteria は unresolved", () => {
    const [verification] = toVerifications(
      [criterion("ac-5")],
      [],
      [pending("ac-5", "github.ci.conclusion が VERIFIED な Fact として観測されていない")],
      AT,
    );

    expect(verification?.result).toBe("unresolved");
    expect(verification?.reason).toBe("pending");
    expect(verification?.evidence).toBeNull();
    expect(verification?.detail).toContain("github.ci.conclusion");
  });

  it("port_failed の理由をそのまま残す", () => {
    const [verification] = toVerifications(
      [criterion("ac-1")],
      [],
      [{ key: "criteria.ac-1.passed", reason: "port_failed", detail: "setup が失敗した" }],
      AT,
    );

    expect(verification?.result).toBe("unresolved");
    expect(verification?.reason).toBe("port_failed");
  });

  it("Fact も unresolved も無ければ unresolved にする", () => {
    // 結論が出なかったことを合格にも不合格にも畳まない（design.md §3.1）。
    const [verification] = toVerifications([criterion("ac-9")], [], [], AT);

    expect(verification?.result).toBe("unresolved");
    expect(verification?.reason).toBe("pending");
  });

  it("INFERRED な Fact では合否を出さない", () => {
    // 完了判定に使ってよいのは VERIFIED だけ（design.md §3.1）。
    const inferred: Fact = {
      key: "criteria.ac-1.passed",
      value: true,
      observedAt: AT,
      confidence: "INFERRED",
    };
    const [verification] = toVerifications([criterion("ac-1")], [inferred], [], AT);

    expect(verification?.result).toBe("unresolved");
  });

  it("criteria の並び順を保つ", () => {
    // 人間が Goal YAML と突き合わせて読む。
    const results = toVerifications(
      [criterion("ac-1"), criterion("ac-2"), criterion("ac-3")],
      [passedFact("ac-2", true)],
      [],
      AT,
    );

    expect(results.map((v) => v.criterionId)).toEqual(["ac-1", "ac-2", "ac-3"]);
  });
});
