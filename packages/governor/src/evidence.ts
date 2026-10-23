import { createHash } from "node:crypto";
import type { EvidenceSummary } from "@entelecheia/core/factory/auto-merge.js";
import { type EvidenceLevel, reaches } from "@entelecheia/core/factory/evidence.js";
import {
  EVIDENCE_ARTIFACT_NAME,
  EVIDENCE_ATTESTATION_FILE_NAME,
  EVIDENCE_AUDIENCE_PREFIX,
  EVIDENCE_FILE_NAME,
  type EvidenceReport,
  evidenceReportSchema,
  summarizeEvidence,
} from "@entelecheia/core/factory/evidence-report.js";
import { type IdTokenClaims, type SigningKeys, verifyIdToken } from "./id-token.js";
import { ArchiveError, extractFiles } from "./zip.js";

/**
 * PR の head に対する検査の実行から、evidence.json を取り出して検める。
 *
 * **PR の中のファイルは読まない。** Actor が書いた evidence.json を信じないため、その sha に
 * 対して再利用ワークフロー（`check.yml`）が回った workflow run を探し、その run が残した
 * artifact だけを読む。run が別の sha の check.yml を呼んでいた、報告が別の PR や別の sha の
 * ものだった、形が崩れていた、のどれでも受け取らない。
 *
 * run の記録にある `uses:` の sha（`referenced_workflows`）が governor の受け取る sha の
 * どれかであり、報告に残った `checker_sha` がそれと同じであることを確かめる。evidence の
 * ジョブも、OIDC トークンにある呼ばれた sha と `entelecheia-sha` を比べてから ent-check を
 * 流す。ここでも比べるのは、check.yml の比較が後のバージョンで外れても、ここで止めるため。
 *
 * **artifact を上げたジョブも確かめる。** artifact を書くトークンは run の単位なので、同じ
 * run のどのジョブも `ent-evidence` の名前で上げられる。呼ぶ側のふつうの CI のジョブで流れた
 * head のコードもそこに入る。artifact には evidence.json と一緒に、それの digest を audience に
 * した OIDC トークン（`evidence.jwt`）が要る。トークンは GitHub が署名し、取れるのは
 * id-token: write を持つジョブだけで、check.yml の中でそれを持つのは head のコードを流さない
 * evidence のジョブだけになる。署名と、トークンのリポジトリ・run・attempt・呼ばれた
 * ワークフローとその sha を確かめる（`checkAttestation`）。
 */

/** 検査の実行の記録（workflow run）のうち、ここで読む分 */
export interface CheckRun {
  id: number;
  headSha: string;
  event: string;
  /** queued・in_progress・completed など。completed になるまで artifact は揃わない */
  status: string;
  createdAt: string;
  /** いまの attempt の番号。1 から始まり、run を回し直すと増える */
  runAttempt: number;
  /** head の branch があるリポジトリ（`<owner>/<name>`）。消えた fork では null */
  headRepository: string | null;
  /** その run が呼んだ再利用ワークフロー。`path` は `<owner>/<repo>/<file>@<ref>` */
  referencedWorkflows: { path: string; sha: string }[];
}

export interface RunArtifact {
  id: number;
  name: string;
  expired: boolean;
  sizeInBytes: number;
  /** `sha256:<hex>`。古い artifact には無い */
  digest: string | null;
}

/** artifact の zip を取った結果。上限を超えたら読むのをやめる。超えた大きさが分からなければ null */
export type ArtifactDownload =
  | { status: "ok"; data: Uint8Array }
  | { status: "too_large"; bytes: number | null };

/**
 * 検査の実行と artifact と、artifact に付いたトークンを確かめる鍵を読む口。GitHub の実装は
 * `github-actions.ts` にある。読めなかったときは PortError を投げる
 */
