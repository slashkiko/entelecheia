import { describe, expect, it } from "vitest";
import { githubCodeProvider } from "../src/adapters/github.js";
import type { Fact } from "../src/domain/fact.js";
import { observedFactKeySchema } from "../src/domain/fact-keys.js";
import { verificationSchema } from "../src/domain/goal.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
} from "../src/observe/index.js";

/**
 * 「この head sha で落ちている job が1つも無い」を criteria に書けるようにする（issue #58）。
 *
 * いま Goal が書けるのは `github.ci.conclusion == success` だけで、これは head sha に
 * 紐づく**最新の workflow run 1本**の結論でしかない。workflow を複数持つリポジトリでは、
 * lint の run が落ちていても test の run が後から success で終われば criterion は緑になる。
 * 誤って収束する側の壊れ方なので、CI が赤いまま人間のレビューに回る。
 *
 * `github.ci.failed_jobs` は既にあるが、`verification.type: fact` の `equals` が
 * `string | number | boolean` しか受けないので「配列が空」を書けない。
 *
 * そこで数えた数を Fact にする（issue #58 の案1）。`github.ci.conclusion` の意味は
 * 変えない（案2 は既存 Goal の意味が変わるので採らない）。
 *
 * 満たすべき性質は4つ。
 *
 *   横断   数える対象は head sha に紐づく**全 workflow run**。1本だけ見ると
 *          `conclusion == success` と同じものになり、issue #58 は直らない
 *   確定   まだ回っている run があるあいだは Fact にしない。「いま時点で 0 件」を
 *          Fact にすると、push した直後の queued な状態で `equals: 0` が通る。
 *          直そうとしている誤収束より悪いものを作ることになる
 *   0 を出す  0 件でも Fact にする。`failed_jobs` の側は「1件以上あるとき」しか
 *          push しないので、そこを真似ると `equals: 0` が永久に届かない
 *   数え切る  1ページ（`per_page: 100`）で読み切れていないなら数を出さない。
 *          `total_count` が件数を上回るときが「まだ読んでいない run がある」で、
 *          そこで数を確定させると 101 本目以降の失敗が数から落ちる。**確定と同じ
 *          規則**（数え切れていないなら数を出さない）を、切り捨てにも当てる
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
const SHA = "a".repeat(40);

/** この Goal で足す観測キー */
const FAILED_JOB_COUNT_KEY = "github.ci.failed_job_count";

function deps(over: {
  code?: Partial<CodeProviderPort>;
  local?: Partial<LocalRepoPort>;
}): ObserveDeps {
  return {
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => ({
        number: 12,
        state: "open",
        mergeable: null,
        headSha: SHA,
        reviewDecision: null,
        requestedReviewers: [],
        title: "サンプル PR",
        body: "本文",
        unresolvedThreads: null,
      }),
      getLatestCiRun: async () => null,
      getIssue: async () => null,
      ...over.code,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: SHA, dirty: false }),
      ...over.local,
    },
    now: () => NOW,
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

describe("落ちている job の数を criteria に書ける", () => {
  it("観測キーとして github.ci.failed_job_count が実在する", () => {
    // レジストリに無いキーは Zod が Goal YAML の時点で弾く（src/domain/fact-keys.ts）。
    expect(observedFactKeySchema.safeParse(FAILED_JOB_COUNT_KEY).success).toBe(true);
  });

  it("equals: 0 の criterion が Goal に書ける", () => {
    // `equals` は既に number を受けるので、スキーマ（src/domain/goal.ts）は触らずに済む。
    // あちらは PROTECTED_PATH_FLOOR の中にあり、触れば関門が鳴る。
    const parsed = verificationSchema.safeParse({
      type: "fact",
      key: FAILED_JOB_COUNT_KEY,
      equals: 0,
    });

    expect(parsed.success).toBe(true);
  });
});

