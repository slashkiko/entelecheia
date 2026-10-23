import { z } from "zod";
import type { EvidenceSummary } from "./auto-merge.js";
import { type EvidenceLevel, evidenceLevelSchema } from "./evidence.js";

/**
 * `evidence.json` の形（`ent.evidence/v1`）。検査（`ent-check`）が書き、governor（まだ無い）が読む。
 *
 * **governor は PR の中のファイルを読まない。** その sha に対する検査の実行が残した
 * ものだけを読む。Actor が書いた `evidence.json` を信じないため。ここで形を固定するのは、
 * 書く側と読む側が別の package・別のプロセスで、片方だけが形を変えると、読む側は
 * 「知らないキーを無視する」か「全部を不合格にする」のどちらかに黙って倒れるからになる。
 *
 * キーは JSON の慣習どおり snake_case で書く。JSON Schema は
 * `packages/core/schema/evidence-v1.schema.json` にあり、この schema から作る
 * （`tests/factory-evidence-report.test.ts` が一致を確かめる）。
 */

export const EVIDENCE_SCHEMA_ID = "ent.evidence/v1";

/** 規則1つの結果。`quarantined` は flaky として隔離したもので、証拠に数えない */
export const ruleStatusSchema = z.enum(["pass", "fail", "skip", "quarantined"]);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

/** 結果が属する層。E0 は「何も通っていない」なので、層にはならない */
export const evidenceLayerSchema = evidenceLevelSchema.exclude(["E0"]);
export type EvidenceLayer = z.infer<typeof evidenceLayerSchema>;

/** git の commit の sha。SHA-1 の40桁と SHA-256 の64桁 */
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

const countSchema = z.number().int().nonnegative();

export const evidenceResultSchema = z.strictObject({
  layer: evidenceLayerSchema,
  /** 落ちた規則を Actor に返すときの鍵。ログの本文ではなく、この id から作業を起こす */
  rule_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  status: ruleStatusSchema,
  /**
   * 落ちた場所（ファイルのパスやテストの名前）。複数あるときは改行で繋ぐ。新しく飛ばした
   * テストは先頭の10件まで。場所の無い規則は null
   */
  location: z.string().min(1).nullable(),
  /** 直し方。通った規則は null */
  fix_hint: z.string().min(1).nullable(),
});
export type EvidenceResult = z.infer<typeof evidenceResultSchema>;

export const evidenceReportSchema = z
  .strictObject({
    schema: z.literal(EVIDENCE_SCHEMA_ID),
    /** `<owner>/<name>` */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    /** PR を検査したときの番号。main の見張り（bake time）のように PR が無いときは null */
    pr: z.number().int().positive().nullable(),
    head_sha: commitShaSchema,
    base_sha: commitShaSchema,
    /** 検査の定義（`verify/**`・タスク定義など）を取り出した commit。いまは base と同じ */
    check_definition_sha: commitShaSchema,
    level: evidenceLevelSchema,
    results: z.array(evidenceResultSchema),
    /**
     * テストの件数。`before` は base 側（PR の分岐点に、同じ検査の定義を差し込んだもの）、
     * `after` は head 側。テストの報告が読めなかったときは null にする。0 と書くと
     * 「テストが0件だった」と読めてしまう
     */
    tests: z.strictObject({
      before: countSchema.nullable(),
      after: countSchema.nullable(),
      new_skips: countSchema.nullable(),
    }),
    /**
     * 公開している面（型とスナップショット）に差分があるか。振る舞いを変えない種別は、
     * どちらも false のときだけ自動マージに届く。読めないときは null にし、読む側は
     * 「差分あり」に倒す
     */
    surface: z.strictObject({
      types_changed: z.boolean().nullable(),
      snapshots_changed: z.boolean().nullable(),
    }),
    /** holdout のシナリオを回したときの結果。回していなければ null */
    holdout: z
      .strictObject({
        matched: countSchema,
        passed: countSchema,
        review_stage: z.enum(["all", "sample", "none"]),
      })
      .nullable(),
    /** 別ベンダーのレビュー。回していなければ null。回して返事が無ければ unavailable */
    review: z
      .strictObject({
        vendor: z.string().min(1),
        verdict: z.enum(["approve", "request_changes", "unavailable"]),
      })
      .nullable(),
    generated_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((report, context) => {
    // level は results から決まる値と一致させる。書く側の不具合で level だけが上がると、
    // 読む側は results を見ずに level で判定するので、落ちた検査や回していない層が黙って通る。
    const expected = levelOf(report.results);
    if (report.level !== expected) {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message: `level ${report.level} does not match the results, which reach ${expected}`,
      });
    }
  });
export type EvidenceReport = z.infer<typeof evidenceReportSchema>;

/**
 * 判定（`decideAutoMerge`）に渡す形へ縮める。読めなかった面は「差分あり」に倒す。
 * 差分が無いと読み違えると、振る舞いを変えない種別の自動マージが、型の変わった PR に届く。
 */
export function summarizeEvidence(report: EvidenceReport): EvidenceSummary {
  return {
    level: report.level,
    typesChanged: report.surface.types_changed ?? true,
    snapshotsChanged: report.surface.snapshots_changed ?? true,
  };
}

/** 結果から届く段階。上の層は、下の層が全部通ってから数える */
export function levelOf(results: readonly EvidenceResult[]): EvidenceLevel {
  const layers = evidenceLayerSchema.options;
  let level: EvidenceLevel = "E0";
  for (const layer of layers) {
    // 隔離した結果（quarantined）は証拠に数えない。通ったとも落ちたとも扱わない。
    const inLayer = results.filter(
      (result) => result.layer === layer && result.status !== "quarantined",
    );
    // 層の規則が1つも無い、あるいは1つでも落ちた・飛ばしたなら、そこで止まる。
    // skip を通ったと数えると、報告が読めずに飛ばした検査で段階が上がる。
    if (inLayer.length === 0 || inLayer.some((result) => result.status !== "pass")) {
      break;
    }
    level = layer;
  }
  return level;
}
