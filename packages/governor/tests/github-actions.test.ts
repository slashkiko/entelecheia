import { PortError } from "@entelecheia/core/domain/port-error.js";
import { describe, expect, it } from "vitest";
import { gitHubActionsSource } from "../src/github-actions.js";

const HEAD = "a".repeat(40);
const SHA = "c".repeat(40);
const API = "https://api.example.test";
const BLOB = "https://blob.example.test/evidence.zip?sig=dummy";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** 呼ばれた URL と init を残し、URL ごとの応答を返す偽の fetch */
function fakeFetch(routes: (url: URL) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(new URL(url));
  }) as typeof fetch;
  return { calls, doFetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runJson(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    head_sha: HEAD,
    event: "pull_request",
    status: "completed",
    created_at: "2000-01-31T00:00:00Z",
    run_started_at: "2000-01-31T00:05:00Z",
    head_repository: { full_name: "example-owner/sample-shop" },
    referenced_workflows: [
      { path: `example-owner/entelecheia/.github/workflows/check.yml@${SHA}`, sha: SHA, ref: SHA },
    ],
    ...overrides,
  };
}

function sourceWith(routes: (url: URL) => Response | Promise<Response>) {
  const fake = fakeFetch(routes);
  const source = gitHubActionsSource({
    repo: "example-owner/sample-shop",
    token: "dummy-token",
    apiUrl: `${API}/`,
    fetch: fake.doFetch,
  });
  return { source, calls: fake.calls };
}

/** 先頭だけを返してから切れる本文 */
function brokenBody(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError("terminated"));
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode('{"total_count"'));
    },
  });
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name];
}

