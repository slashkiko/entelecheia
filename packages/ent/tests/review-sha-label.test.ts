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
 * `reviewed_sha:` の行を、本文中の sha を数える規則より先に見る。
 *
 * tests/review-observe.test.ts は「sha が2つ以上あれば Fact を作らない」を
 * 固定している。あれは正しいが、それだけだと**プロンプトが述べていない契約**に
 * 依存する。レビュー役のプロンプト（`src/adapters/claude.ts`）が求めているのは
 * 「読んだ commit の sha を述べる」ことだけで、2つ目の完全な sha を書くと観測が
 * 無効になるとは言っていない。差分の比較元を完全形で併記する、`git log` の出力を
 * 1行引用する——どれも指示に従った書き方なのに、数えるだけの規則ではレビュー
 * 1回分が丸ごと落ちる。
 *
 * プロンプトのある `src/adapters/claude.ts` は `PROTECTED_PATH_FLOOR` の中にあり、
 * 「ラベルを付けろ」と書き足すことはできない。**対処できるのは読む側だけになる。**
 * 名指しがあればそれを採り、無ければこれまでどおり数える。
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const BASE = "c".repeat(40);

function deps(review: Partial<ReviewPort>): ObserveDeps {
  const code: CodeProviderPort = {
    getPullRequest: async () => null,
    getLatestCiRun: async () => null,
    getIssue: async () => null,
  };
  const local: LocalRepoPort = {
    snapshot: async () => ({ branch: "entelecheia/g", headSha: HEAD, dirty: false }),
  };
  return { code, local, review: { latest: async () => null, ...review }, now: () => NOW };
}

async function observeMessage(finalMessage: string) {
  return await observe(
    { prNumber: null, issueNumber: null },
    deps({ latest: async () => ({ runId: "run-20", finalMessage }) }),
  );
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

function unresolvedFor(unobserved: readonly Unresolved[], key: string): Unresolved | undefined {
  return unobserved.find((u) => u.key === key);
}

describe("読んだ commit の名指しを先に見る", () => {
  it("比較元を併記していても、名指しがあれば読める", async () => {
    const result = await observeMessage(
      [
        `${REVIEWED} を読みました。比較元は ${BASE} です。`,
        "",
        `reviewed_sha: ${REVIEWED}`,
        "verdict: approved",
      ].join("\n"),
    );

    expect(byKey(result.facts, "review.reviewed_sha")?.value).toBe(REVIEWED);
    expect(byKey(result.facts, "review.verdict")?.value).toBe("approved");
  });

  it("名指しが無ければ、これまでどおり本文中の sha を数える", async () => {
    const result = await observeMessage(
      [`読んだ commit は ${REVIEWED} です。`, "verdict: approved"].join("\n"),
    );

    expect(byKey(result.facts, "review.reviewed_sha")?.value).toBe(REVIEWED);
  });

  it("名指しが2つあって食い違えば、数え直さずに Fact を作らない", async () => {
    // 「どれを読んだか」を名指しで2通り述べた出力は、本文を数え直しても決まらない。
    const result = await observeMessage(
      [`reviewed_sha: ${REVIEWED}`, `reviewed_sha: ${BASE}`, "verdict: approved"].join("\n"),
    );

    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.reviewed_sha")?.reason).toBe("pending");
  });

  it("同じ sha を2度名指ししただけなら1つと数える", async () => {
    const result = await observeMessage(
      [
        `reviewed_sha: ${REVIEWED}`,
        "…",
        `reviewed_sha: ${REVIEWED.toUpperCase()}`,
        "verdict: approved",
      ].join("\n"),
    );

    expect(byKey(result.facts, "review.reviewed_sha")?.value).toBe(REVIEWED);
  });

  it("行の一部に現れた名指しは拾わない", async () => {
    // 行全体で照合するのは `verdict:` と同じ理由になる（design.md §10-4）。
    // 本文の途中に置いた名指しを採ると、読んでいない commit のレビューが作れる。
    const result = await observeMessage(
      [
        `${REVIEWED} を読みました。`,
        `説明のため \`reviewed_sha: ${BASE}\` という行を例に挙げます。`,
        "verdict: approved",
      ].join("\n"),
    );

    // 名指しとしては拾わない。数える側に落ちて、本文に sha が2つあるので決まらない。
    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.reviewed_sha")?.reason).toBe("pending");
  });

  it("名指しがあっても、verdict が読めなければ対にしない", async () => {
    const result = await observeMessage(
      [`reviewed_sha: ${REVIEWED}`, "よさそうに見えます。"].join("\n"),
    );

    expect(byKey(result.facts, "review.reviewed_sha")).toBeUndefined();
    expect(byKey(result.facts, "review.verdict")).toBeUndefined();
    expect(unresolvedFor(result.unobserved, "review.verdict")?.reason).toBe("pending");
  });
});
