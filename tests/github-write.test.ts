import { describe, expect, it } from "vitest";
import { githubApproval, githubCodeWriter } from "../src/adapters/github.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * 書き込み側と承認の検知。テストから実際の GitHub を叩かない。
 *
 * 承認の signal は PR コメントの定型文にした（design.md §10-4）。
 * §4.3 のとおり `github.pr.review_decision` は使えない。自分が作った PR に
 * Approve を押せないので、controller が Goal の所有者と同じアカウントで
 * PR を作る限り APPROVED にならない。
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Fake {
  fetch: typeof fetch;
  calls: Call[];
}

function fakeFetch(
  handler: (url: string, method: string) => { status?: number; body?: unknown },
): Fake {
  const calls: Call[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const raw = init?.body;
    calls.push({
      url,
      method,
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : null,
    });

    const route = handler(url, method);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

const BASE = { owner: "slashkiko", repo: "entelecheia", token: "t" };

describe("githubCodeWriter", () => {
  it("head ブランチの open な PR を探す", async () => {
    const fake = fakeFetch(() => ({ body: [{ number: 7 }] }));
    const found = await githubCodeWriter({ ...BASE, fetch: fake.fetch }).findPullRequest(
      "entelecheia/sample",
    );

    expect(found).toBe(7);
    // owner:branch にしないと fork からの PR を取りこぼす。
    expect(fake.calls[0]?.url).toContain("head=slashkiko%3Aentelecheia%2Fsample");
    expect(fake.calls[0]?.url).toContain("state=open");
  });

  it("見つからなければ null", async () => {
    const fake = fakeFetch(() => ({ body: [] }));
    const found = await githubCodeWriter({ ...BASE, fetch: fake.fetch }).findPullRequest("b");

    expect(found).toBeNull();
  });

  it("PR を作って番号を返す", async () => {
    const fake = fakeFetch(() => ({ status: 201, body: { number: 42 } }));
    const number = await githubCodeWriter({ ...BASE, fetch: fake.fetch }).createPullRequest({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
    });

    expect(number).toBe(42);
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls[0]?.body).toMatchObject({ head: "entelecheia/sample", base: "main" });
  });

  it("作成に失敗したら PortError を投げる", async () => {
    // 捏造した番号を返さない。
    const fake = fakeFetch(() => ({ status: 422, body: { message: "Validation Failed" } }));

    await expect(
      githubCodeWriter({ ...BASE, fetch: fake.fetch }).createPullRequest({
        head: "b",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toBeInstanceOf(PortError);
  });

  it("コメントを投稿する", async () => {
    const fake = fakeFetch(() => ({ status: 201, body: {} }));
    await githubCodeWriter({ ...BASE, fetch: fake.fetch }).addComment(11, "進捗");

    expect(fake.calls[0]?.url).toContain("/issues/11/comments");
    expect(fake.calls[0]?.body).toEqual({ body: "進捗" });
  });
});

describe("githubApproval", () => {
  const approvalPort = (comments: unknown[], prNumber: number | null = 11) =>
    githubApproval({
      ...BASE,
      prNumber,
      fetch: fakeFetch(() => ({ body: comments })).fetch,
    });

  it("定型文があれば承認として読む", async () => {
    const approval = await approvalPort([
      {
        body: "/ent approve ac-6",
        user: { login: "pr-author" },
        created_at: "2026-08-09T06:00:00Z",
      },
    ]).getApproval("ac-6");

    expect(approval).toEqual({ approvedBy: "pr-author", approvedAt: "2026-08-09T06:00:00Z" });
  });

  it("別の criterion の承認は読まない", async () => {
    const approval = await approvalPort([
      { body: "/ent approve ac-1", user: { login: "pr-author" }, created_at: "2026-08-09T06:00:00Z" },
    ]).getApproval("ac-6");

    expect(approval).toBeNull();
  });

  it("行の途中に混ざった文字列は承認にしない", async () => {
    // 引用やコード例の中の同じ文字列を承認と読むと、捏造した承認が作れてしまう。
    const approval = await approvalPort([
      {
        body: "承認するときは `/ent approve ac-6` と書いてください",
        user: { login: "pr-author" },
        created_at: "2026-08-09T06:00:00Z",
      },
    ]).getApproval("ac-6");

    expect(approval).toBeNull();
  });

  it("行頭の空白は許す", async () => {
    const approval = await approvalPort([
      {
        body: "  /ent approve ac-6  ",
        user: { login: "pr-author" },
        created_at: "2026-08-09T06:00:00Z",
      },
    ]).getApproval("ac-6");

    expect(approval?.approvedBy).toBe("pr-author");
  });

  it("複数行のコメントでも1行として一致すれば読む", async () => {
    const approval = await approvalPort([
      {
        body: "見ました。問題ありません。\n/ent approve ac-6",
        user: { login: "pr-author" },
        created_at: "2026-08-09T06:00:00Z",
      },
    ]).getApproval("ac-6");

    expect(approval?.approvedBy).toBe("pr-author");
  });

  it("コメントが無ければ未承認", async () => {
    expect(await approvalPort([]).getApproval("ac-6")).toBeNull();
  });

  it("PR がまだ無ければ未承認", async () => {
    // 承認コメントの置き場所が無い状態を「承認された」と読まない。
    expect(await approvalPort([], null).getApproval("ac-6")).toBeNull();
  });

  it("最初に承認した人を残す", async () => {
    const approval = await approvalPort([
      { body: "/ent approve ac-6", user: { login: "first" }, created_at: "2026-08-09T06:00:00Z" },
      { body: "/ent approve ac-6", user: { login: "second" }, created_at: "2026-08-09T07:00:00Z" },
    ]).getApproval("ac-6");

    expect(approval?.approvedBy).toBe("first");
  });

  it("取得に失敗したら PortError を投げる", async () => {
    // verify が unverified に積めるように、握りつぶさない。
    const port = githubApproval({
      ...BASE,
      prNumber: 11,
      fetch: fakeFetch(() => ({ status: 500, body: { message: "boom" } })).fetch,
    });

    await expect(port.getApproval("ac-6")).rejects.toBeInstanceOf(PortError);
  });
});