describe("observe が失敗ジョブ数を Fact にする", () => {
  it("0 件でも Fact にする", async () => {
    // ここが本体。`failed_jobs` は「1件以上あるとき」しか push しないので、
    // その形を真似ると `equals: 0` は永久に届かず、criterion が緑にならない。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () => ({
            headSha: SHA,
            status: "completed",
            conclusion: "success",
            failedJobs: [],
            failedJobCount: 0,
            excludedWorkflows: [],
          }),
        },
      }),
    );

    const fact = byKey(result.facts, FAILED_JOB_COUNT_KEY);
    expect(fact?.value).toBe(0);
    expect(fact?.confidence).toBe("VERIFIED");
    // 一次情報であることを後から追えるようにする（design.md §3.1）。
    expect(fact?.evidence?.source).toContain("getLatestCiRun");
  });

  it("落ちている job があればその数を Fact にする", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () => ({
            headSha: SHA,
            status: "completed",
            conclusion: "success",
            failedJobs: [{ name: "lint", logUrl: "https://example.test/logs/1" }],
            failedJobCount: 2,
            excludedWorkflows: [],
          }),
        },
      }),
    );

    expect(byKey(result.facts, FAILED_JOB_COUNT_KEY)?.value).toBe(2);
  });

  it("まだ確定していなければ Fact にしない", async () => {
    // 回っている最中の「いま 0 件」を Fact にすると、push した直後に
    // `equals: 0` が通る。conclusion が null の run を Fact にしないのと同じ理由。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () => ({
            headSha: SHA,
            status: "in_progress",
            conclusion: null,
            failedJobs: [],
            failedJobCount: null,
            excludedWorkflows: [],
          }),
        },
      }),
    );

    expect(byKey(result.facts, FAILED_JOB_COUNT_KEY)).toBeUndefined();
    // 観測できた分（status）は残る。読めなかったわけではない。
    expect(byKey(result.facts, "github.ci.status")).toBeDefined();
  });
});

/**
 * テストから実際の GitHub を叩かない。fetch を注入して octokit の下を差し替える。
 * tests/github-adapter.test.ts と同じ形にしてある。
 */
interface Route {
  match: string;
  body?: unknown;
}

function provider(routes: Route[]): CodeProviderPort {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    // 先に書いた route が勝つ。`/actions/runs?` と `/actions/runs/7/jobs` は
    // どちらも `/actions/runs` を含むので、順序ではなく `?` と `/` で分ける。
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return githubCodeProvider({
    owner: "slashkiko",
    repo: "entelecheia",
    token: "ghp_test",
    fetch: impl as unknown as typeof fetch,
  });
}

describe("githubCodeProvider が run を横断して数える", () => {
  it("最新の run が success でも、他の run が落ちていれば数に出る", async () => {
    // issue #58 そのもの。lint の run が落ちているのに、後から終わった test の run が
    // success なので `github.ci.conclusion` は success になる。conclusion の意味は
    // 変えない（案2 は採らない）ので、数の側で「落ちている job がある」を出す。
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          total_count: 2,
          workflow_runs: [
            { id: 8, head_sha: SHA, status: "completed", conclusion: "success" },
            { id: 7, head_sha: SHA, status: "completed", conclusion: "failure" },
          ],
        },
      },
      {
        match: "/actions/runs/8/jobs",
        body: { jobs: [{ name: "test", conclusion: "success", html_url: "https://g/j/0" }] },
      },
      {
        match: "/actions/runs/7/jobs",
        body: {
          jobs: [
            { name: "lint", conclusion: "failure", html_url: "https://g/j/1" },
            { name: "build", conclusion: "success", html_url: "https://g/j/2" },
          ],
        },
      },
    ]);

    const ci = await code.getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(1);
    // 既存キーの意味は変えない。最新の run の結論のまま。
    expect(ci?.conclusion).toBe("success");
    // 数だけでは次の ACT が何を直すか決められないので、名前とログ URL も横断して残す。
    expect(ci?.failedJobs).toEqual([{ name: "lint", logUrl: "https://g/j/1" }]);
  });

  it("どの run も落ちていなければ 0", async () => {
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          total_count: 2,
          workflow_runs: [
            { id: 8, head_sha: SHA, status: "completed", conclusion: "success" },
            { id: 7, head_sha: SHA, status: "completed", conclusion: "success" },
          ],
        },
      },
    ]);

    expect((await code.getLatestCiRun(SHA))?.failedJobCount).toBe(0);
  });

  it("回っている run が1本でもあれば null", async () => {
    // 最新の run が終わっていても、他の run が回っていれば数は確定しない。
    // ここを 0 にすると、押した直後の緑を掴む。
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          total_count: 2,
          workflow_runs: [
            { id: 8, head_sha: SHA, status: "completed", conclusion: "success" },
            { id: 7, head_sha: SHA, status: "in_progress", conclusion: null },
          ],
        },
      },
    ]);

    const ci = await code.getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBeNull();
    expect(ci?.conclusion).toBe("success");
  });

  it("timed_out や cancelled で終わった run の失敗ジョブも数える", async () => {
    // conclusion が failure の run だけを見ると、時間切れで落ちた workflow が
    // 数から漏れる。落ちている job が残っているのに 0 を出すと、直そうとしている
    // 誤収束をそのまま作り直すことになる。
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          total_count: 2,
          workflow_runs: [
            { id: 9, head_sha: SHA, status: "completed", conclusion: "timed_out" },
            { id: 8, head_sha: SHA, status: "completed", conclusion: "cancelled" },
          ],
        },
      },
      {
        match: "/actions/runs/9/jobs",
        body: { jobs: [{ name: "e2e", conclusion: "failure", html_url: "https://g/j/9" }] },
      },
      {
        match: "/actions/runs/8/jobs",
        body: { jobs: [{ name: "docs", conclusion: "failure", html_url: "https://g/j/8" }] },
      },
    ]);

    expect((await code.getLatestCiRun(SHA))?.failedJobCount).toBe(2);
  });

  it("run が1本も無ければ null のまま", async () => {
    // 「まだ push していない」を「落ちている job は 0 件」と読まない。
    const code = provider([
      { match: "/actions/runs?", body: { total_count: 0, workflow_runs: [] } },
    ]);

    expect(await code.getLatestCiRun(SHA)).toBeNull();
  });
});

