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

/**
 * 承認は2つの signal で検知する。どちらか一方でも成立すれば承認になる。
 *
 * 1. GitHub のレビュー承認 — 他人が Approve を押す。仕事で使うときの本来の経路
 * 2. PR コメントの定型文 — レビュアーがいない状況でも承認できる経路
 *
 * §4.3 が言うとおり 1 だけには頼れない。自分が作った PR に Approve を押せないので、
 * 1人で開発しているあいだは永久に成立しない。成立しないだけで誤りではないため、
 * 経路は残したうえで 2 を足してある。
 */
describe("githubApproval", () => {
  interface Fixture {
    author?: string;
    reviews?: unknown[];
    comments?: unknown[];
    prNumber?: number | null;
  }

  const approvalPort = (fixture: Fixture) =>
    githubApproval({
      ...BASE,
      prNumber: fixture.prNumber === undefined ? 11 : fixture.prNumber,
      fetch: fakeFetch((url) => {
        if (url.includes("/reviews")) {
          return { body: fixture.reviews ?? [] };
        }
        if (url.includes("/comments")) {
          return { body: fixture.comments ?? [] };
        }
        return { body: { user: { login: fixture.author ?? "pr-author" } } };
      }).fetch,
    });

  const comment = (body: string, login = "pr-author") => ({
    body,
    user: { login },
    created_at: "2026-08-09T06:00:00Z",
  });

  const review = (state: string, login: string) => ({
    state,
    user: { login },
    submitted_at: "2026-08-09T07:00:00Z",
  });

  describe("コメントの定型文", () => {
    it("定型文があれば承認として読む", async () => {
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6")],
      }).getApproval("ac-6");

      expect(approval).toEqual({ approvedBy: "pr-author", approvedAt: "2026-08-09T06:00:00Z" });
    });

    it("別の criterion の承認は読まない", async () => {
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-1")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("行の途中に混ざった文字列は承認にしない", async () => {
      // 引用やコード例の中の同じ文字列を承認と読むと、捏造した承認が作れてしまう。
      const approval = await approvalPort({
        comments: [comment("承認は `/ent approve ac-6` と書いてください")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("行頭の空白は許す", async () => {
      const approval = await approvalPort({
        comments: [comment("  /ent approve ac-6  ")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("pr-author");
    });

    it("複数行のコメントでも1行として一致すれば読む", async () => {
      const approval = await approvalPort({
        comments: [comment("見ました。問題ありません。\n/ent approve ac-6")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("pr-author");
    });

    it("最初に承認した人を残す", async () => {
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6", "first"), comment("/ent approve ac-6", "second")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("first");
    });
  });

  describe("レビュー承認", () => {
    it("他人の Approve を承認として読む", async () => {
      // 仕事で使うときの本来の経路。
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("APPROVED", "reviewer")],
      }).getApproval("ac-6");

      expect(approval).toEqual({ approvedBy: "reviewer", approvedAt: "2026-08-09T07:00:00Z" });
    });

    it("レビュー承認は human の criteria すべてを満たす", async () => {
      // PR 全体に対する承認なので criterion を選べない。
      const port = approvalPort({ author: "pr-author", reviews: [review("APPROVED", "reviewer")] });

      expect(await port.getApproval("ac-6")).not.toBeNull();
      expect(await port.getApproval("ac-7")).not.toBeNull();
    });

    it("作成者自身の Approve は数えない", async () => {
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("APPROVED", "pr-author")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("変更要求が残っていれば承認しない", async () => {
      // 変更を求められている PR を承認済みと読むのは矛盾している。
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("APPROVED", "a"), review("CHANGES_REQUESTED", "b")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("変更要求はコメントの定型文より優先する", async () => {
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("CHANGES_REQUESTED", "b")],
        comments: [comment("/ent approve ac-6")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("同じ人の最後のレビューだけを見る", async () => {
      // 変更要求のあとに承認し直した場合は承認として読む。
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("CHANGES_REQUESTED", "b"), review("APPROVED", "b")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("b");
    });

    it("COMMENTED は承認ではない", async () => {
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("COMMENTED", "reviewer")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });
  });

  it("承認がどこにも無ければ null", async () => {
    expect(await approvalPort({}).getApproval("ac-6")).toBeNull();
  });

  it("PR がまだ無ければ未承認", async () => {
    // 承認の置き場所が無い状態を「承認された」と読まない。
    expect(await approvalPort({ prNumber: null }).getApproval("ac-6")).toBeNull();
  });

  it("criteria をまたいで同じ PR を引き直さない", async () => {
    // 1ティックで criteria の数だけ呼ばれる。毎回3本叩くとレート制限を無駄に使う。
    const fake = fakeFetch((url) =>
      url.includes("/reviews") || url.includes("/comments")
        ? { body: [] }
        : { body: { user: null } },
    );
    const port = githubApproval({ ...BASE, prNumber: 11, fetch: fake.fetch });

    await port.getApproval("ac-6");
    await port.getApproval("ac-7");

    expect(fake.calls).toHaveLength(3);
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
