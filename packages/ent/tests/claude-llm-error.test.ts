import { describe, expect, it } from "vitest";
import { type AgentQuery, claudeLlm } from "../src/adapters/claude.js";
import type { LlmCall } from "../src/domain/llm-call.js";
import { isUnavailable, PortError } from "../src/domain/port-error.js";

/**
 * 呼び直しても直らない失敗を、そうと分かる形で返す。
 *
 * `decide` の `askLlm()` は `PortError(unavailable)` を見て即 ESCALATE する。
 * `src/domain/port-error.ts` のコメントも「未ログイン、モデル名の誤り、認証切れは
 * ここに来る」と書いている。ところが `claudeLlm` は `consume()` が組み立てた
 * `result.ok` を一度も見ておらず、エラー result の本文をそのまま `parseJson()` に
 * 渡して素の Error を投げるだけだった。そのため `isUnavailable` の経路に乗らず、
 * `MAX_LLM_RETRIES` 回まで呼び直される。
 *
 * 初めて `ent run` を全周させたとき、`Not logged in · Please run /login` を
 * 3回とも呼び直して同じ失敗を繰り返した。1回の呼び出しは Claude Code の
 * フルセッションで実測3万トークンを超えるので、ティック内の再試行は高くつく。
 *
 * 一時的な失敗まで即 ESCALATE になるが、`unavailable` が抑止するのは1ティックの
 * 中での呼び直しだけで、次のティックでは普通に再試行される（`port-error.ts`）。
 * result の subtype からは一時的か恒久的かを判別できないので、推測しない。
 * 代わりに subtype と本文をメッセージに載せ、rationale から人間が判別できるようにする。
 *
 * ActorPort（`claudeActor`）は変えない。あちらは `ok` を exitCode 1 に落とし、
 * それが Run の failed として `consecutiveFailures` の予算会計に流れる別の失敗モデルを
 * 既に持っている。throw に変えると act 側の記録の設計と衝突する。
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

/** 未ログインのときに Claude Code が返す result。is_error が立つ */
const NOT_LOGGED_IN = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "Not logged in · Please run /login",
  usage: { input_tokens: 2, cache_read_input_tokens: 25_023, output_tokens: 14 },
};

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"type":"VERIFY"}',
  usage: { input_tokens: 1200, output_tokens: 340 },
};

describe("claudeLlm がエラー result を返したとき", () => {
  it("PortError(unavailable) を投げる", async () => {
    const s = sink([NOT_LOGGED_IN]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toSatisfy(
      isUnavailable,
    );
  });

  it("メッセージに subtype と result 本文を残す", async () => {
    // 何が起きたかを rationale から人間が判別できるようにする。
    const s = sink([NOT_LOGGED_IN]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toThrow(
      /error_during_execution/,
    );

    const s2 = sink([NOT_LOGGED_IN]);
    await expect(claudeLlm(deps(s2)).chooseAction("次の行動を選べ")).rejects.toThrow(
      /Not logged in/,
    );
  });

  it("result が来ないままストリームが終わっても PortError(unavailable) を投げる", async () => {
    // 途中で切れたのに空の出力として扱うと、壊れた出力と区別できなくなる。
    const s = sink([{ type: "assistant", message: { content: [] } }]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toSatisfy(
      isUnavailable,
    );
  });

  it("実際に消費したトークンを ok: false で記録する", async () => {
    // consume は成功しているのでトークン数は分かっている。0 で記録すると
    // design.md §7 の会計が実際より小さく出る。
    const s = sink([NOT_LOGGED_IN]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toBeInstanceOf(
      PortError,
    );
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.ok).toBe(false);
    expect(s.calls[0]?.tokens).toBe(25_039);
  });

  it("生ログは残す", async () => {
    const s = sink([NOT_LOGGED_IN]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.toBeInstanceOf(
      PortError,
    );
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]?.contents).toContain("Not logged in");
  });

  it("成功した呼び出しの扱いは変えない", async () => {
    const s = sink([SUCCESS]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).resolves.toEqual({
      type: "VERIFY",
    });
  });

  it("採用できる result だが中身が JSON でないときは PortError にしない", async () => {
    // 出力が壊れているのは「呼べなかった」ではない。次の試行で直りうるので
    // 再試行の回数に載せる（design.md §3.5）。
    const s = sink([{ ...SUCCESS, result: "すみません、選べません" }]);

    await expect(claudeLlm(deps(s)).chooseAction("次の行動を選べ")).rejects.not.toSatisfy(
      isUnavailable,
    );
  });
});
