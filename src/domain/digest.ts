import { createHash } from "node:crypto";
import type { Fact } from "./fact.js";

/**
 * 観測値のダイジェスト。design.md §4.5 の `Decision.observed_digest` に入る。
 *
 * キー順に正規化してから取る。Fact の並びは観測の順序で決まるので、
 * そのまま食わせると同じ状態でも別のダイジェストになる。
 *
 * 「前のティックから状態が変わったか」の判定に使う。Phase 3 の1本目で、
 * 2ティック続けて完全に一致することを実測した。ループ検知（§7 の
 * `max_unchanged_reconciles`）はこれを材料にしていて、Gap を別に永続化しない。
 *
 * controller に置いていたものを domain へ移した。reconcile が DECIDE に渡す
 * 値になったので、副作用のある層に置いたままにできない。
 */
export function digestOf(facts: readonly Fact[]): string {
  const normalized = [...facts]
    .map((fact) => `${fact.key}=${JSON.stringify(fact.value ?? null)}@${fact.confidence}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}
