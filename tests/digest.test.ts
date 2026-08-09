import { describe, expect, it } from "vitest";
import { digestOf } from "../src/domain/digest.js";
import type { Fact } from "../src/domain/fact.js";

/**
 * 観測値のダイジェスト（design.md §4.5 の `Decision.observed_digest`）。
 *
 * ループ検知（§7 の max_unchanged_reconciles）が「前ティックと同じ観測か」を
 * これで判定する。進捗コメントを書くかどうかも同じ値で決まる。
 *
 * 順序で値が変わると、その両方が同時に壊れる。ループ検知は永久に発火せず、
 * 進捗コメントは毎ティック出る。reconcile 経由の暗黙のテストしか無かったので、
 * 正規化の sort を消しても全件が緑のままだった。
 */

const NOW = "2026-08-09T03:00:00.000Z";

function fact(key: string, value: unknown, confidence: Fact["confidence"] = "VERIFIED"): Fact {
  return { key, value, observedAt: NOW, confidence, evidence: { source: "test", detail: "" } };
}

describe("digestOf", () => {
  it("Fact の並びが違っても同じ値になる", () => {
    // Fact の並びは観測の順序で決まる。Port の応答が前後しただけで
    // 「観測が変わった」と読むと、空回りを検知できない。
    const a = [fact("github.pr.state", "open"), fact("criteria.ac-1.passed", true)];
    const b = [fact("criteria.ac-1.passed", true), fact("github.pr.state", "open")];

    expect(digestOf(a)).toBe(digestOf(b));
  });

  it("値が変われば別の値になる", () => {
    const a = [fact("github.pr.state", "open")];
    const b = [fact("github.pr.state", "closed")];

    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("confidence が変われば別の値になる", () => {
    // INFERRED から VERIFIED に上がったのは進捗にあたる。
    const a = [fact("criteria.ac-1.passed", true, "VERIFIED")];
    const b = [fact("criteria.ac-1.passed", true, "INFERRED")];

    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("キーが増えれば別の値になる", () => {
    const a = [fact("github.pr.state", "open")];
    const b = [fact("github.pr.state", "open"), fact("github.ci.conclusion", "success")];

    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("Fact が無ければ空集合として安定する", () => {
    expect(digestOf([])).toBe(digestOf([]));
  });
});
