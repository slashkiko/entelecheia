import { describe, expect, it } from "vitest";
import { githubCodeProvider } from "../src/adapters/github.js";

/**
 * 未解決レビュースレッドの件数を GitHub から読む（issue #64 の案1）。
 *
 * テストから実際の GitHub を叩かない。fetch を注入して octokit の下を差し替える
 * （tests/github-adapter.test.ts と同じ形）。
 *
 * REST には「スレッドが解決済みか」を表すフィールドが無い。`pulls/{n}/comments` が
 * 返すのは個々のレビューコメントだけで、解決状態は GraphQL の
 * `pullRequest.reviewThreads.isResolved` にしか出ない。design.md §4.3 は
 * 「GraphQL なら1回で取れるが ETag が効くのは REST の GET だけ」という理由で
 * `review_decision` を REST から導出しているが、こちらは REST に相当物が無いので
 * 例外にあたる。ETag が効かないぶん、この読み取りだけは毎ティック実際に飛ぶ。
 *
 * その代わり、**この読み取りの失敗を PR の観測全体に波及させない**。
 * 落ちたときは件数を null にして、`number` / `state` / `head_sha` /
 * `review_decision` は埋めたまま返す。throw すると observe が
 * `github.pr` をまとめて unobserved に落とすので、この Fact を1文字も
 * 参照していない Goal まで PR が見えなくなる。
 */

const HEAD = "a".repeat(40);

/** REST の PR 応答。tests/github-adapter.test.ts と同じ形 */
const PR_BODY = {
  number: 12,
  state: "open",
  merged: false,
  mergeable: true,
  head: { sha: HEAD },
  requested_reviewers: [{ login: "alice" }],
};

interface GraphqlReply {
  status?: number;
  body: unknown;
}

/** `reviewThreads` の応答。実際の GitHub が返す形に合わせてある */
function threads(
  totalCount: number,
  nodes: readonly { isResolved: boolean }[],
  hasNextPage = false,
): GraphqlReply {
  return {
    body: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount,
              nodes: [...nodes],
              pageInfo: { hasNextPage, endCursor: hasNextPage ? "Y3Vyc29yOjEwMA==" : null },
            },
          },
        },
      },
    },
  };
}

function resolved(count: number): { isResolved: boolean }[] {
  return Array.from({ length: count }, () => ({ isResolved: true }));
}

/**
 * GraphQL への応答を並べた provider を作る。
 * REST の2本（PR 本体とレビュー一覧）は常に同じものを返す。
 */
function provider(replies: readonly GraphqlReply[]) {
  const queue = [...replies];
  const graphqlCalls: string[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/graphql")) {
      graphqlCalls.push(String(init?.body ?? ""));
      const reply = queue.shift();
      if (reply === undefined) {
        return json({ message: "Not Found" }, 404);
      }
      return json(reply.body, reply.status ?? 200);
    }
    if (url.includes("/pulls/12/reviews")) {
      return json([]);
    }
    if (url.includes("/pulls/12")) {
      return json(PR_BODY);
    }
    return json({ message: "Not Found" }, 404);
  };

  return {
    code: githubCodeProvider({
      owner: "slashkiko",
      repo: "entelecheia",
      token: "ghp_test",
      fetch: impl as unknown as typeof fetch,
    }),
    graphqlCalls,
  };
}

describe("githubCodeProvider の未解決スレッド数", () => {
  it("未解決のスレッドだけを数える", async () => {
    const { code } = provider([
      threads(3, [{ isResolved: false }, { isResolved: true }, { isResolved: false }]),
    ]);

    const pr = await code.getPullRequest(12);

    expect(pr?.unresolvedThreads).toBe(2);
  });

  it("スレッドが1件も無ければ 0 にする", async () => {
    const { code } = provider([threads(0, [])]);

    const pr = await code.getPullRequest(12);

    // null ではない。「レビューされていない」ことは観測できている。
    expect(pr?.unresolvedThreads).toBe(0);
  });

  it("すべて解決済みなら 0 にする", async () => {
    const { code } = provider([threads(2, resolved(2))]);

    const pr = await code.getPullRequest(12);

    expect(pr?.unresolvedThreads).toBe(0);
  });

  it("全件を見られなかったときは件数を作らない", async () => {
    // 1ページ目が全部解決済みでも、残り 50 件に未解決が混じっていれば
    // 実際の答えは 0 ではない。数え切れなかったぶんを 0 と読むと、
    // 指摘を残したまま `equals: 0` が成立する。
    const { code } = provider([threads(150, resolved(100), true)]);

    const pr = await code.getPullRequest(12);

    expect(pr?.unresolvedThreads).toBeNull();
  });

  it("GraphQL が失敗しても throw せず、他のフィールドは埋める", async () => {
    // 権限不足のときに実際に返る形。HTTP は 200 で、本文に errors が入る。
    const { code } = provider([
      {
        body: {
          data: { repository: null },
          errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
        },
      },
    ]);

    const pr = await code.getPullRequest(12);

    expect(pr?.unresolvedThreads).toBeNull();
    expect(pr?.number).toBe(12);
    expect(pr?.state).toBe("open");
    expect(pr?.headSha).toBe(HEAD);
    expect(pr?.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("応答の形が想定と違っても throw せず、他のフィールドは埋める", async () => {
    const malformed: GraphqlReply[] = [
      // GitHub がフィールド名を変えた場合。
      { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: [{}] } } } } } },
      // GraphQL 側からは PR が見えなかった場合。
      { body: { data: { repository: { pullRequest: null } } } },
    ];

    for (const reply of malformed) {
      const { code } = provider([reply]);

      const pr = await code.getPullRequest(12);

      expect(pr?.unresolvedThreads).toBeNull();
      expect(pr?.number).toBe(12);
      expect(pr?.headSha).toBe(HEAD);
    }
  });

  it("PR が無ければ GraphQL を引かない", async () => {
    const { code, graphqlCalls } = provider([threads(0, [])]);

    // REST が 404 を返す PR。存在しない対象のスレッドを数えに行かない。
    const pr = await code.getPullRequest(999);

    expect(pr).toBeNull();
    expect(graphqlCalls).toEqual([]);
  });
});