export interface CheckRunSource {
  /** その head の sha で、pull_request から起きた run */
  listRuns(headSha: string): Promise<CheckRun[]>;
  listArtifacts(runId: number, name: string): Promise<RunArtifact[]>;
  download(artifactId: number, maxBytes: number): Promise<ArtifactDownload>;
  signingKeys(): Promise<SigningKeys>;
}

export interface EvidenceRequest {
  /** `<owner>/<name>` */
  repo: string;
  pr: number;
  headSha: string;
  /** merge しようとしている base の sha。報告がこれと違う base で作られていれば古い */
  baseSha: string;
  /**
   * governor が受け取る検査。`workflow` は `<owner>/<repo>/.github/workflows/check.yml`。
   * 検査の sha を上げる間は、古い sha と新しい sha を両方置く。呼ぶ側のリポジトリは
   * それぞれの PR で sha を上げるので、1つに絞ると、上げ終わるまでの PR をどれも受け取れない。
   *
   * evidence.jwt を残さない古い check.yml の sha は置かない。置いても、その run は
   * `bad_archive` で落ちる（置かなければ `checker_mismatch` で落ちる）。古い sha と新しい sha を
   * 両方置くのは、どちらも evidence.jwt を残す sha のあいだだけにする
   */
  checker: { workflow: string; shas: readonly string[] };
}

/**
 * 結果は5つに分ける。次にすることが違うため。
 *
 * - found: 受け取った。判定には `summary` を渡す
 * - pending: まだ揃っていない。次のティックで見直す
 * - stale: 報告は、いまの base より前の base に対するもの。base を取り込んだ head を push して
 *   検査を回し直す。run を回し直すだけでは、event に残った base は変わらない
 * - missing: run は終わったが、いまの attempt の報告が無い。検査できなかった（ent-check の 3）か、
 *   ent-check より先に落ちた。トークンの鍵を GitHub が入れ替えた後もここに来る。回し直す。
 *   何回まで回すかは呼ぶ側が決める
 * - rejected: 約束に反する。push も merge もせず人に回し、監査ログに残す
 */
export type EvidenceOutcome =
  | {
      status: "found";
      /** 報告の `level` は検査の言い分のまま。判定には上限をかけた `summary` を使う */
      report: EvidenceReport;
      summary: EvidenceSummary;
      runId: number;
    }
  | { status: "pending"; reason: EvidenceReason }
  | { status: "stale"; reason: EvidenceReason; runId: number }
  | { status: "missing"; reason: EvidenceReason; runId: number }
  | { status: "rejected"; reason: EvidenceReason; runId: number };

export type EvidenceReason =
  | { code: "no_run" }
  | { code: "run_in_progress"; runIds: number[] }
  | { code: "no_artifact" }
  | { code: "artifact_expired"; artifactId: number }
  | { code: "artifact_from_earlier_attempt"; artifactId: number; attempt: string }
  | { code: "multiple_artifacts"; artifactIds: number[] }
  | { code: "checker_mismatch"; expected: string[]; actual: string[] }
  | { code: "artifact_too_large"; bytes: number | null }
  | { code: "digest_mismatch" }
  | { code: "base_moved"; expected: string; actual: string }
  | { code: "bad_archive"; detail: string }
  | { code: "bad_report"; detail: string }
  | { code: "report_mismatch"; field: ReportField; expected: string; actual: string }
  | { code: "attestation_key_unknown"; kid: string }
  | { code: "bad_attestation"; detail: string }
  | { code: "attestation_mismatch"; field: AttestationField; expected: string; actual: string };

type ReportField = "repo" | "pr" | "head_sha" | "checker_sha";
type AttestationField =
  | "aud"
  | "repository"
  | "run_id"
  | "event_name"
  | "job_workflow"
  | "job_workflow_sha"
  | "runner_environment";

/** zip と evidence.json の上限。報告はふつう数 KB で、落ちた場所を数千件並べても収まる */
export const MAX_EVIDENCE_BYTES = 1024 * 1024;

