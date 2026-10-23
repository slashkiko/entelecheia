import { z } from "zod";

/**
 * エビデンスの段階。検査が出す `evidence.json` の `level` と同じ語を使う。
 *
 * - E0: 何も通っていない
 * - E1: 実装者のテスト（Actor が書く）が通った
 * - E2: 凍結した契約（正解表・性質テスト・IPC 型・スナップショット）と、変更行への
 *   ミューテーションテストまで通った
 * - E3: 変更に該当する holdout が1本以上あり、それが通った
 * - E4: そこに別ベンダーのモデルによるレビューが加わった
 *
 * 段階は上から順に積む。E3 を飛ばして E4 にはならない。
 */
export const evidenceLevelSchema = z.enum(["E0", "E1", "E2", "E3", "E4"]);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

const ORDER: Readonly<Record<EvidenceLevel, number>> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

/** `actual` が `required` 以上か */
export function reaches(actual: EvidenceLevel, required: EvidenceLevel): boolean {
  return ORDER[actual] >= ORDER[required];
}
