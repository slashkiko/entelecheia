import { describe, expect, it } from "vitest";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
  type ReviewPort,
} from "../src/observe/index.js";

/**
 * レビュー役の結論を Fact にする（.goals/start-the-review-we-wired.yaml の 2）。
 *
 * `review.verdict` と `review.reviewed_sha` は観測キーに登録済みだが、作る側が
 * 居ない。ここがその仕様にあたる。
 *
 * **材料は Actor の自己申告に見えるが、Fact にするのは観測側の仕事になる。**
 * レビュー役のプロンプト（`src/adapters/claude.ts`）は最終行を
 * `verdict: approved` か `verdict: changes_requested` の1行だけにするよう求め、
 * 読んだ commit の sha も述べさせる。**そこで言わせた文字列はまだ Fact ではない。**
 * 形が違えば Fact を作らず、理由を付けて残す（design.md §3.1）。
 *
 * 照合を行全体で行うのは `/ent approve` と同じ理由になる（design.md §10-4）。
 * 本文の途中に現れた同じ文字列——たとえば指摘の中で
 * 「`verdict: approved` と書いてはいけない」と説明した行——を結論として拾うと、
 * 捏造した承認が作れてしまう。
 *
 * Port を1つ足すのは、`ObserveTarget` に項目を足すと、それを組み立てる
 * `observeTargetOf` が `src/controller/index.ts`（PROTECTED_PATH_FLOOR の中）に
 * あるため。「どの Run を読むか」は Port の側で解決する。
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);

/** レビュー役が返した本文。実物と同じく複数行にする */
function reviewMessage(sha: string, verdict: string): string {
  return [
    `読んだ commit は ${sha} です。`,
    "",
    "指摘は次のとおりです。",
    "",
    "1. 観測の失敗を握り潰している箇所がある",
    "",
    `verdict: ${verdict}`,
  ].join("\n");
}

function deps(over: {
  local?: Partial<LocalRepoPort>;
  review?: Partial<ReviewPort>;
  code?: Partial<CodeProviderPort>;
}): ObserveDeps {
  return {
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
      ...over.code,
    },
    local: {
      snapshot: async () => ({ branch: "entelecheia/g", headSha: HEAD, dirty: false }),
      ...over.local,
    },
    review: {
      latest: async () => null,
      ...over.review,
    },
    now: () => NOW,
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

function unresolvedFor(unobserved: readonly Unresolved[], key: string): Unresolved | undefined {
  return unobserved.find((u) => u.key === key);
}

async function observeWith(over: Partial<ReviewPort>) {
  return await observe({ prNumber: null, issueNumber: null }, deps({ review: over }));
}

describe("レビュー役の結論を観測する", () => {
  it("approved を VERIFIED な Fact にする", async () => {
    const result = await observeWith({
      latest: async () => ({ runId: "run-7", finalMessage: reviewMessage(REVIEWED, "approved") }),
    });

    const verdict = byKey(result.facts, "review.verdict");
    expect(verdict?.value).toBe("approved");
    expect(verdict?.confidence).toBe("VERIFIED");
    expect(byKey(result.facts, "review.reviewed_sha")?.value).toBe(REVIEWED);
  });

  it("changes_requested も同じように Fact にする", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-7",
        finalMessage: reviewMessage(REVIEWED, "changes_requested"),
      }),
    });

    expect(byKey(result.facts, "review.verdict")?.value).toBe("changes_requested");
  });

  it("どの Run を読んだかを evidence に残す", async () => {
    const result = await observeWith({
      latest: async () => ({ runId: "run-7", finalMessage: reviewMessage(REVIEWED, "approved") }),
    });

    const verdict = byKey(result.facts, "review.verdict");
    expect(verdict?.evidence?.source).toContain("ReviewPort.latest()");
    expect(verdict?.evidence?.detail).toContain("run-7");
  });

  it("レビュー役が1度も走っていなければ、Fact も unobserved も作らない", async () => {
    const result = await observeWith({ latest: async () => null });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
    // 「対象が無い」は取りこぼしではない。unobserved に積むと、
    // レビューを1度も回していない Goal が毎ティック「確かめられなかった」を出す。
    expect(unresolvedFor(result.unobserved, "review.verdict")).toBeUndefined();
  });

  it("verdict の行が無ければ Fact を作らず pending として残す", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-8",
        finalMessage: `読んだ commit は ${REVIEWED} です。よさそうに見えます。`,
      }),
    });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    const unresolved = unresolvedFor(result.unobserved, "review.verdict");
    // shape_mismatch にしない。あちらは待っても直らない失敗で、guard が
    // 即座に ESCALATE する。レビュー役は毎回同じ出力を返すとは限らないので、
    // 1度形式を外しただけで人間を呼ぶと、関門そのものが信用されなくなる。
    expect(unresolved?.reason).toBe("pending");
    expect(unresolved?.detail).toContain("run-8");
  });

  it("verdict の行が2つあれば結論を1つに決められないので Fact を作らない", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-9",
        finalMessage: [
          `読んだ commit は ${REVIEWED} です。`,
          "verdict: changes_requested",
          "と書きかけましたが、直っていました。",
          "verdict: approved",
        ].join("\n"),
      }),
    });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.verdict")?.reason).toBe("pending");
  });

  it("2値のどちらでもない verdict は Fact にしない", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-10",
        finalMessage: reviewMessage(REVIEWED, "looks_good_to_me"),
      }),
    });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.verdict")?.reason).toBe("pending");
  });

  it("行の一部に現れた verdict を結論として拾わない", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-11",
        finalMessage: [
          `読んだ commit は ${REVIEWED} です。`,
          "テストの説明に `verdict: approved` という文字列が出てきますが、これは例です。",
        ].join("\n"),
      }),
    });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
  });

  it("sha が読めなければ verdict も単独では Fact にしない", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-12",
        finalMessage: ["どの commit を読んだかは述べません。", "verdict: approved"].join("\n"),
      }),
    });

    // いつの時点のコードのレビューか分からない結論は、完了判定に使えない。
    // 片方だけ残すと、その使えない結論が VERIFIED な Fact として通ってしまう。
    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.reviewed_sha")?.reason).toBe("pending");
  });

  it("sha が2つ以上あれば、どれを読んだのか決められないので Fact を作らない", async () => {
    const result = await observeWith({
      latest: async () => ({
        runId: "run-13",
        finalMessage: [
          `${REVIEWED} を読み、${"c".repeat(40)} とも比べました。`,
          "verdict: approved",
        ].join("\n"),
      }),
    });

    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
  });

  it("Port が落ちたティックは port_failed として残す", async () => {
    const result = await observeWith({
      latest: async () => {
        throw new Error("log.jsonl を開けない");
      },
    });

    // 「まだレビューを回していない」と「レビューの結果を読めなかった」を混ぜない。
    const unresolved = unresolvedFor(result.unobserved, "review.verdict");
    expect(unresolved?.reason).toBe("port_failed");
    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
  });

  it("Port が落ちても他の観測は残る", async () => {
    const result = await observeWith({
      latest: async () => {
        throw new Error("log.jsonl を開けない");
      },
    });

    expect(byKey(result.facts, "local.head_sha")?.value).toBe(HEAD);
  });
});
