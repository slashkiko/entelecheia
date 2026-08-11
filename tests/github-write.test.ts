import { describe, expect, it } from "vitest";
import { githubApproval, githubCodeWriter } from "../src/adapters/github.js";
import { PortError } from "../src/domain/port-error.js";
import { PROGRESS_MARKER } from "../src/publish/index.js";

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
    /**
     * login ごとのリポジトリ権限。GET /repos/{owner}/{repo}/collaborators/{u}/permission
     * が返す値をそのまま書く。省略した login は admin として扱う。
     *
     * author_association だけでは書き込み権限と等価にならない（MEMBER は org の
     * メンバー全員、COLLABORATOR は read/triage も含む）ので、承認は権限 API でも
     * 確かめる。ここはその応答にあたる。
     */
    permissions?: Record<string, string>;
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
        if (url.includes("/permission")) {
          const login = decodeURIComponent(url.split("/collaborators/")[1]?.split("/")[0] ?? "");
          return { body: { permission: fixture.permissions?.[login] ?? "admin" } };
        }
        return { body: { user: { login: fixture.author ?? "pr-author" } } };
      }).fetch,
    });

  // 既定の login を PR の作成者（`pr-author`）と別にしてある。作成者のコメントも
  // 承認に数えるので既定でも通るが、別にしておけば「作成者だから通った」のか
  // 「定型文の解釈が正しいから通った」のかを取り違えずに読める。作成者の側は
  // 専用のテスト（「PR の作成者自身が書いた定型文も承認になる」）で見る。
  const comment = (body: string, login = "teammate", association = "OWNER") => ({
    body,
    user: { login },
    created_at: "2026-08-09T06:00:00Z",
    author_association: association,
  });

  const review = (state: string, login: string, association = "COLLABORATOR") => ({
    state,
    user: { login },
    submitted_at: "2026-08-09T07:00:00Z",
    author_association: association,
  });

  describe("コメントの定型文", () => {
    it("定型文があれば承認として読む", async () => {
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6")],
      }).getApproval("ac-6");

      expect(approval).toEqual({ approvedBy: "teammate", approvedAt: "2026-08-09T06:00:00Z" });
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

      expect(approval?.approvedBy).toBe("teammate");
    });

    it("複数行のコメントでも1行として一致すれば読む", async () => {
      const approval = await approvalPort({
        comments: [comment("見ました。問題ありません。\n/ent approve ac-6")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("teammate");
    });

    it("最初に承認した人を残す", async () => {
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6", "first"), comment("/ent approve ac-6", "second")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("first");
    });

    it("書き込み権限の無い相手の定型文は承認にしない", async () => {
      // 公開リポジトリでは誰でもコメントできる。author_association を見ないと、
      // 通りすがりの1行で type: human の criterion が VERIFIED になる。
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6", "stranger", "NONE")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("CONTRIBUTOR も承認にしない", async () => {
      // 過去にマージされた PR があるだけで、書き込み権限とは別物。
      const approval = await approvalPort({
        comments: [comment("/ent approve ac-6", "past-contributor", "CONTRIBUTOR")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("author_association が取れなければ承認にしない", async () => {
      const approval = await approvalPort({
        comments: [
          {
            body: "/ent approve ac-6",
            user: { login: "pr-author" },
            created_at: "2026-08-09T06:00:00Z",
          },
        ],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("MEMBER と COLLABORATOR は承認として読む", async () => {
      for (const association of ["MEMBER", "COLLABORATOR"]) {
        const approval = await approvalPort({
          comments: [comment("/ent approve ac-6", "teammate", association)],
        }).getApproval("ac-6");

        expect(approval?.approvedBy).toBe("teammate");
      }
    });

    it("書き込み権限が無ければ、MEMBER でも COLLABORATOR でも承認にしない", async () => {
      // README は「type: human の承認は、リポジトリに書き込み権限がある人の
      // ものだけを数える」と書いている。author_association はそれと等価でない。
      // MEMBER は所有 org のメンバー全員を指し、リポジトリ単位の権限を含意しない。
      // COLLABORATOR は read / triage で招かれた相手も含む。公開リポジトリや
      // 人数のいる org では、コードを1行も変えられない相手が §9 の完了判定を
      // 通せることになる。
      for (const association of ["MEMBER", "COLLABORATOR"]) {
        for (const permission of ["read", "pull", "triage"]) {
          const approval = await approvalPort({
            comments: [comment("/ent approve ac-6", "outsider", association)],
            permissions: { outsider: permission },
          }).getApproval("ac-6");

          expect(approval).toBeNull();
        }
      }
    });

    it("権限が読めなければ throw する。未承認と同じにしない", async () => {
      // 確かめられなかったことを「権限がある」と読むと、GitHub が落ちている
      // あいだだけ誰でも承認できる窓が開く。一方、null（未承認）に畳むのも駄目で、
      // verify はそれを pending として扱う。権限 API が落ちているだけの状態が
      // 「まだ誰も承認していない」に見え、理由の分からないまま WAITING_HUMAN で
      // 止まり続ける。倒す先は throw になる（design.md §3.1）。
      const port = githubApproval({
        ...BASE,
        prNumber: 11,
        fetch: fakeFetch((url) => {
          if (url.includes("/reviews")) {
            return { body: [] };
          }
          if (url.includes("/comments")) {
            return { body: [comment("/ent approve ac-6", "teammate", "MEMBER")] };
          }
          if (url.includes("/permission")) {
            return { status: 500, body: { message: "boom" } };
          }
          return { body: { user: { login: "pr-author" } } };
        }).fetch,
      });

      await expect(port.getApproval("ac-6")).rejects.toThrow(PortError);
    });

    it("コラボレーターでなければ承認にしない（404 は確かめられた結果）", async () => {
      // 404 は「その人は権限を持っていない」を確かめられた状態なので、
      // throw ではなく未承認として返す。
      const approval = await githubApproval({
        ...BASE,
        prNumber: 11,
        fetch: fakeFetch((url) => {
          if (url.includes("/reviews")) {
            return { body: [] };
          }
          if (url.includes("/comments")) {
            return { body: [comment("/ent approve ac-6", "outsider", "MEMBER")] };
          }
          if (url.includes("/permission")) {
            return { status: 404, body: { message: "Not Found" } };
          }
          return { body: { user: { login: "pr-author" } } };
        }).fetch,
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("書き込み権限があれば承認として読む", async () => {
      // 上の2本が「常に null」で通っていないことを示す。
      for (const permission of ["push", "maintain", "admin"]) {
        const approval = await approvalPort({
          comments: [comment("/ent approve ac-6", "teammate", "MEMBER")],
          permissions: { teammate: permission },
        }).getApproval("ac-6");

        expect(approval?.approvedBy).toBe("teammate");
      }
    });

    it("PR の作成者自身が書いた定型文も承認になる", async () => {
      // 一時は作成者を弾いていたが、`GITHUB_TOKEN` の持ち主が PR を立てるので、
      // それだと1人で回しているリポジトリでは承認の signal が2つとも成立せず、
      // `type: human` の criterion を持つ Goal が永久に COMPLETED へ届かない。
      //
      // 自己承認を Agent にさせない側は、ここではなく拒否リストが受け持つ。
      // コメント投稿を落とす `external_send` は `APPROVAL_GATE_FLOOR` にあって
      // どの Goal からも外せない（`tests/protected-floor.test.ts`）。
      const approval = await approvalPort({
        author: "pr-author",
        comments: [comment("/ent approve ac-6", "pr-author")],
      }).getApproval("ac-6");

      expect(approval?.approvedBy).toBe("pr-author");
    });

    it("作成者でも、書き込み権限が無ければ承認にしない", async () => {
      // 作成者を通すようにしたぶん、権限の検査が唯一のふるいになる。
      // fork から PR を出した外部の人が、自分の PR を自分で通せてはいけない。
      const approval = await approvalPort({
        author: "outsider",
        comments: [comment("/ent approve ac-6", "outsider")],
        permissions: { outsider: "read" },
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("controller 自身の進捗コメントは承認にしない", async () => {
      // rationale には LLM が決めた intent がそのまま載る。そこに定型文を
      // 書かせれば、controller のトークンで投稿されたコメントの中に
      // 承認の1行が成立する。Agent に gh pr comment を禁じた意味が無くなる。
      const approval = await approvalPort({
        comments: [comment(`${PROGRESS_MARKER}\n### ACT\n/ent approve ac-6`)],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
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

    it("書き込み権限の無い相手の Approve は数えない", async () => {
      // 公開リポジトリでは誰でもレビューを出せる。レビュー承認は PR 全体、
      // つまり human の criteria すべてを満たすので、ここが開いていると影響が大きい。
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("APPROVED", "stranger", "NONE")],
      }).getApproval("ac-6");

      expect(approval).toBeNull();
    });

    it("権限の無い相手の変更要求は止める側に数える", async () => {
      // 承認を厳しくするのと拒否を厳しくするのは別の話で、倒す向きが逆になる。
      const approval = await approvalPort({
        author: "pr-author",
        reviews: [review("APPROVED", "reviewer"), review("CHANGES_REQUESTED", "stranger", "NONE")],
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
