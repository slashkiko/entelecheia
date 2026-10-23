import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type EvidenceReport,
  type EvidenceResult,
  evidenceReportSchema,
  levelOf,
  summarizeEvidence,
} from "../src/factory/evidence-report.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function report(overrides: Partial<EvidenceReport> = {}): EvidenceReport {
  return {
    schema: "ent.evidence/v1",
    repo: "example-owner/example-app",
    pr: 12,
    head_sha: HEAD,
    base_sha: BASE,
    check_definition_sha: BASE,
    level: "E1",
    results: [result("verify", "pass")],
    tests: { before: 3, after: 4, new_skips: 0 },
    surface: { types_changed: null, snapshots_changed: false },
    holdout: null,
    review: null,
    generated_at: "2000-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function result(
  ruleId: string,
  status: EvidenceResult["status"],
  layer: EvidenceResult["layer"] = "E1",
): EvidenceResult {
  return { layer, rule_id: ruleId, status, location: null, fix_hint: null };
}

describe("evidence.json の形", () => {
  it("揃った報告は通る", () => {
    expect(evidenceReportSchema.safeParse(report()).success).toBe(true);
  });

  it("知らないキーを足した報告は通らない", () => {
    // 読む側が知らないキーを黙って捨てると、書く側が足した検査の結果が判定に届かない。
    expect(evidenceReportSchema.safeParse({ ...report(), extra: true }).success).toBe(false);
  });

  it.each([
    ["schema のバージョンが違う", { schema: "ent.evidence/v2" }],
    ["sha が短い", { head_sha: "abc1234" }],
    ["件数が負", { tests: { before: -1, after: 0, new_skips: 0 } }],
    ["repo に owner が無い", { repo: "example-app" }],
    ["時刻に時差が無い", { generated_at: "2000-01-02 03:04:05" }],
  ])("%s報告は通らない", (_label, overrides) => {
    expect(evidenceReportSchema.safeParse({ ...report(), ...overrides }).success).toBe(false);
  });

  it("落ちた規則の層まで level を上げた報告は通らない", () => {
    const inconsistent = report({ level: "E1", results: [result("verify", "fail")] });

    expect(evidenceReportSchema.safeParse(inconsistent).success).toBe(false);
  });

  it("落ちた規則より下の level なら通る", () => {
    const consistent = report({ level: "E0", results: [result("verify", "fail")] });

    expect(evidenceReportSchema.safeParse(consistent).success).toBe(true);
  });

  it.each([
    ["回していない層まで上げた", { level: "E4" as const }],
    ["規則が1つも無いのに上げた", { level: "E1" as const, results: [] }],
    ["skip のある層まで上げた", { level: "E1" as const, results: [result("test-report", "skip")] }],
  ])("%s報告は通らない", (_label, overrides) => {
    // 読む側は level だけで判定するので、results から決まる値と食い違えば受け取らない。
    expect(evidenceReportSchema.safeParse(report(overrides)).success).toBe(false);
  });

  it("JSON Schema はこの schema から作ったものと一致する", async () => {
    // JSON Schema を手で直すと、zod の schema と食い違ったまま配られる。
    // 直すときは zod の側を直し、`vitest -u` で JSON Schema を作り直す。
    const schema = z.toJSONSchema(evidenceReportSchema, { target: "draft-2020-12" });

    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      "../schema/evidence-v1.schema.json",
    );
  });
});

describe("結果から届く段階", () => {
  it("規則が1つも無ければ E0", () => {
    expect(levelOf([])).toBe("E0");
  });

  it("E1 の規則が全部通れば E1", () => {
    expect(levelOf([result("verify", "pass"), result("test-count-dropped", "pass")])).toBe("E1");
  });

  it.each(["fail", "skip"] as const)("E1 の規則が1つでも %s なら E0", (status) => {
    // skip を通ったと数えると、報告が読めずに飛ばした検査で段階が上がる。
    expect(levelOf([result("verify", "pass"), result("test-count-dropped", status)])).toBe("E0");
  });

  it("隔離した結果は数えない", () => {
    expect(levelOf([result("verify", "pass"), result("flaky-case", "quarantined")])).toBe("E1");
  });

  it("下の層を飛ばして上の層に届かない", () => {
    expect(levelOf([result("contract", "pass", "E2")])).toBe("E0");
  });

  it("下の層が通っていれば上の層に届く", () => {
    expect(levelOf([result("verify", "pass"), result("contract", "pass", "E2")])).toBe("E2");
  });
});

describe("判定に渡す形", () => {
  it("読めなかった面は差分ありに倒す", () => {
    const summary = summarizeEvidence(
      report({ surface: { types_changed: null, snapshots_changed: null } }),
    );

    expect(summary).toEqual({ level: "E1", typesChanged: true, snapshotsChanged: true });
  });

  it.each([
    [
      { types_changed: true, snapshots_changed: false },
      { typesChanged: true, snapshotsChanged: false },
    ],
    [
      { types_changed: false, snapshots_changed: true },
      { typesChanged: false, snapshotsChanged: true },
    ],
    [
      { types_changed: false, snapshots_changed: null },
      { typesChanged: false, snapshotsChanged: true },
    ],
  ])("読めた面はそのまま渡す（%o）", (surface, expected) => {
    // 型とスナップショットを取り違えても、どちらかが違う値なら分かる。
    expect(summarizeEvidence(report({ surface }))).toEqual({ level: "E1", ...expected });
  });
});
