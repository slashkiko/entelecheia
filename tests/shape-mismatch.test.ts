import { describe, expect, it } from "vitest";
import { githubCodeProvider } from "../src/adapters/github.js";
import { decide } from "../src/decide/index.js";
import { isShapeMismatch, isUnavailable, PortError } from "../src/domain/port-error.js";
import { observe } from "../src/observe/index.js";

/**
 * 「届かなかった」と「届いたが読めなかった」を分ける。
 *
 * `src/adapters/github.ts` は「失敗は必ず PortError にして、素の例外を controller に
 * 流さない」と書いている。ところが `.parse()` はどれも `get` / `request` の
 * try/catch の**外**にあり、応答の形だけがその約束の外にあった。抜けた ZodError は
 * observe の汎用ラッパが拾い、`port_failed` に畳んでいた。
 *
 * 何が困るかというと待ち方が変わらないこと。GitHub がフィールドを変えた、または
 * こちらのスキーマが厳しすぎる——どちらも待って直る種類ではないのに、一時的な
 * 障害として毎ティック再試行され、`max_unchanged_reconciles` に当たるまで止まらない。
 * そのあいだ人間には「GitHub が不安定」に見え、原因に辿り着けない。
 */

const BASE = { owner: "slashkiko", repo: "entelecheia", token: "t" };
const NOW = "2026-08-09T09:00:00.000Z";

/** 200 を返すが、中身が想定と違う fetch */
function malformedFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/**
 * 読めない fetch。401 を返す。
 *
 * 500 にしないのは、read 側の octokit が retry プラグイン付きで、
 * 5xx をバックオフしながら再試行するため。ここで見たいのは kind の分岐で、
 * 再試行の挙動ではない。
 */
function brokenFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("応答の形が違うとき", () => {
  it("ZodError ではなく PortError(shape_mismatch) が出る", async () => {
    // number であるべき所に文字列が来る。200 なので到達はしている。
    const provider = githubCodeProvider({
      ...BASE,
      fetch: malformedFetch({ number: "twelve", state: "open", head: { sha: "a" } }),
    });

    const error = await provider.getPullRequest(12).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PortError);
    expect(isShapeMismatch(error)).toBe(true);
    expect(isUnavailable(error)).toBe(false);
  });

  it("到達できない場合は unavailable のまま", async () => {
    // 2つを取り違えていないこと。500 は待てば直りうる。
    const provider = githubCodeProvider({ ...BASE, fetch: brokenFetch() });

    const error = await provider.getPullRequest(12).catch((e: unknown) => e);

    expect(isUnavailable(error)).toBe(true);
    expect(isShapeMismatch(error)).toBe(false);
  });

  it("observe が shape_mismatch を port_failed に畳まない", async () => {
    // ここが畳まれていると、恒久的な不一致が一時的な障害として再試行され続ける。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      {
        code: {
          getPullRequest: async () => {
            throw new PortError("shape_mismatch", "GET /pulls: 応答の形が想定と違う");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
        local: {
          snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
        },
        now: () => new Date("2026-08-09T09:00:00.000Z"),
      },
    );

    const unobserved = result.unobserved.find((u) => u.key.startsWith("github.pr"));
    expect(unobserved?.reason).toBe("shape_mismatch");
  });

  it("到達できなかった観測は port_failed のまま", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      {
        code: {
          getPullRequest: async () => {
            throw new PortError("unavailable", "GET /pulls: 500");
          },
          getLatestCiRun: async () => null,
          getIssue: async () => null,
        },
        local: {
          snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
        },
        now: () => new Date("2026-08-09T09:00:00.000Z"),
      },
    );

    const unobserved = result.unobserved.find((u) => u.key.startsWith("github.pr"));
    expect(unobserved?.reason).toBe("port_failed");
  });
});

describe("shape_mismatch の待ち理由", () => {
  it("観測できていない扱いにする。CI 待ちに化けさせない", async () => {
    // 恒久的なスキーマ不一致が ci_running を名乗ると、人間には「CI を待っている」
    // ように見えて原因に辿り着けない。しかも Gap ゼロの WAIT はループ検知より
    // 手前で return するので、予算に当たるまでそのラベルで回り続ける。
    // reason を足した意味がここで消える。
    const decision = await decide(
      {
        criteria: [
          {
            id: "ac-1",
            description: "テストが通る",
            verification: { type: "command", run: "mise run test" },
          },
        ],
        assessment: { assessedAt: NOW, gaps: [], satisfied: true },
        unresolved: [
          { key: "github.pr", reason: "shape_mismatch", detail: "応答の形が想定と違う" },
        ],
        observedDigest: "digest",
        budget: {
          max_actor_runs: 10,
          max_reconciles: 20,
          max_wall_clock: "2h",
          max_consecutive_failures: 3,
          max_unchanged_reconciles: 9,
        },
        usage: {
          actorRuns: 0,
          reconciles: 1,
          consecutiveFailures: 0,
          elapsedSeconds: 0,
          trailingDigest: { digest: null, count: 0 },
        },
      },
      {
        llm: {
          chooseAction: async () => {
            throw new Error("guard が決めるので LLM は呼ばれない");
          },
        },
        now: () => new Date(NOW),
      },
    );

    expect(decision.action).toMatchObject({ type: "WAIT", reason: "observation_failed" });
  });
});
