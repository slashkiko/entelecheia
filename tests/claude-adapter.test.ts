import { describe, expect, it } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import { type AgentQuery, claudeActor, claudeLlm } from "../src/adapters/claude.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * テストから実際の Claude Code を起動しない。query() を注入して差し替える。
 * メッセージの形は Agent SDK の型定義から写してある。
 */

interface Recorded {
  query: AgentQuery;
  prompts: string[];
  options: unknown[];
  logs: { path: string; contents: string }[];
}

function recorded(messages: unknown[]): Recorded {
  const prompts: string[] = [];
  const options: unknown[] = [];
  const logs: { path: string; contents: string }[] = [];

  return {
    prompts,
    options,
    logs,
    query: (params) => {
      prompts.push(params.prompt);
      options.push(params.options);
      return (async function* () {
        for (const message of messages) {
          yield message;
        }
      })();
    },
  };
}

function deps(sink: Recorded) {
  return {
    query: sink.query,
    runsDir: "/tmp/entelecheia/runs",
    writeLog: async (path: string, contents: string) => {
      sink.logs.push({ path, contents });
    },
  };
}

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "直しました",
  num_turns: 3,
  total_cost_usd: 0.12,
  usage: { input_tokens: 1200, output_tokens: 340 },
};

const INVOCATION: ActorInvocation = {
  runId: "42",
  intent: "テストの失敗を直す",
  worktree: { path: "/tmp/entelecheia/worktrees/sample", branch: "entelecheia/sample" },
  deniedOperations: ["merge", "force_push"],
  signal: new AbortController().signal,
};

describe("claudeActor", () => {
  it("intent をそのままプロンプトにする", async () => {
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run(INVOCATION);

    expect(sink.prompts[0]).toContain("テストの失敗を直す");
  });

  it("worktree を cwd にする", async () => {
    // controller 本体のコードと Agent が編集するコードを物理的に分ける（design.md §7）。
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run(INVOCATION);

    expect(sink.options[0]).toMatchObject({ cwd: "/tmp/entelecheia/worktrees/sample" });
  });

  it("signal を SDK に渡す", async () => {
    // SIGTERM を受けたら走行中の Actor を kill する（design.md §3.6）。
    const sink = recorded([SUCCESS]);
    const controller = new AbortController();
    await claudeActor(deps(sink)).run({ ...INVOCATION, signal: controller.signal });

    const options = sink.options[0] as { abortController?: AbortController };
    expect(options.abortController).toBeInstanceOf(AbortController);
  });

  it("承認が要る操作を禁止ツールに落とす", async () => {
    // merge や force push を Agent に実行させない（design.md §7）。
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run(INVOCATION);

    const options = sink.options[0] as { disallowedTools?: string[] };
    expect(options.disallowedTools?.length).toBeGreaterThan(0);
  });

  it("トークンを記録する", async () => {
    // Claude Max 経由でも記録する。あとから単価をかけられるように（design.md §7）。
    const sink = recorded([SUCCESS]);
    const result = await claudeActor(deps(sink)).run(INVOCATION);

    expect(result.tokens).toBe(1540);
    expect(result.exitCode).toBe(0);
  });

  it("失敗した result は exitCode が 0 以外になる", async () => {
    const failure = { type: "result", subtype: "error_during_execution", is_error: true };
    const sink = recorded([failure]);
    const result = await claudeActor(deps(sink)).run(INVOCATION);

    expect(result.exitCode).not.toBe(0);
  });

  it("result が来なければ失敗として返す", async () => {
    // 途中で切れた実行を成功にすると、捏造した成功になる。
    const sink = recorded([{ type: "assistant", message: { content: [] } }]);
    const result = await claudeActor(deps(sink)).run(INVOCATION);

    expect(result.exitCode).not.toBe(0);
  });

  it("生ログはファイルに書き、logRef にはパスだけ返す", async () => {
    // 数十MBの文字列を DB に入れない（design.md §4.6）。
    const sink = recorded([SUCCESS]);
    const result = await claudeActor(deps(sink)).run(INVOCATION);

    expect(sink.logs.length).toBe(1);
    expect(result.logRef).toBe(sink.logs[0]?.path);
    // run ごとにディレクトリを分ける（design.md §4.6）。
    expect(result.logRef).toBe("/tmp/entelecheia/runs/42/log.jsonl");
    expect(sink.logs[0]?.contents).toContain("result");
  });

  it("編集したファイルを artifacts に残す", async () => {
    const edited = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/w/src/foo.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Write", input: { file_path: "/w/src/bar.ts" } },
        ],
      },
    };
    const sink = recorded([edited, SUCCESS]);
    const result = await claudeActor(deps(sink)).run(INVOCATION);

    expect(result.artifacts).toEqual(["/w/src/foo.ts", "/w/src/bar.ts"]);
  });

  it("使用量上限に当たったら PortError(usage_limit) を投げる", async () => {
    // design.md §10-3。rate_limit_event の status が rejected なら上限。
    const rejected = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: Date.parse("2026-08-09T08:00:00.000Z"),
        rateLimitType: "five_hour",
      },
    };
    const sink = recorded([rejected]);

    await expect(claudeActor(deps(sink)).run(INVOCATION)).rejects.toMatchObject({
      name: "PortError",
      kind: "usage_limit",
      resumeAfter: "2026-08-09T08:00:00.000Z",
    });
  });

  it("rejected を見たあとの assistant error は上限として扱う", async () => {
    // こちらの経路ではリセット時刻が分からないので resumeAfter は null。
    const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected" } };
    const limited = { type: "assistant", error: "rate_limit", message: { content: [] } };
    const sink = recorded([rejected, limited]);

    await expect(claudeActor(deps(sink)).run(INVOCATION)).rejects.toMatchObject({
      kind: "usage_limit",
      resumeAfter: null,
    });
  });

  it("上限を見ていない assistant error は一時的な 429 として扱う", async () => {
    // Claude Code は一時的な容量制限にも同じ "rate_limit" を入れる。
    // 上限として扱うと、待たなくてよい場面で待つことになる。
    const limited = { type: "assistant", error: "rate_limit", message: { content: [] } };
    const sink = recorded([limited]);

    await expect(claudeActor(deps(sink)).run(INVOCATION)).rejects.toMatchObject({
      name: "PortError",
      kind: "unavailable",
    });
  });

  it("上限に達していない rate_limit_event は無視する", async () => {
    const warning = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } };
    const sink = recorded([warning, SUCCESS]);

    expect((await claudeActor(deps(sink)).run(INVOCATION)).exitCode).toBe(0);
  });
});

