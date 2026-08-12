import { describe, expect, it } from "vitest";
import type { Fact } from "../src/domain/fact.js";
import { observedFactKeySchema } from "../src/domain/fact-keys.js";
import { verificationSchema } from "../src/domain/goal.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
  type PullRequestSnapshot,
} from "../src/observe/index.js";

/**
 * 未解決のレビュースレッドの件数を Fact にする（issue #64 の案1）。
 *
 * OBSERVE が PR について作る Fact は `github.pr.review_decision` までで、
 * 自動レビュー bot の指摘を収束条件に組み込む口が無い。bot のレビューは多くの場合
 * COMMENTED なので、`review_decision` は `REVIEW_REQUIRED` のまま動かない。
 * `github.pr.unresolved_threads` があれば Goal YAML が
 * `verification: { type: fact, key: github.pr.unresolved_threads, equals: 0 }`
 * と書けて、bot のレビューが収束条件になる。
 *
 * ここが観測側の仕様にあたる。**「件数が決まらなかった」を 0 に畳まない**のが要点で、
 * 0 は「未解決のスレッドが1つも無い」という観測できた結果、null は
 * 「いくつあるのか確かめられなかった」になる。前者を Fact にしなければ
 * `equals: 0` は永久に成立せず、後者を 0 と読めば指摘を残したまま収束する。
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
const HEAD = "c".repeat(40);

/** PR の観測結果。件数だけを差し替えて使う */
function pullRequest(unresolvedThreads: number | null): PullRequestSnapshot {
  return {
    number: 12,
    state: "open",
    mergeable: true,
    headSha: HEAD,
    reviewDecision: "REVIEW_REQUIRED",
    requestedReviewers: ["pr-author"],
    title: "サンプル PR",
    body: "本文",
    unresolvedThreads,
  };
}

function deps(over: {
  code?: Partial<CodeProviderPort>;
  local?: Partial<LocalRepoPort>;
}): ObserveDeps {
  return {
    review: { latest: async () => null },
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
    now: () => NOW,
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

async function observeWith(unresolvedThreads: number | null) {
  return await observe(
    { prNumber: 12, issueNumber: null },
    deps({ code: { getPullRequest: async () => pullRequest(unresolvedThreads) } }),
  );
}

const KEY = "github.pr.unresolved_threads";

describe("未解決レビュースレッドの観測", () => {
  it("件数を VERIFIED な Fact にする", async () => {
    const result = await observeWith(3);

    const fact = byKey(result.facts, KEY);
    expect(fact?.value).toBe(3);
    expect(fact?.confidence).toBe("VERIFIED");
    expect(fact?.evidence?.source).toContain("CodeProviderPort.getPullRequest(12)");
  });

  it("0 件でも Fact を作る", async () => {
    const result = await observeWith(0);

    // ここが収束条件そのものになる。0 を falsy として落とすと
    // `equals: 0` の criteria は永久に Gap のままで、Goal が COMPLETE に届かない。
    const fact = byKey(result.facts, KEY);
    expect(fact).toBeDefined();
    expect(fact?.value).toBe(0);
    expect(fact?.confidence).toBe("VERIFIED");
  });

  it("件数が決まらなければ Fact を作らない", async () => {
    const result = await observeWith(null);

    // null は「未解決が 0 件」ではなく「いくつあるか確かめられなかった」。
    // 0 と読むと、指摘を残したまま `equals: 0` が成立する。
    expect(byKey(result.facts, KEY)).toBeUndefined();
  });

  it("件数が決まらなくても、他の PR の観測は残る", async () => {
    const result = await observeWith(null);

    // スレッドの解決状態が読めないことと、PR が観測できないことは別。
    // 前者で `github.pr.*` を丸ごと落とすと、この Fact を1文字も参照していない
    // Goal まで head_sha も CI も見えなくなる。
    expect(byKey(result.facts, "github.pr.number")?.value).toBe(12);
    expect(byKey(result.facts, "github.pr.head_sha")?.value).toBe(HEAD);
    expect(byKey(result.facts, "github.pr.review_decision")?.value).toBe("REVIEW_REQUIRED");
  });

  it("件数が決まらないティックで unobserved を増やさない", async () => {
    const result = await observeWith(null);

    // `mergeable` の null と同じ扱いにする。ここで unresolved を積むと、
    // Gap がゼロの Goal は DECIDE が COMPLETE ではなく WAIT を返すようになり
    // （src/decide/index.ts）、このキーを参照していない Goal まで
    // 完了できなくなる。件数を求めている Goal の側は、Fact が無ければ
    // criteria が Gap(unknown) を立てるので、待つ理由はそちらに残る。
    expect(result.unobserved.filter((u) => u.key.startsWith("github.pr"))).toEqual([]);
  });

  it("PR を観測していないティックでは Fact を作らない", async () => {
    const result = await observe({ prNumber: null, issueNumber: null }, deps({}));

    expect(byKey(result.facts, KEY)).toBeUndefined();
  });

  it("件数は PullRequestSnapshot の必須フィールドにする", () => {
    // 省略可能にすると、`mise run typecheck` を通す最も安いやり方が
    // 「フィールドを足さない Adapter を書く」になり、Port の契約が
    // 「数えたら入っているかもしれない」に弱まる。実行時には現れないので、
    // 型の側で1度だけ押さえる。
    // @ts-expect-error unresolvedThreads を省略した PR の観測結果は作れない
    const incomplete: PullRequestSnapshot = {
      number: 12,
      state: "open",
      mergeable: null,
      headSha: HEAD,
      reviewDecision: null,
      requestedReviewers: [],
      // title と body は埋める。**欠けているのを unresolvedThreads 1つだけに保つ。**
      // 他のフィールドも一緒に落とすと、@ts-expect-error はそちらの欠落でも
      // 満たされてしまい、このテストが押さえている対象がぼやける。
      title: "サンプル PR",
      body: "本文",
    };

    expect(incomplete.number).toBe(12);
  });

  it("観測キーのレジストリに載っている", () => {
    // Goal YAML の `verification: { type: fact }` はここを参照するので、
    // レジストリに無いキーは criteria に書けない（src/domain/fact-keys.ts）。
    expect(observedFactKeySchema.safeParse(KEY).success).toBe(true);
  });

  it("Goal YAML が `equals: 0` で参照できる", () => {
    // issue #64 が求めているのはこの1行が書けること。
    const parsed = verificationSchema.safeParse({ type: "fact", key: KEY, equals: 0 });

    expect(parsed.success).toBe(true);
  });
});
