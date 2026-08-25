import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { Goal } from "../src/domain/goal.js";
import { openStore } from "../src/store/sqlite.js";
import {
  type CostPriceFile,
  costPayload,
  parseCostPriceFile,
  type TokenCategories,
} from "../src/usecase/cost.js";

const AT = "2026-08-25T01:02:03.000Z";
const REPO_ROOT = join(import.meta.dirname, "..");

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "cost-goal",
    name: "cost",
    desired_state: "raw logs can be priced",
    depends_on: [],
  },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [
    {
      id: "ac-1",
      description: "cost is numeric",
      verification: { type: "command", run: "exit 0" },
    },
  ],
  context: { background: "cost", constraints: [], references: [] },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 1,
    max_reconciles: 1,
    max_wall_clock: "1h",
    max_consecutive_failures: 1,
    max_unchanged_reconciles: 1,
  },
};

let originalCwd = "";
let tempRoot: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCwd !== "") {
    process.chdir(originalCwd);
    originalCwd = "";
  }
  if (tempRoot !== null) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function enterTempRepo(): string {
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(join(tmpdir(), "ent-cost-"));
  process.chdir(tempRoot);
  return tempRoot;
}

function captureOutput(): string[] {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return stdout;
}

function priceFile(root: string): string {
  const path = join(root, "prices.json");
  writeFileSync(
    path,
    JSON.stringify({
      unit: "usd_per_million_tokens",
      prices: {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    }),
  );
  return path;
}

function claudeOAuthLog(): string {
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      apiKeySource: "oauth",
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      },
    }),
    "",
  ].join("\n");
}

function codexDecideLog(): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        // cached は input の内数。価格計算では通常入力 40 + cache read 10 になる。
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    }),
    "",
  ].join("\n");
}

describe("ent cost", () => {
  it("Run と DECIDE LlmCall の4分類を価格に掛け、Claude OAuth だけ charged USD から外す", async () => {
    const root = enterTempRepo();
    const stateDir = join(root, ".goals", ".state");
    const logsDir = join(stateDir, "runs");
    mkdirSync(logsDir, { recursive: true });

    const runLog = join(logsDir, "1.jsonl");
    const callLog = join(logsDir, "decide.jsonl");
    writeFileSync(runLog, claudeOAuthLog());
    writeFileSync(callLog, codexDecideLog());

    const dbPath = join(stateDir, "goals.db");
    const store = openStore(dbPath);
    store.upsertGoal(GOAL);
    const runId = store.startRun(GOAL.goal.id, {
      intent: "implement",
      actor: "claude-code",
      role: "implement",
      worktree: "cost-goal",
      attempt: 1,
      startedAt: AT,
    });
    store.finishRun(runId, {
      status: "completed",
      finishedAt: AT,
      exitCode: 0,
      logRef: runLog,
      // OAuth でも Run.tokens は消さない。生ログの4分類との照合にも使う。
      tokens: 190,
      artifacts: [],
      detail: null,
    });
    store.recordLlmCall(GOAL.goal.id, {
      purpose: "decide",
      // DECIDE は Run を作らず、この列に残る。
      tokens: 70,
      logRef: callLog,
      ok: true,
      calledAt: AT,
    });
    store.close();

    const stdout = captureOutput();
    expect(await main(["cost", GOAL.goal.id, "--prices", priceFile(root), "--json"])).toBe(0);

    const payload = JSON.parse(stdout.join("")) as {
      token_usage: Record<string, number>;
      charged_token_usage: Record<string, number>;
      metered_usd: number;
      charged_usd: number;
      oauth_metered_usd: number;
      sources: { runs: number; llm_calls: number };
    };
    expect(payload.token_usage).toEqual({
      input_tokens: 140,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 40,
      output_tokens: 60,
    });
    expect(payload.charged_token_usage).toEqual({
      input_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
      output_tokens: 20,
    });
    expect(payload.metered_usd).toBe(0.00054);
    expect(payload.charged_usd).toBe(0.00015);
    expect(payload.oauth_metered_usd).toBe(0.00039);
    expect(payload.sources).toEqual({ runs: 1, llm_calls: 1 });

    // cost は既存の記録を集計するだけで、OAuth の token 記録を消さない。
    const reopened = openStore(dbPath);
    expect(reopened.listRuns(GOAL.goal.id)[0]?.tokens).toBe(190);
    expect(reopened.listLlmCalls(GOAL.goal.id)[0]?.tokens).toBe(70);
    reopened.close();
  });

  it("まだ state DB が無くても example price file を検証し、numeric metered_usd=0 を返す", async () => {
    const root = enterTempRepo();
    const stdout = captureOutput();

    expect(
      await main([
        "cost",
        "not-started",
        "--prices",
        join(REPO_ROOT, "examples", "prices.example.json"),
        "--json",
      ]),
    ).toBe(0);

    const payload = JSON.parse(stdout.join("")) as { metered_usd: unknown };
    expect(typeof payload.metered_usd).toBe("number");
    expect(payload.metered_usd).toBe(0);
    expect(existsSync(join(root, ".goals", ".state"))).toBe(false);
  });
});

/** Claude の生ログ。`apiKeySource` が OAuth かどうかの唯一の手がかりになる。 */
function claudeLog(apiKeySource: string, usage: TokenCategories): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", apiKeySource }),
    JSON.stringify({ type: "result", subtype: "success", usage }),
    "",
  ].join("\n");
}

function totalOf(usage: TokenCategories): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  );
}

/**
 * 1 Run と 1 LlmCall を持つ state DB を組み、`costPayload` をそのまま呼ぶ。
 *
 * CLI 越しではなく usecase を直接呼ぶのは、見たいものが stdout の形ではなく
 * 集計の中身のため。stdout に出ることと `--prices` の受け口は、上の
 * `describe("ent cost")` が端から端まで通して見ている。
 */