export async function fetchEvidence(
  source: CheckRunSource,
  request: EvidenceRequest,
): Promise<EvidenceOutcome> {
  // GitHub の owner と repo の名前は、大文字と小文字を区別しない
  const prefix = `${request.checker.workflow}@`.toLowerCase();
  const repo = request.repo.toLowerCase();
  const checkerCalls = (run: CheckRun) =>
    run.referencedWorkflows.filter((workflow) => workflow.path.toLowerCase().startsWith(prefix));
  const runs = (await source.listRuns(request.headSha)).filter(
    (run) =>
      run.headSha === request.headSha &&
      run.event === "pull_request" &&
      // fork から来た run は数えない。同じ commit を head にした PR を fork から開けば、その run も
      // ここに並ぶ。数えると、外の人が run を足すだけで受け取りを止められる
      run.headRepository?.toLowerCase() === repo &&
      checkerCalls(run).length > 0,
  );
  if (runs.length === 0) {
    // push の直後は run がまだ作られていない。無いままかどうかは呼ぶ側が時間で決める
    return { status: "pending", reason: { code: "no_run" } };
  }
  // 回し直しの run が残っていれば、それを待つ。先に終わった古い run の報告を読むと、
  // 人が回し直した理由（flaky、runner の不調）を無視することになる。承認待ち（waiting）の
  // まま止まった run も待つ。いつ諦めるかは、no_run と同じく呼ぶ側が時間で決める
  const running = runs.filter((run) => run.status !== "completed");
  if (running.length > 0) {
    return {
      status: "pending",
      reason: { code: "run_in_progress", runIds: running.map((run) => run.id) },
    };
  }
  const run = newest(runs);

  const shas = [...new Set(checkerCalls(run).map((workflow) => workflow.sha))];
  const [checkerSha] = shas;
  if (checkerSha === undefined || shas.length > 1 || !request.checker.shas.includes(checkerSha)) {
    return reject(run, {
      code: "checker_mismatch",
      expected: [...request.checker.shas],
      actual: shas,
    });
  }

  const artifacts = (await source.listArtifacts(run.id, EVIDENCE_ARTIFACT_NAME)).filter(
    (artifact) => artifact.name === EVIDENCE_ARTIFACT_NAME,
  );
  if (artifacts.length === 0) {
    return { status: "missing", reason: { code: "no_artifact" }, runId: run.id };
  }
  if (artifacts.length > 1) {
    // どれが ent-check の書いたものか決められない。新しい方を取ると、後から足された方が勝つ
    return reject(run, {
      code: "multiple_artifacts",
      artifactIds: artifacts.map((artifact) => artifact.id),
    });
  }
  const [artifact] = artifacts as [RunArtifact];
  if (artifact.expired) {
    return {
      status: "missing",
      reason: { code: "artifact_expired", artifactId: artifact.id },
      runId: run.id,
    };
  }
  if (artifact.sizeInBytes > MAX_EVIDENCE_BYTES) {
    return reject(run, { code: "artifact_too_large", bytes: artifact.sizeInBytes });
  }

  const download = await source.download(artifact.id, MAX_EVIDENCE_BYTES);
  if (download.status === "too_large") {
    // 一覧の大きさと違う。どちらで気づいても同じに扱う
    return reject(run, { code: "artifact_too_large", bytes: download.bytes });
  }
  const archive = download.data;
  if (artifact.digest !== null && artifact.digest !== `sha256:${sha256(archive)}`) {
    return reject(run, { code: "digest_mismatch" });
  }
  let files: Map<string, Buffer>;
  try {
    files = extractFiles(
      archive,
      [EVIDENCE_FILE_NAME, EVIDENCE_ATTESTATION_FILE_NAME],
      MAX_EVIDENCE_BYTES,
    );
  } catch (error) {
    if (error instanceof ArchiveError) {
      return reject(run, { code: "bad_archive", detail: error.message });
    }
    throw error;
  }
  const evidence = files.get(EVIDENCE_FILE_NAME);
  const token = files.get(EVIDENCE_ATTESTATION_FILE_NAME)?.toString("utf8");
  if (evidence === undefined || token === undefined) {
    // extractFiles は頼んだ名前をちょうど揃えて返すので、ここには来ない。来たら受け取らない
    return reject(run, { code: "bad_archive", detail: "the archive is missing a file" });
  }

  const verified = verifyIdToken(token, await source.signingKeys());
  if (!verified.ok) {
    return verified.reason === "unknown_key"
      ? {
          status: "missing",
          reason: { code: "attestation_key_unknown", kid: verified.kid },
          runId: run.id,
        }
      : reject(run, { code: "bad_attestation", detail: verified.detail });
  }
  const attestation = checkAttestation(verified.claims, request, run, checkerSha, evidence);
  if (attestation !== null) {
    return reject(run, attestation);
  }
  if (verified.claims.run_attempt !== String(run.runAttempt)) {
    // 回し直しても、前の attempt の artifact は run に残る。いまの attempt が ent-check より先に
    // 落ちると、前の attempt の報告だけが見える。それを読むと、回し直した理由を無視する
    return {
      status: "missing",
      reason: {
        code: "artifact_from_earlier_attempt",
        artifactId: artifact.id,
        attempt: verified.claims.run_attempt,
      },
      runId: run.id,
    };
  }

  const parsed = parseReport(evidence);
  if (parsed.ok === false) {
    return reject(run, parsed.reason);
  }
  const report = parsed.report;
  const mismatch = mismatchOf(report, request, checkerSha);
  if (mismatch !== null) {
    return reject(run, mismatch);
  }
  if (report.base_sha !== request.baseSha) {
    // 報告は pull_request の event が起きたときの base で作る。base だけが進んでも event は
    // 起きないので、ほかの PR が merge されるたびに、head の変わらない PR はここに来る
    return {
      status: "stale",
      reason: { code: "base_moved", expected: request.baseSha, actual: report.base_sha },
      runId: run.id,
    };
  }
  return { status: "found", report, summary: capped(summarizeEvidence(report)), runId: run.id };
}

