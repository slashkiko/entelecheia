import { createHash } from "node:crypto";
import type { EvidenceReport } from "@entelecheia/core/factory/evidence-report.js";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  type CheckRun,
  type CheckRunSource,
  type EvidenceRequest,
  evidenceSummary,
  fetchEvidence,
  MAX_EVIDENCE_BYTES,
  type RunArtifact,
} from "../src/evidence.js";
import { zipOf } from "./zip-fixture.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CHECKER = "c".repeat(40);
const OLD_CHECKER = "f".repeat(40);
const WORKFLOW = "example-owner/entelecheia/.github/workflows/check.yml";

const REQUEST: EvidenceRequest = {
  repo: "example-owner/sample-shop",
  pr: 7,
  headSha: HEAD,
  baseSha: BASE,
  checker: { workflow: WORKFLOW, shas: [CHECKER] },
};

/** 上限をかけた後の、E1 の報告の形 */
const E1_SUMMARY = { level: "E1", typesChanged: false, snapshotsChanged: false };

function report(overrides: Partial<EvidenceReport> = {}): EvidenceReport {
  return {
    schema: "ent.evidence/v1",
    repo: "example-owner/sample-shop",
    pr: 7,
    head_sha: HEAD,
    base_sha: BASE,
    check_definition_sha: BASE,
    checker_sha: CHECKER,
    level: "E1",
    results: [{ layer: "E1", rule_id: "verify", status: "pass", location: null, fix_hint: null }],
    tests: { before: 3, after: 3, new_skips: 0 },
    surface: { types_changed: false, snapshots_changed: false },
    holdout: null,
    review: null,
    generated_at: "2000-01-31T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 100,
    headSha: HEAD,
    event: "pull_request",
    status: "completed",
    createdAt: "2000-01-31T00:00:00Z",
    runStartedAt: "2000-01-31T00:00:00Z",
    headRepository: "example-owner/sample-shop",
    referencedWorkflows: [{ path: `${WORKFLOW}@${CHECKER}`, sha: CHECKER }],
    ...overrides,
  };
}

function archiveOf(body: unknown): Buffer {
  return zipOf([{ name: "evidence.json", content: JSON.stringify(body) }]);
}

function artifact(archive: Buffer, overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    id: 500,
    name: "ent-evidence",
    expired: false,
    sizeInBytes: archive.length,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    createdAt: "2000-01-31T00:10:00Z",
    ...overrides,
  };
}

type FakeSource = { [K in keyof CheckRunSource]: Mock<CheckRunSource[K]> };

/**
 * run と artifact を持つ偽の口。artifact は run の id ごとに置く。名前では絞らずに返すので、
 * 名前で絞るのは fetchEvidence の側になる
 */
function source(
  runs: CheckRun[],
  artifacts: Record<number, { meta: RunArtifact; archive: Buffer }[]> = {},
): FakeSource {
  const byId = new Map(
    Object.values(artifacts)
      .flat()
      .map((entry) => [entry.meta.id, entry.archive]),
  );
  return {
    listRuns: vi.fn(async () => runs),
    listArtifacts: vi.fn(async (runId: number) =>
      (artifacts[runId] ?? []).map((entry) => entry.meta),
    ),
    download: vi.fn(async (id: number) => {
      const archive = byId.get(id);
      if (archive === undefined) throw new Error(`no artifact ${id}`);
      return { status: "ok" as const, data: archive };
    }),
  };
}

function withReport(body: unknown, runOverrides: Partial<CheckRun> = {}) {
  const archive = archiveOf(body);
  const theRun = run(runOverrides);
  return source([theRun], { [theRun.id]: [{ meta: artifact(archive), archive }] });
}