describe("GitHub Actions から run を読む", () => {
  it("head の sha と pull_request で絞り、トークンを付けて読む", async () => {
    const { source, calls } = sourceWith(() =>
      json({ total_count: 1, workflow_runs: [runJson(100)] }),
    );

    const runs = await source.listRuns(HEAD);

    expect(runs).toEqual([
      {
        id: 100,
        headSha: HEAD,
        event: "pull_request",
        status: "completed",
        createdAt: "2000-01-31T00:00:00Z",
        runStartedAt: "2000-01-31T00:05:00Z",
        headRepository: "example-owner/sample-shop",
        referencedWorkflows: [
          { path: `example-owner/entelecheia/.github/workflows/check.yml@${SHA}`, sha: SHA },
        ],
      },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/example-owner/sample-shop/actions/runs");
    expect(url.searchParams.get("head_sha")).toBe(HEAD);
    expect(url.searchParams.get("event")).toBe("pull_request");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer dummy-token");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("消えた fork から来た run は、head のリポジトリが無いと読む", async () => {
    const { source } = sourceWith(() =>
      json({ total_count: 1, workflow_runs: [runJson(100, { head_repository: null })] }),
    );

    expect((await source.listRuns(HEAD))[0]?.headRepository).toBeNull();
  });

  it("再利用ワークフローを呼ばない run は、呼んだものが無いと読む", async () => {
    const { source } = sourceWith(() =>
      json({
        total_count: 2,
        workflow_runs: [
          runJson(100, { referenced_workflows: undefined }),
          runJson(101, { referenced_workflows: null }),
        ],
      }),
    );

    const runs = await source.listRuns(HEAD);

    expect(runs.map((run) => run.referencedWorkflows)).toEqual([[], []]);
  });

  it("ページをまたいで全部読む", async () => {
    const { source, calls } = sourceWith((url) => {
      const page = Number(url.searchParams.get("page"));
      const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101];
      return json({ total_count: 101, workflow_runs: ids.map((id) => runJson(id)) });
    });

    expect(await source.listRuns(HEAD)).toHaveLength(101);
    expect(calls).toHaveLength(2);
  });

  it("読み切れないほど run があれば、読み残したまま答えない", async () => {
    // 読み残したまま返すと、新しい run を見落として古い報告を読む
    const { source } = sourceWith(() =>
      json({
        total_count: 5000,
        workflow_runs: Array.from({ length: 100 }, (_, i) => runJson(i + 1)),
      }),
    );

    await expect(source.listRuns(HEAD)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    ["5xx", () => json({ message: "boom" }, 502), "unavailable"],
    ["権限不足（404）", () => json({ message: "Not Found" }, 404), "unavailable"],
    ["形の違う応答", () => json({ runs: [] }), "shape_mismatch"],
    ["JSON でない応答", () => new Response("<html>"), "shape_mismatch"],
    [
      "ネットワークの失敗",
      () => {
        throw new TypeError("fetch failed");
      },
      "unavailable",
    ],
    // 途中で切れた本文は、形が違うのではない。次のティックで読み直せば読める
    ["本文の途中で切れた接続", () => new Response(brokenBody()), "unavailable"],
  ])("%s は PortError（%s）にする", async (_label, route, kind) => {
    const { source } = sourceWith(route);

    const error = await source.listRuns(HEAD).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ kind });
  });

  it("応答の無いまま時間が過ぎたら unavailable にする", async () => {
    // 1つの要求が止まると、ティックごと止まる。fetch は signal が切れるまで返さない
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const source = gitHubActionsSource({
      repo: "example-owner/sample-shop",
      token: "dummy-token",
      timeoutMs: 10,
      fetch: hanging,
    });

    await expect(source.listRuns(HEAD)).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("GitHub Actions から artifact を読む", () => {
  it("名前で絞って読む", async () => {
    const { source, calls } = sourceWith(() =>
      json({
        total_count: 1,
        artifacts: [
          {
            id: 500,
            name: "ent-evidence",
            expired: false,
            size_in_bytes: 321,
            digest: "sha256:00",
            created_at: "2000-01-31T00:10:00Z",
          },
        ],
      }),
    );

    expect(await source.listArtifacts(100, "ent-evidence")).toEqual([
      {
        id: 500,
        name: "ent-evidence",
        expired: false,
        sizeInBytes: 321,
        digest: "sha256:00",
        createdAt: "2000-01-31T00:10:00Z",
      },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/example-owner/sample-shop/actions/runs/100/artifacts");
    expect(url.searchParams.get("name")).toBe("ent-evidence");
  });

  it("digest の無い古い artifact は null と読む", async () => {
    const { source } = sourceWith(() =>
      json({
        total_count: 1,
        artifacts: [
          { id: 500, name: "ent-evidence", expired: false, size_in_bytes: 1, created_at: null },
        ],
      }),
    );

    expect((await source.listArtifacts(100, "ent-evidence"))[0]?.digest).toBeNull();
  });

  it("1ページに収まらないほど同じ名前の artifact があれば、読み残したまま答えない", async () => {
    // 読み残すと、2つ目の artifact を見落として1つだけと読む
    const { source } = sourceWith(() =>
      json({
        total_count: 101,
        artifacts: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          name: "ent-evidence",
          expired: false,
          size_in_bytes: 1,
          created_at: null,
        })),
      }),
    );

    await expect(source.listArtifacts(100, "ent-evidence")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("GitHub Actions から artifact を取る", () => {
  function downloadRoutes(blob: () => Response) {
    return (url: URL) => {
      if (url.origin === API) {
        return new Response(null, { status: 302, headers: { location: BLOB } });
      }
      return blob();
    };
  }

  it("向け先には、トークンを付けずに取りにいく", async () => {
    // 向け先は署名付きの URL で、GitHub の外にある。トークンを送る理由が無い
    const { source, calls } = sourceWith(downloadRoutes(() => new Response("zip-bytes")));

    const download = await source.download(500, 1024);

    expect(download.status === "ok" && Buffer.from(download.data).toString("utf8")).toBe(
      "zip-bytes",
    );
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(
      "/repos/example-owner/sample-shop/actions/artifacts/500/zip",
    );
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[1]?.url).toBe(BLOB);
    expect(headerOf(calls[1], "authorization")).toBeUndefined();
  });

  it("上限を超えたら読むのをやめる", async () => {
    const { source } = sourceWith(downloadRoutes(() => new Response("x".repeat(2048))));

    expect(await source.download(500, 1024)).toEqual({ status: "too_large", bytes: null });
  });

  it("大きさを先に名乗っていれば、本文を読まずに止める", async () => {
    const declared = 10 * 1024 * 1024;
    const { source } = sourceWith(
      downloadRoutes(
        () => new Response("small", { headers: { "content-length": String(declared) } }),
      ),
    );

    expect(await source.download(500, 1024)).toEqual({ status: "too_large", bytes: declared });
  });

  it("向け先を返さない応答は unavailable にする", async () => {
    const { source } = sourceWith(() => json({ message: "Gone" }, 410));

    await expect(source.download(500, 1024)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("https でない向け先には取りにいかない", async () => {
    const { source, calls } = sourceWith(
      () =>
        new Response(null, { status: 302, headers: { location: "http://blob.example.test/x" } }),
    );

    const error = await source.download(500, 1024).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ kind: "shape_mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("本文の途中で切れたら unavailable にする", async () => {
    const { source } = sourceWith(downloadRoutes(() => new Response(brokenBody())));

    await expect(source.download(500, 1024)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("向け先が失敗を返せば unavailable にする", async () => {
    const { source } = sourceWith(downloadRoutes(() => new Response("denied", { status: 403 })));

    await expect(source.download(500, 1024)).rejects.toMatchObject({ kind: "unavailable" });
  });
});