/**
 * 判定に渡してよい段階の上限。
 *
 * evidence.json は head のコードを流さないジョブが作り、そのジョブのトークンで確かめる。
 * 報告の差し替えと、差分から決まる規則・段階の計算には、head は触れない。それでも
 * 規則が読む観測（テストの件数・skip・verify の終了コード）は、head のコードを流したジョブが
 * 残したもので、head の言い分のままになる。E2 の層（凍結した契約とミューテーションテスト）も
 * head のコードを流して確かめるので、同じ穴を通る。E1 だけでは段階を見る種別の自動マージに
 * 届かない（いちばん低い要求が E2）ので、いまはそれを受け入れ、ここで E1 に抑える。E2 より上を
 * 数えるのは、観測を head のプロセスから触れない形にしてからにする。
 */
export const OBSERVED_LEVEL_CAP: EvidenceLevel = "E1";

/** 判定（`decideAutoMerge`）に渡す形。受け取れなかった報告は「エビデンスが無い」と同じに扱う */
export function evidenceSummary(outcome: EvidenceOutcome): EvidenceSummary | null {
  return outcome.status === "found" ? outcome.summary : null;
}

function capped(summary: EvidenceSummary): EvidenceSummary {
  return reaches(summary.level, OBSERVED_LEVEL_CAP)
    ? { ...summary, level: OBSERVED_LEVEL_CAP }
    : summary;
}

