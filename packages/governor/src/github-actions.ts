import { PortError } from "@entelecheia/core/domain/port-error.js";
import { z } from "zod";
import type { ArtifactDownload, CheckRun, CheckRunSource, RunArtifact } from "./evidence.js";
import type { SigningKeys } from "./id-token.js";

/**
 * GitHub Actions から検査の実行と artifact と、OIDC トークンを確かめる鍵を読む `CheckRunSource`。
 *
 * Octokit を使わず fetch で書く。読むのは3つの API と鍵の一覧だけで、そのために governor の
 * 依存を増やさない。トークンに要る権限は、対象のリポジトリの Actions: read。鍵の一覧は
 * トークンを付けずに読む。
 *
 * 失敗は PortError にする。成功でない状態（5xx・回数制限・認証切れ・権限不足）、ネットワーク、
 * 時間切れ、本文を読む途中で切れたものは `unavailable`（次のティックで読み直す）、応答の形が
 * 違うのは `shape_mismatch`（待っても直らない）。
 */

export interface GitHubActionsOptions {
  /** `<owner>/<name>` */
  repo: string;
  token: string;
  /**
   * GitHub Enterprise では `https://<host>/api/v3`。既定は github.com。変えるときは
   * `oidcIssuer` も渡す
   */
  apiUrl?: string;
  /**
   * OIDC トークンの発行元。鍵の一覧は `<issuer>/.well-known/jwks` から読む。GitHub Enterprise
   * Server では `https://<host>/_services/token`。既定は github.com。
   *
   * GitHub Enterprise Server では、確かめる欄（`job_workflow_ref`・`job_workflow_sha`・
   * `runner_environment` など）がトークンにあるバージョンを使う。無い欄は形の崩れとして
   * 受け取らない
   */
  oidcIssuer?: string;
  /** テストから差し替える。既定は globalThis.fetch */
  fetch?: typeof fetch;
  /** 1つの要求に待つ時間。本文を読み終えるまでを含む。既定は30秒 */
  timeoutMs?: number;
}

const API_VERSION = "2022-11-28";
/** 1つの head の sha に付く run は多くない。それを超えるほどあるなら、読み切らずに止める */
const MAX_PAGES = 10;
const PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const runsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      head_sha: z.string(),
      event: z.string(),
      status: z.string().nullable(),
      created_at: z.string(),
      run_attempt: z.number().int().positive(),
      // fork が消えると null になる
      head_repository: z.object({ full_name: z.string() }).nullable(),
      // 再利用ワークフローを呼ばない run では欠けることがある
      referenced_workflows: z
        .array(z.object({ path: z.string(), sha: z.string() }))
        .nullable()
        .optional(),
    }),
  ),
});

const artifactsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  artifacts: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      expired: z.boolean(),
      size_in_bytes: z.number().int().nonnegative(),
      digest: z.string().nullable().optional(),
    }),
  ),
});

/** 鍵の一覧（JWKS）。RSA の公開鍵の欄だけを読む */
const keysSchema = z.object({
  keys: z.array(
    z.object({
      kty: z.string(),
      kid: z.string().optional(),
      n: z.string().optional(),
      e: z.string().optional(),
    }),
  ),
});