describe("claudeLlm", () => {
  function jsonResult(text: string): unknown {
    return { ...SUCCESS, result: text };
  }

  it("JSON を解釈して返す", async () => {
    const sink = recorded([jsonResult('{"type":"VERIFY"}')]);
    const value = await claudeLlm(deps(sink)).chooseAction("次の行動を選べ");

    expect(value).toEqual({ type: "VERIFY" });
  });

  it("コードフェンスで囲まれていても読める", async () => {
    const sink = recorded([jsonResult('```json\n{"type":"REPLAN"}\n```')]);
    expect(await claudeLlm(deps(sink)).chooseAction("...")).toEqual({ type: "REPLAN" });
  });

  it("JSON として読めなければ throw する", async () => {
    // 空オブジェクトを返すと、decide が「検証に落ちた」と「呼べなかった」を
    // 区別できなくなる。
    const sink = recorded([jsonResult("すみません、分かりません")]);

    await expect(claudeLlm(deps(sink)).chooseAction("...")).rejects.toThrow();
  });

  it("プロンプトをそのまま渡す", async () => {
    const sink = recorded([jsonResult("{}")]);
    await claudeLlm(deps(sink)).chooseAction("ac-1 が落ちている");

    expect(sink.prompts[0]).toContain("ac-1 が落ちている");
  });

  it("ファイルを触らせない", async () => {
    // DECIDE は判断だけで、副作用は ACT が持つ。
    const sink = recorded([jsonResult("{}")]);
    await claudeLlm(deps(sink)).chooseAction("...");

    const options = sink.options[0] as { allowedTools?: string[]; disallowedTools?: string[] };
    expect(options.allowedTools ?? []).toEqual([]);
  });

  it("使用量上限は PortError で返す", async () => {
    const rejected = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Date.parse("2026-08-09T08:00:00.000Z") },
    };
    const sink = recorded([rejected]);

    await expect(claudeLlm(deps(sink)).chooseAction("...")).rejects.toBeInstanceOf(PortError);
  });
});