describe("evidence.json の取り出し", () => {
  it("固定した検査の run が残した報告を受け取る", async () => {
    const fake = withReport(report());

    const outcome = await fetchEvidence(fake, REQUEST);

    expect(outcome).toEqual({ status: "found", report: report(), summary: E1_SUMMARY, runId: 100 });
    expect(fake.listRuns).toHaveBeenCalledWith(HEAD);
    expect(fake.listArtifacts).toHaveBeenCalledWith(100, "ent-evidence");
    expect(fake.download).toHaveBeenCalledWith(500, MAX_EVIDENCE_BYTES);
  });

  it("名前の違う artifact は数えない", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], {
      100: [
        { meta: artifact(archive, { id: 499, name: "coverage" }), archive },
        { meta: artifact(archive), archive },
      ],
    });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({ status: "found" });
    expect(fake.download).toHaveBeenCalledWith(500, MAX_EVIDENCE_BYTES);
  });

  it("リポジトリと検査の名前は、大文字と小文字を区別しない", async () => {
    // GitHub の owner と repo の名前は大文字と小文字を区別しない。設定と記録で書き方が違いうる
    const outcome = await fetchEvidence(withReport(report({ repo: "Example-Owner/Sample-Shop" })), {
      ...REQUEST,
      repo: "EXAMPLE-OWNER/sample-shop",
      checker: { workflow: WORKFLOW.toUpperCase(), shas: [CHECKER] },
    });

    expect(outcome).toMatchObject({ status: "found" });
  });

  it("run がまだ無ければ待つ", async () => {
    expect(await fetchEvidence(source([]), REQUEST)).toEqual({
      status: "pending",
      reason: { code: "no_run" },
    });
  });

  it.each([
    ["別の head の", { headSha: "d".repeat(40) }],
    ["pull_request 以外から起きた", { event: "pull_request_target" }],
    [
      "検査を呼ばない",
      {
        referencedWorkflows: [
          { path: "example-owner/other/.github/workflows/ci.yml@main", sha: CHECKER },
        ],
      },
    ],
    [
      "名前が前方だけ一致する別のワークフローを呼ぶ",
      { referencedWorkflows: [{ path: `${WORKFLOW}.bak@${CHECKER}`, sha: CHECKER }] },
    ],
    // 同じ commit を head にした PR を fork から開くと、その run も同じ head の sha で並ぶ。
    // 数えると、外の人が run を足すだけで受け取りを止められる
    ["fork から来た", { headRepository: "someone-else/sample-shop" }],
    ["消えた fork から来た", { headRepository: null }],
  ])("%s run は数えない", async (_label, overrides) => {
    const outcome = await fetchEvidence(withReport(report(), overrides), REQUEST);

    expect(outcome).toEqual({ status: "pending", reason: { code: "no_run" } });
  });

  it("終わっていない run があれば、終わった run の報告も読まずに待つ", async () => {
    // 回し直した run を待たずに古い報告を読むと、回し直した理由（flaky、runner の不調）を無視する
    const archive = archiveOf(report());
    const runs = [
      run(),
      run({ id: 101, status: "in_progress", createdAt: "2000-01-31T01:00:00Z" }),
    ];
    const fake = source(runs, { 100: [{ meta: artifact(archive), archive }] });

    expect(await fetchEvidence(fake, REQUEST)).toEqual({
      status: "pending",
      reason: { code: "run_in_progress", runIds: [101] },
    });
    expect(fake.download).not.toHaveBeenCalled();
  });

  it("終わった run が複数あれば、いちばん新しいものを読む", async () => {
    const stale = archiveOf(report({ base_sha: "d".repeat(40) }));
    const fresh = archiveOf(report());
    const fake = source([run({ id: 100 }), run({ id: 101, createdAt: "2000-01-31T01:00:00Z" })], {
      100: [{ meta: artifact(stale, { id: 500 }), archive: stale }],
      101: [{ meta: artifact(fresh, { id: 501 }), archive: fresh }],
    });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({ status: "found", runId: 101 });
  });

  it("run が固定した sha と違う sha の検査を呼んでいたら受け取らない", async () => {
    // 呼ぶ側が uses: だけを上げ、entelecheia-sha を古いままにした形。報告の checker_sha は
    // 固定した sha のままなので、run の記録を見ないと気づけない
    const other = "e".repeat(40);
    const outcome = await fetchEvidence(
      withReport(report(), { referencedWorkflows: [{ path: `${WORKFLOW}@${other}`, sha: other }] }),
      REQUEST,
    );

    expect(outcome).toEqual({
      status: "rejected",
      reason: { code: "checker_mismatch", expected: [CHECKER], actual: [other] },
      runId: 100,
    });
  });

  it("検査の sha を上げる間は、古い sha の run も受け取る", async () => {
    // governor と呼ぶ側のリポジトリは、別々の PR で sha を上げる
    const outcome = await fetchEvidence(
      withReport(report({ checker_sha: OLD_CHECKER }), {
        referencedWorkflows: [{ path: `${WORKFLOW}@${OLD_CHECKER}`, sha: OLD_CHECKER }],
      }),
      { ...REQUEST, checker: { workflow: WORKFLOW, shas: [OLD_CHECKER, CHECKER] } },
    );

    expect(outcome).toMatchObject({ status: "found" });
  });

  it("報告の checker_sha が、run の呼んだ sha と違えば受け取らない", async () => {
    // 呼ぶ側が uses: と entelecheia-sha を違う sha にした形。どちらも受け取る sha のうちでも落とす
    const outcome = await fetchEvidence(
      withReport(report({ checker_sha: CHECKER }), {
        referencedWorkflows: [{ path: `${WORKFLOW}@${OLD_CHECKER}`, sha: OLD_CHECKER }],
      }),
      { ...REQUEST, checker: { workflow: WORKFLOW, shas: [OLD_CHECKER, CHECKER] } },
    );

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "report_mismatch", field: "checker_sha", expected: OLD_CHECKER },
    });
  });

  it("1つの run が検査を2つの sha で呼んでいたら受け取らない", async () => {
    const other = "e".repeat(40);
    const outcome = await fetchEvidence(
      withReport(report(), {
        referencedWorkflows: [
          { path: `${WORKFLOW}@${CHECKER}`, sha: CHECKER },
          { path: `${WORKFLOW}@${other}`, sha: other },
        ],
      }),
      REQUEST,
    );

    expect(outcome).toMatchObject({ status: "rejected", reason: { code: "checker_mismatch" } });
  });

  it("artifact が無ければ、報告が無いと言う", async () => {
    // ent-check が 3（検査できなかった）で終わると evidence.json を書かず、artifact も無い
    expect(await fetchEvidence(source([run()]), REQUEST)).toEqual({
      status: "missing",
      reason: { code: "no_artifact" },
      runId: 100,
    });
  });

  it("期限の切れた artifact は読まない", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], {
      100: [{ meta: artifact(archive, { expired: true }), archive }],
    });

    expect(await fetchEvidence(fake, REQUEST)).toEqual({
      status: "missing",
      reason: { code: "artifact_expired", artifactId: 500 },
      runId: 100,
    });
    expect(fake.download).not.toHaveBeenCalled();
  });

  it("同じ名前の artifact が2つあれば受け取らない", async () => {
    // どちらが ent-check の書いたものか決められない
    const archive = archiveOf(report());
    const fake = source([run()], {
      100: [
        { meta: artifact(archive, { id: 500 }), archive },
        { meta: artifact(archive, { id: 501 }), archive },
      ],
    });

    expect(await fetchEvidence(fake, REQUEST)).toEqual({
      status: "rejected",
      reason: { code: "multiple_artifacts", artifactIds: [500, 501] },
      runId: 100,
    });
  });

  it.each([
    ["前の attempt で作った", "1999-12-31T00:00:00Z"],
    ["作った時刻の分からない", null],
  ])("%s artifact は、いまの attempt の報告として読まない", async (_label, createdAt) => {
    // 回し直しても前の attempt の artifact は残る。いまの attempt が ent-check より先に落ちると、
    // それだけが見える
    const archive = archiveOf(report());
    const fake = source([run()], { 100: [{ meta: artifact(archive, { createdAt }), archive }] });

    expect(await fetchEvidence(fake, REQUEST)).toEqual({
      status: "missing",
      reason: { code: "artifact_from_earlier_attempt", artifactId: 500 },
      runId: 100,
    });
    expect(fake.download).not.toHaveBeenCalled();
  });

  it("上限を超える artifact は取りにいかない", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], {
      100: [{ meta: artifact(archive, { sizeInBytes: MAX_EVIDENCE_BYTES + 1 }), archive }],
    });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({
      status: "rejected",
      reason: { code: "artifact_too_large" },
    });
    expect(fake.download).not.toHaveBeenCalled();
  });

  it("取ってみて上限を超えたときも、一覧で超えたときと同じに扱う", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], { 100: [{ meta: artifact(archive), archive }] });
    fake.download.mockResolvedValue({ status: "too_large", bytes: null });

    expect(await fetchEvidence(fake, REQUEST)).toEqual({
      status: "rejected",
      reason: { code: "artifact_too_large", bytes: null },
      runId: 100,
    });
  });

  it("中身が artifact の digest と合わなければ受け取らない", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], {
      100: [{ meta: artifact(archive, { digest: `sha256:${"0".repeat(64)}` }), archive }],
    });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({
      status: "rejected",
      reason: { code: "digest_mismatch" },
    });
  });

  it("digest の無い古い artifact も読む", async () => {
    const archive = archiveOf(report());
    const fake = source([run()], { 100: [{ meta: artifact(archive, { digest: null }), archive }] });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({ status: "found" });
  });

  it("zip が壊れていれば受け取らない", async () => {
    const archive = Buffer.from("not a zip");
    const fake = source([run()], { 100: [{ meta: artifact(archive), archive }] });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({
      status: "rejected",
      reason: { code: "bad_archive" },
    });
  });

  it("JSON でなければ受け取らない", async () => {
    const archive = zipOf([{ name: "evidence.json", content: "{" }]);
    const fake = source([run()], { 100: [{ meta: artifact(archive), archive }] });

    expect(await fetchEvidence(fake, REQUEST)).toMatchObject({
      status: "rejected",
      reason: { code: "bad_report", detail: expect.stringContaining("not JSON") },
    });
  });

  it("level を results より上げた報告は受け取らない", async () => {
    // 読む側は level だけで判定する。schema の一致の検査を読む側でも通す
    const forged = report({
      level: "E1",
      results: [{ layer: "E1", rule_id: "verify", status: "fail", location: null, fix_hint: null }],
    });

    expect(await fetchEvidence(withReport(forged), REQUEST)).toMatchObject({
      status: "rejected",
      reason: { code: "bad_report", detail: expect.stringContaining("level") },
    });
  });

  it.each([
    ["repo", { repo: "example-owner/other-app" }, "example-owner/other-app"],
    ["pr", { pr: 8 }, "8"],
    ["head_sha", { head_sha: "d".repeat(40) }, "d".repeat(40)],
    ["checker_sha", { checker_sha: "e".repeat(40) }, "e".repeat(40)],
    // 手元で回した報告（checker_sha が null）は、どの検査で作ったか分からない
    ["checker_sha", { checker_sha: null }, "null"],
  ] as const)("報告の %s が頼んだものと違えば受け取らない", async (field, overrides, actual) => {
    const outcome = await fetchEvidence(withReport(report(overrides)), REQUEST);

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "report_mismatch", field, actual },
    });
  });

  it("base が進んだ後の報告は、約束に反したのでなく古いと言う", async () => {
    // 報告は event が起きたときの base で作る。ほかの PR が merge されて base が進んでも、
    // head が変わらなければ検査は回り直さない
    const moved = "d".repeat(40);
    const outcome = await fetchEvidence(withReport(report()), { ...REQUEST, baseSha: moved });

    expect(outcome).toEqual({
      status: "stale",
      reason: { code: "base_moved", expected: moved, actual: BASE },
      runId: 100,
    });
  });
});

