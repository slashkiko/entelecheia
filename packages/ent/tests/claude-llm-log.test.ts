import { describe, expect, it } from "vitest";
import { type AgentQuery, claudeLlm } from "../src/adapters/claude.js";
import type { LlmCall } from "../src/domain/llm-call.js";
import { PortError } from "../src/domain/port-error.js";

/**
 * LlmPort の生ログとトークン。
 *
 * consume() はメッセージを全部集めているのに、claudeLlm はそれを捨てていた。
 * ファイルに書くのは claudeActor だけで、初めて全周させたときは
 * decisions.rationale の1行しか手がかりが残らなかった。
 *
 * トークンも同じで、DECIDE は Actor を起動しないので Run が作られず、
 * design.md §7 が求める記録先が無かった。
 */

const NOW = new Date("2026-08-09T05:00:00.000Z");

interface Sink {
  query: AgentQuery;
  logs: { path: string; contents: string }[];
  calls: LlmCall[];
}

function sink(messages: unknown[]): Sink {
  const logs: { path: string; contents: string }[] = [];
  const calls: LlmCall[] = [];
  return {
    logs,
    calls,
    query: () =>
      (async function* () {
        for (const message of messages) {
          yield message;
        }
      })(),
  };
}

function deps(s: Sink) {
  return {
    query: s.query,
    runsDir: "/tmp/entelecheia/runs",
    writeLog: async (path: string, contents: string) => {
      s.logs.push({ path, contents });
    },
    now: () => NOW,
    onCall: (call: LlmCall) => {
      s.calls.push(call);
    },
  };
}

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"type":"VERIFY"}',
  usage: { input_tokens: 1200, output_tokens: 340 },
};

const ASSISTANT = { type: "assistant", message: { content: [] } };

describe("claudeLlm の生ログ", () => {
  it("runsDir の下に log.jsonl を書く", async () => {
    // Actor と同じ粒度・同じ場所に置く（design.md §4.6）。
    const s = sink([ASSISTANT, RESULT]);
    await claudeLlm(deps(s)).chooseAction("次の行動を選べ");

    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]?.path).toMatch(/^\/tmp\/entelecheia\/runs\/decide-.*\/log\.jsonl$/);
  });

  it("受け取ったメッセージをすべて残す", () => {
    const s = sink([ASSISTANT, RESULT]);
    return claudeLlm(deps(s))
      .chooseAction("次の行動を選べ")
      .then(() => {
        const lines = (s.logs[0]?.contents ?? "").trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("assistant");
      });
  });

  it("同じティックで2回呼んでも上書きしない", async () => {
    const s = sink([RESULT, RESULT]);
    const llm = claudeLlm(deps(s));
    await llm.chooseAction("1回目");
    await llm.chooseAction("2回目");

    expect(s.logs[0]?.path).not.toBe(s.logs[1]?.path);
  });

  it("使用量上限で落ちた呼び出しもログを残す", async () => {
    // ここが最も手がかりの要る場面なのに、throw でログが消えていた。
    const s = sink([
      ASSISTANT,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      },
    ]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toBeInstanceOf(
      PortError,
    );
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]?.contents).toContain("rate_limit_event");
  });
});

describe("claudeLlm のトークン記録", () => {
  it("入力と出力の合計を通知する", async () => {
    const s = sink([RESULT]);
    await claudeLlm(deps(s)).chooseAction("次の行動を選べ");

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.tokens).toBe(1540);
    expect(s.calls[0]?.ok).toBe(true);
    expect(s.calls[0]?.purpose).toBe("decide");
    expect(s.calls[0]?.calledAt).toBe(NOW.toISOString());
  });

  it("キャッシュに載った分も数える", async () => {
    // input と output だけを足すと、実測では 16 になった。同じ応答の
    // cache_creation は 6620、cache_read は 25023 で、消費のほとんどが
    // そちらに移っている。落とすと §7 の「いくらだったか」が桁違いになる。
    const s = sink([
      {
        ...RESULT,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 6620,
          cache_read_input_tokens: 25023,
          output_tokens: 14,
        },
      },
    ]);
    await claudeLlm(deps(s)).chooseAction("次の行動を選べ");

    expect(s.calls[0]?.tokens).toBe(31659);
  });

  it("usage が無ければ 0 のまま", async () => {
    // 分からない量を捏造しない。
    const { usage: _usage, ...withoutUsage } = RESULT;
    const s = sink([withoutUsage]);
    await claudeLlm(deps(s)).chooseAction("次の行動を選べ");

    expect(s.calls[0]?.tokens).toBe(0);
  });

  it("生ログのパスを一緒に渡す", async () => {
    const s = sink([RESULT]);
    await claudeLlm(deps(s)).chooseAction("次の行動を選べ");

    expect(s.calls[0]?.logRef).toBe(s.logs[0]?.path);
  });

  it("JSON として読めない応答も記録する", async () => {
    // 採用できなかった応答もトークンは消費している。
    const s = sink([{ ...RESULT, result: "すみません、選べません" }]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toThrow();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.ok).toBe(false);
    expect(s.calls[0]?.tokens).toBe(1540);
  });

  it("Port が落ちた呼び出しも記録する", async () => {
    const s = sink([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toBeInstanceOf(
      PortError,
    );
    expect(s.calls[0]?.ok).toBe(false);
  });

  it("onCall を渡さなくても動く", async () => {
    const s = sink([RESULT]);
    const { onCall: _onCall, ...withoutSink } = deps(s);

    await expect(claudeLlm(withoutSink).chooseAction("次の行動を選べ")).resolves.toEqual({
      type: "VERIFY",
    });
  });
});