function payloadFor(
  runUsage: TokenCategories,
  runApiKeySource: string,
  callUsage: TokenCategories,
  prices: CostPriceFile,
): ReturnType<typeof costPayload> {
  const root = enterTempRepo();
  const logsDir = join(root, ".goals", ".state", "runs");
  mkdirSync(logsDir, { recursive: true });

  const runLog = join(logsDir, "run.jsonl");
  const callLog = join(logsDir, "decide.jsonl");
  writeFileSync(runLog, claudeLog(runApiKeySource, runUsage));
  writeFileSync(callLog, claudeLog("api_key", callUsage));

  const store = openStore(join(root, ".goals", ".state", "goals.db"));
  try {
    store.upsertGoal(GOAL);
    const runId = store.startRun(GOAL.goal.id, {
      intent: "implement",
      actor: "claude-code",
      role: "implement",
      worktree: "cost-goal",
      attempt: 1,
      startedAt: AT,
    });
    store.finishRun(runId, {
      status: "completed",
      finishedAt: AT,
      exitCode: 0,
      logRef: runLog,
      tokens: totalOf(runUsage),
      artifacts: [],
      detail: null,
    });
    store.recordLlmCall(GOAL.goal.id, {
      purpose: "decide",
      tokens: totalOf(callUsage),
      logRef: callLog,
      ok: true,
      calledAt: AT,
    });
    return costPayload(GOAL.goal.id, store, prices, {
      readLog: (path) => readFileSync(path, "utf8"),
    });
  } finally {
    store.close();
  }
}

const EXAMPLE_PRICES = parseCostPriceFile(
  readFileSync(join(REPO_ROOT, "examples", "prices.example.json"), "utf8"),
);

describe("生ログから読む4分類", () => {
  it("Run と LlmCall の両方を読み、分類ごとに合算する", () => {
    // Run（Actor 実行）と LlmCall（Run を作らない DECIDE）は別の列に残る。
    // 片方だけ読むと、その分の使用量が金額から静かに落ちる。
    const payload = payloadFor(
      {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
        output_tokens: 400,
      },
      "api_key",
      {
        input_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 100,
        output_tokens: 25,
      },
      EXAMPLE_PRICES,
    );

    // 総量ではなく分類ごとに出す。単価が分類ごとに違う以上、合計だけでは
    // 金額を出せない（cache read と output で 40 倍の開きがある）。
    expect(payload.token_usage).toEqual({
      input_tokens: 1050,
      cache_creation_input_tokens: 210,
      cache_read_input_tokens: 3100,
      output_tokens: 425,
    });
    expect(payload.sources).toEqual({ runs: 1, llm_calls: 1 });
  });
});

describe("宣言した単価から出る額", () => {
  it("端数のある単価でも、期待どおりの額をそのまま出す", () => {
    // 実データで観測した内訳をそのまま置く。`cache_read` の単価 0.1 を
    // 6,304,256 tokens に掛けると、丸めずに出したときは 1.0519446 ではなく
    // 1.0519446000000001 になった。二進小数の出方であって金額ではない。
    const payload = payloadFor(
      {
        input_tokens: 222651,
        cache_creation_input_tokens: 32540,
        cache_read_input_tokens: 6304256,
        output_tokens: 33447,
      },
      "api_key",
      {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      EXAMPLE_PRICES,
    );

    // 222651*1 + 32540*2 + 6304256*0.1 + 33447*4 = 1,051,944.6 → /1e6
    expect(payload.metered_usd).toBe(1.0519446);
    // 単価は examples/prices.example.json 側の宣言。ent には焼き込まない。
    expect(EXAMPLE_PRICES.unit).toBe("usd_per_million_tokens");
  });

  it("価格表が無ければ金額を出さない。既定の単価に落ちない", () => {
    // 既定値を1つでも置くと、価格表を渡し忘れた日に「それらしい額」が出る。
    expect(() => parseCostPriceFile(JSON.stringify({ unit: "usd_per_million_tokens" }))).toThrow();
    expect(() => parseCostPriceFile("{ not json")).toThrow(/price file as JSON/);
  });
});

describe("Claude Max OAuth の扱い", () => {
  it("token は記録したまま、charged USD からだけ外す", () => {
    const oauthUsage = {
      input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
      output_tokens: 400,
    };
    const meteredUsage = {
      input_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 100,
      output_tokens: 25,
    };
    const payload = payloadFor(oauthUsage, "oauth", meteredUsage, EXAMPLE_PRICES);

    // 記録は消さない。OAuth 実行がどれだけ回ったかは規模の指標として要る。
    expect(payload.token_usage).toEqual({
      input_tokens: 1050,
      cache_creation_input_tokens: 210,
      cache_read_input_tokens: 3100,
      output_tokens: 425,
    });
    // 課金対象からは OAuth の分がまるごと落ちる。
    expect(payload.charged_token_usage).toEqual(meteredUsage);

    // 50*1 + 10*2 + 100*0.1 + 25*4 = 180 → /1e6
    expect(payload.charged_usd).toBe(0.00018);
    // 1000*1 + 200*2 + 3000*0.1 + 400*4 = 3300 → /1e6
    expect(payload.oauth_metered_usd).toBe(0.0033);
    // 仮想の metered には入る。「OAuth で回した分が幾らに相当したか」は見える。
    expect(payload.metered_usd).toBe(0.00348);
    expect(payload.charged_usd + payload.oauth_metered_usd).toBeCloseTo(payload.metered_usd, 12);
    // 課金額は仮想 metered より必ず小さい。ここが等しくなったら除外が効いていない。
    expect(payload.charged_usd).toBeLessThan(payload.metered_usd);
  });
});