describe("判定に渡す形", () => {
  const E2_RESULTS: EvidenceReport["results"] = [
    { layer: "E1", rule_id: "verify", status: "pass", location: null, fix_hint: null },
    { layer: "E2", rule_id: "contract", status: "pass", location: null, fix_hint: null },
  ];

  it("head を流したジョブの報告は E1 に抑える", async () => {
    // 同じジョブで動いた head のコードは、報告も artifact も差し替えられる。E2 を数えると、
    // 振る舞いを変えない種別の自動マージに、偽った報告で届く
    const outcome = await fetchEvidence(
      withReport(report({ level: "E2", results: E2_RESULTS })),
      REQUEST,
    );

    expect(outcome).toMatchObject({ status: "found", summary: E1_SUMMARY });
    expect(evidenceSummary(outcome)).toEqual(E1_SUMMARY);
  });

  it("E1 に届かない報告はそのまま渡す", async () => {
    const failed = report({
      level: "E0",
      results: [{ layer: "E1", rule_id: "verify", status: "fail", location: null, fix_hint: null }],
    });

    expect(evidenceSummary(await fetchEvidence(withReport(failed), REQUEST))?.level).toBe("E0");
  });

  it.each([
    { status: "pending", reason: { code: "no_run" } },
    {
      status: "stale",
      reason: { code: "base_moved", expected: BASE, actual: "d".repeat(40) },
      runId: 100,
    },
    { status: "missing", reason: { code: "no_artifact" }, runId: 100 },
    { status: "rejected", reason: { code: "digest_mismatch" }, runId: 100 },
  ] as const)("受け取れなかった報告（$status）は、エビデンスが無いと同じに扱う", (outcome) => {
    expect(evidenceSummary(outcome)).toBeNull();
  });
});