/**
 * トークンが、この run の、受け取る検査の evidence のジョブが、この evidence.json に対して
 * 取ったものか。違えば最初に違った欄を返す。attempt は比べない。前の attempt のものは約束に
 * 反したのではなく古いので、呼ぶ側で分けて扱う
 *
 * - aud: evidence.json の sha256。別の報告に付いたトークンを持ってきても通らない
 * - job_workflow: 呼ばれた側のワークフロー。呼ぶ側のジョブで取ったトークンは、呼ぶ側の
 *   ワークフローの名前になる
 * - job_workflow_sha: run が呼んだ検査の sha。evidence のジョブは、これと違う sha の
 *   ent-check を流さない
 * - runner_environment: GitHub が用意した runner。自前の runner では、head を流したジョブと
 *   同じ機械に載りうる
 */
function checkAttestation(
  claims: IdTokenClaims,
  request: EvidenceRequest,
  run: CheckRun,
  checkerSha: string,
  evidence: Buffer,
): EvidenceReason | null {
  const ref = claims.job_workflow_ref;
  const workflow = ref.includes("@") ? ref.slice(0, ref.lastIndexOf("@")) : ref;
  const expected: [AttestationField, string, string][] = [
    ["aud", `${EVIDENCE_AUDIENCE_PREFIX}${sha256(evidence)}`, claims.aud],
    ["repository", request.repo.toLowerCase(), claims.repository.toLowerCase()],
    ["run_id", String(run.id), claims.run_id],
    ["event_name", "pull_request", claims.event_name],
    ["job_workflow", request.checker.workflow.toLowerCase(), workflow.toLowerCase()],
    ["job_workflow_sha", checkerSha, claims.job_workflow_sha],
    ["runner_environment", "github-hosted", claims.runner_environment],
  ];
  const mismatch = firstMismatch(expected);
  return mismatch === null ? null : { code: "attestation_mismatch", ...mismatch };
}

/** `[欄, 期待, 実際]` の並びのうち、最初に違ったもの */
function firstMismatch<F extends string>(
  pairs: readonly (readonly [F, string, string])[],
): { field: F; expected: string; actual: string } | null {
  const found = pairs.find(([, want, got]) => want !== got);
  return found === undefined ? null : { field: found[0], expected: found[1], actual: found[2] };
}

function newest(runs: readonly CheckRun[]): CheckRun {
  return runs.reduce((latest, run) =>
    run.createdAt > latest.createdAt || (run.createdAt === latest.createdAt && run.id > latest.id)
      ? run
      : latest,
  );
}

function reject(run: CheckRun, reason: EvidenceReason): EvidenceOutcome {
  return { status: "rejected", reason, runId: run.id };
}

function parseReport(
  evidence: Buffer,
): { ok: true; report: EvidenceReport } | { ok: false; reason: EvidenceReason } {
  let json: unknown;
  try {
    json = JSON.parse(evidence.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: { code: "bad_report", detail: `not JSON: ${String(error)}` } };
  }
  const parsed = evidenceReportSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: { code: "bad_report", detail } };
  }
  return { ok: true, report: parsed.data };
}

/**
 * 報告が、頼んだ PR と head の、run が呼んだ検査のものか。違えば最初に違った欄を返す。
 * base は比べない。違えば約束に反したのではなく古いので、呼ぶ側で分けて扱う
 */
function mismatchOf(
  report: EvidenceReport,
  request: EvidenceRequest,
  checkerSha: string,
): EvidenceReason | null {
  const expected: [ReportField, string, string][] = [
    ["repo", request.repo.toLowerCase(), report.repo.toLowerCase()],
    ["pr", String(request.pr), String(report.pr)],
    ["head_sha", request.headSha, report.head_sha],
    // run が呼んだ sha と違えば、呼ぶ側が uses: と entelecheia-sha を揃えていない。
    // null（手元で回した報告）も、どの検査で作ったか分からないので落とす
    ["checker_sha", checkerSha, String(report.checker_sha)],
  ];
  const mismatch = firstMismatch(expected);
  return mismatch === null ? null : { code: "report_mismatch", ...mismatch };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