describe("1ページで読み切れていないなら数を出さない", () => {
  /**
   * `GET /actions/runs` は `per_page: 100` の1ページしか読まない。同じ head sha に
   * 紐づく run が 100 本を超えると、101 本目以降に落ちている run があっても数に
   * 入らず、`failed_job_count=0` が VERIFIED な Fact として出る。
   *
   * **それは issue #58 の「誤って収束する側の壊れ方」そのものになる。**
   * `on: pull_request_review` の gate はレビューのたびに run が増えるし、除外は
   * ページを取ったあとに走るので、除外予定の run も 100 本の枠を消費する。
   *
   * 数え切れなかったなら数を出さない。`settled()` が「終わっていない run が1本でも
   * あれば数を出さない」としているのと同じ立場を、切り捨てにも当てる。
   */
  it("total_count が件数を上回れば数を出さない", async () => {
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          // 150 本あるうち、返ってきたのは 2 本。
          total_count: 150,
          workflow_runs: [
            { id: 8, head_sha: SHA, status: "completed", conclusion: "success" },
            { id: 7, head_sha: SHA, status: "completed", conclusion: "success" },
          ],
        },
      },
    ]);

    const ci = await code.getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBeNull();
  });

  it("読み切れていなくても、最新の run から読める分は落とさない", async () => {
    // GitHub は新しい順に返すので、切り捨てられても先頭は最新のまま。
    // 数が確定しないことを理由に `conclusion` まで落とすと、いま緑の
    // `conclusion == success` を書いている Goal が丸ごと止まる。
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          total_count: 150,
          workflow_runs: [{ id: 8, head_sha: SHA, status: "completed", conclusion: "success" }],
        },
      },
    ]);

    const ci = await code.getLatestCiRun(SHA);

    expect(ci?.conclusion).toBe("success");
    expect(ci?.status).toBe("completed");
    expect(ci?.headSha).toBe(SHA);
    expect(ci?.failedJobCount).toBeNull();
  });

  it("total_count が応答に無ければ数を出さない", async () => {
    // 読めないなら「読み切れた」と決めない。ここを「切り捨て無し」に倒すと、
    // GitHub が形を変えた日に静かに 0 が出る。
    //
    // **`shape_mismatch` にはしない。** ここを必須にすると、フィールド1つ欠けた
    // 応答で `github.ci` の観測ごと落ち、`status` も `conclusion` も `head_sha` も
    // 失う（`name` と PR の `title` / `body` を nullish にしてあるのと同じ理由）。
    const code = provider([
      {
        match: "/actions/runs?",
        body: {
          workflow_runs: [{ id: 8, head_sha: SHA, status: "completed", conclusion: "success" }],
        },
      },
    ]);

    const ci = await code.getLatestCiRun(SHA);

    expect(ci?.conclusion).toBe("success");
    expect(ci?.failedJobCount).toBeNull();
  });
});