export function gitHubActionsSource(options: GitHubActionsOptions): CheckRunSource {
  const doFetch = options.fetch ?? globalThis.fetch;
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const base = `${api}/repos/${options.repo}/actions`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "x-github-api-version": API_VERSION,
  };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // API だけを変えると、鍵は既定の発行元（token.actions.githubusercontent.com）から読み、
  // 別のホストのトークンをどれも受け取らない。
  // 間違いに気づけるのが、受け取りが止まった後になる
  if (options.apiUrl !== undefined && options.oidcIssuer === undefined) {
    throw new Error("pass oidcIssuer together with apiUrl");
  }
  const issuer = (options.oidcIssuer ?? DEFAULT_OIDC_ISSUER).replace(/\/+$/, "");

  /** 時間を区切って取る。signal は本文を読む間も効く */
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new PortError("unavailable", `request to ${url} failed: ${String(error)}`);
    }
  }

  function request(url: string, init: RequestInit = {}): Promise<Response> {
    return send(url, { ...init, headers: { ...headers, ...init.headers } });
  }

  async function getJson<S extends z.ZodType>(
    url: string,
    schema: S,
    fetchUrl: (url: string) => Promise<Response> = request,
  ): Promise<z.infer<S>> {
    const response = await fetchUrl(url);
    if (!response.ok) {
      throw await statusError(response, url);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new PortError(
        "unavailable",
        `reading the response from ${url} failed: ${String(error)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PortError("shape_mismatch", `the response from ${url} is not JSON`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new PortError(
        "shape_mismatch",
        `unexpected response from ${url}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  return {
    async listRuns(headSha) {
      const runs: CheckRun[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const query = new URLSearchParams({
          head_sha: headSha,
          event: "pull_request",
          per_page: String(PER_PAGE),
          page: String(page),
        });
        const body = await getJson(`${base}/runs?${query}`, runsSchema);
        for (const run of body.workflow_runs) {
          runs.push({
            id: run.id,
            headSha: run.head_sha,
            event: run.event,
            status: run.status ?? "unknown",
            createdAt: run.created_at,
            runAttempt: run.run_attempt,
            headRepository: run.head_repository?.full_name ?? null,
            referencedWorkflows: run.referenced_workflows ?? [],
          });
        }
        if (runs.length >= body.total_count || body.workflow_runs.length < PER_PAGE) {
          return runs;
        }
      }
      // 読み残したまま「無い」と答えると、新しい run を見落として古い報告を読む
      throw new PortError("unavailable", `more than ${MAX_PAGES * PER_PAGE} runs for ${headSha}`);
    },

    async listArtifacts(runId, name) {
      const query = new URLSearchParams({ name, per_page: String(PER_PAGE) });
      const body = await getJson(`${base}/runs/${runId}/artifacts?${query}`, artifactsSchema);
      if (body.artifacts.length < body.total_count) {
        throw new PortError(
          "unavailable",
          `run ${runId} has more than ${PER_PAGE} artifacts named ${name}`,
        );
      }
      return body.artifacts.map(
        (artifact): RunArtifact => ({
          id: artifact.id,
          name: artifact.name,
          expired: artifact.expired,
          sizeInBytes: artifact.size_in_bytes,
          digest: artifact.digest ?? null,
        }),
      );
    },

    async download(artifactId, maxBytes) {
      // API は zip の置き場へ 302 で向ける。向け先は署名付きの URL なので、トークンを付けずに
      // 取りにいく。fetch に任せて追わせると、別のホストへトークンを送るかは実装次第になる
      const url = `${base}/artifacts/${artifactId}/zip`;
      const redirect = await request(url, { redirect: "manual" });
      const location = redirect.headers.get("location");
      if (redirect.status !== 302 || location === null) {
        throw await statusError(redirect, url);
      }
      await discard(redirect);
      if (!location.startsWith("https://")) {
        throw new PortError(
          "shape_mismatch",
          `artifact ${artifactId} redirects to a non-https URL`,
        );
      }
      const response = await send(location, { redirect: "error" });
      if (!response.ok) {
        await discard(response);
        throw new PortError("unavailable", `artifact download returned ${response.status}`);
      }
      return readLimited(response, maxBytes);
    },

    async signingKeys(): Promise<SigningKeys> {
      // 鍵の一覧は公開されている。Actions のトークンを別のホストへ送らない
      const url = `${issuer}/.well-known/jwks`;
      const body = await getJson(url, keysSchema, (target) =>
        send(target, { headers: { accept: "application/json" }, redirect: "error" }),
      );
      const keys = body.keys.flatMap((key) =>
        key.kty === "RSA" && key.kid !== undefined && key.n !== undefined && key.e !== undefined
          ? [{ kid: key.kid, n: key.n, e: key.e }]
          : [],
      );
      return { issuer, keys };
    },
  };
}

/**
 * 成功でない応答。どの状態でも unavailable にし、状態の番号を message に残す。認証切れ（401）や
 * 権限不足（GitHub は 404 で返す）を止めて知らせるかは、ティックを回す側が決める
 */
async function statusError(response: Response, url: string): Promise<PortError> {
  await discard(response);
  return new PortError("unavailable", `GitHub returned ${response.status} for ${url}`);
}

/** 読まない本文を捨てる。捨てないと、長く動く governor で接続が残る */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** 本文を `maxBytes` まで読む。超えたら読むのをやめる */
async function readLimited(response: Response, maxBytes: number): Promise<ArtifactDownload> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    return { status: "too_large", bytes: declared };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { status: "ok", data: new Uint8Array() };
  }
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new PortError("unavailable", `artifact download broke off: ${String(error)}`);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { status: "too_large", bytes: null };
    }
    chunks.push(chunk.value);
  }
  return { status: "ok", data: Buffer.concat(chunks) };
}
