import { describe, expect, it, vi } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import { type CodexCommand, type CodexExec, codexActor, codexLlm } from "../src/adapters/codex.js";
import { PortError } from "../src/domain/port-error.js";

const NOW = new Date("2026-08-11T01:02:03.000Z");

function invocation(role: ActorInvocation["role"] = "implement"): ActorInvocation {
  return {
    runId: "run-1",
    goalId: "g",
    intent: "失敗しているテストを直す",
    role,
    worktree: { path: "/tmp/worktree", branch: "entelecheia/g" },
    deniedOperations: ["merge", "secret_access", "external_send"],
    signal: new AbortController().signal,
  };
}

function success(finalMessage = "完了した"): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "src/example.ts" }] },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: finalMessage },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_output_tokens: 10,
      },
    }),
    "",
  ].join("\n");
}

function harness(stdout = success(), exitCode = 0, stderr = "") {
  const commands: CodexCommand[] = [];
  const logs = new Map<string, string>();
  const exec: CodexExec = async (command) => {
    commands.push(command);
    return { exitCode, stdout, stderr };
  };
  return {
    commands,
    logs,
    options: {
      runsDir: "/runs",
      exec,
      writeLog: async (path: string, contents: string) => {
        logs.set(path, contents);
      },
      now: () => NOW,
      env: {
        PATH: "/bin",
        GITHUB_TOKEN: "secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "openai-secret",
        CODEX_HOME: "/codex",
      },
    },
  };
}

describe("codexActor", () => {
  it("codex exec の JSONL を Run の結果に変換する", async () => {
    const h = harness();
    const result = await codexActor(h.options).run(invocation());

    expect(result).toEqual({
      exitCode: 0,
      logRef: "/runs/run-1/log.jsonl",
      tokens: 120,
      artifacts: ["src/example.ts"],
    });
    expect(h.logs.get(result.logRef)).toBe(success());
  });

  it("実装役だけ workspace-write にし、ホスト設定を読み込まない", async () => {
    const h = harness();
    await codexActor({ ...h.options, model: "gpt-test", effort: "high" }).run(invocation());

    const command = h.commands[0];
    expect(command?.args).toContain("workspace-write");
    expect(command?.args).toContain("--ignore-user-config");
    expect(command?.args).toContain("--ignore-rules");
    expect(command?.args).toContain("--ephemeral");
    expect(command?.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command?.args).toContain("gpt-test");
    expect(command?.args).toContain('model_reasoning_effort="high"');
    expect(command?.prompt).toContain("失敗しているテストを直す");
    expect(command?.prompt).toContain("external_send");
  });

  it("レビュー役と調査役は read-only にする", async () => {
    for (const role of ["review", "investigate"] as const) {
      const h = harness();
      await codexActor(h.options).run(invocation(role));

      expect(h.commands[0]?.args).toContain("read-only");
      expect(h.commands[0]?.prompt).toContain("Do not modify files");
    }
  });

  it("レビュー役へ Goal と検査対象 commit の出力契約を渡す", async () => {
    const h = harness();
    await codexActor(h.options).run(invocation("review"));

    expect(h.commands[0]?.prompt).toContain(".goals/g.yaml");
    expect(h.commands[0]?.prompt).toContain("reviewed_sha: <the 40-hex sha confirmed in step 1>");
    expect(h.commands[0]?.prompt).toContain("verdict: <either approved or changes_requested>");
  });

  it("レビュー役へ semantic-review の本文を差し込む", async () => {
    // Codex CLI には repo の中の skill を渡す口が無い。**契約は Claude Code と
    // 同じにする**ので、観点は本文ごとプロンプトに載る（`SkillDelivery`）。
    const h = harness();
    await codexActor(h.options).run(invocation("review"));

    expect(h.commands[0]?.prompt).toContain("name: semantic-review");
    expect(h.commands[0]?.prompt).toContain("| INSUFFICIENT_CONTEXT | changes_requested |");
    expect(h.commands[0]?.prompt).not.toContain("with the Skill tool");
  });

  it("GitHub と別 provider の資格情報を子プロセスへ渡さない", async () => {
    const h = harness();
    await codexActor(h.options).run(invocation());

    expect(h.commands[0]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(h.commands[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(h.commands[0]?.env.OPENAI_API_KEY).toBe("openai-secret");
    expect(h.commands[0]?.env.CODEX_HOME).toBe("/codex");
  });

  it("明示的な usage limit は Run に分類と使用量を残す", async () => {
    const h = harness(
      `${JSON.stringify({ type: "error", message: "You have reached your usage limit" })}\n`,
      1,
    );

    await expect(codexActor(h.options).run(invocation())).resolves.toMatchObject({
      exitCode: 1,
      errorKind: "usage_limit",
      // 文面に時刻が無い形。既定の待ちを置くのは guard の側なので、ここは null。
      resumeAfter: null,
    });
  });

  it("usage limit の文面から再開時刻を読む", async () => {
    // 実物の文面。序数（`20th`）が入るので `Date.parse` はそのままでは NaN を返す。
    const message =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
      "to purchase more credits or try again at Aug 20th, 2026 9:00 PM.";
    const h = harness(`${JSON.stringify({ type: "error", message })}\n`, 1);

    const result = await codexActor(h.options).run(invocation());

    // **タイムゾーンは書かれていない。** 走っているマシンのローカル時刻として読む
    // ので、期待値もここで同じように組み立てる。固定の ISO を書くと、TZ の違う
    // マシンで落ちるだけのテストになる。
    expect(result.resumeAfter).toBe(new Date("Aug 20, 2026 9:00 PM").toISOString());
    // 読めたときは detail に注記を足さない。
    expect(result.detail).toBe(message);
    expect(h.logs.get(result.logRef)).toContain('"type":"ent.codex.usage_limit_reset"');
  });

  it("再開時刻が読めなければ、読もうとした文字列を残す", async () => {
    // 時刻の形が変わった場合。**黙って捨てない。** Run の detail と生ログの
    // 両方に、読もうとした文字列を残す。
    const message = "You've hit your usage limit. Try again at some point next week.";
    const h = harness(`${JSON.stringify({ type: "error", message })}\n`, 1);

    const result = await codexActor(h.options).run(invocation());

    expect(result.resumeAfter).toBeNull();
    expect(result.detail).toContain("some point next week");
    expect(result.detail).toContain("could not read a reset time");
    expect(h.logs.get(result.logRef)).toContain('"text":"some point next week"');
    expect(h.logs.get(result.logRef)).toContain('"resume_after":null');
  });

  it("過去を指す再開時刻は読めなかったものとして扱う", async () => {
    // いま上限に当たった直後なので、過去の時刻は時計のずれか誤読になる。そのまま
    // 入れると `sleepingUntil` が「起きてよい」を返し、毎ティック当たり直す。
    const message = "You've hit your usage limit. Try again at Aug 1, 2026 9:00 PM.";
    const h = harness(`${JSON.stringify({ type: "error", message })}\n`, 1);

    const result = await codexActor(h.options).run(invocation());

    expect(result.resumeAfter).toBeNull();
    expect(result.detail).toContain("Aug 1, 2026 9:00 PM");
  });

  it("最終メッセージの後に turn.failed が来たら成功扱いしない", async () => {
    const stdout = `${success()}${JSON.stringify({ type: "turn.failed", error: "late failure" })}\n`;
    const h = harness(stdout);

    await expect(codexActor(h.options).run(invocation())).resolves.toMatchObject({
      exitCode: 1,
      errorKind: "unavailable",
      detail: "late failure",
    });
  });

  it("stderr を合成イベントとして生ログへ残す", async () => {
    const h = harness("", 1, "not logged in");
    const result = await codexActor(h.options).run(invocation());

    expect(result.exitCode).toBe(1);
    expect(h.logs.get(result.logRef)).toContain('"type":"ent.codex.stderr"');
    expect(h.logs.get(result.logRef)).toContain("not logged in");
  });
});

describe("codexLlm", () => {
  it("最後の agent_message を JSON として返し、使用量を通知する", async () => {
    const h = harness(success('{"type":"REPLAN"}'));
    const calls = vi.fn();

    await expect(
      codexLlm({ ...h.options, onCall: calls }).chooseAction("次を決める"),
    ).resolves.toEqual({
      type: "REPLAN",
    });
    expect(calls).toHaveBeenCalledWith({
      purpose: "decide",
      tokens: 120,
      logRef: "/runs/decide-2026-08-11T01-02-03-000Z-1/log.jsonl",
      ok: true,
      calledAt: NOW.toISOString(),
    });
    expect(h.commands[0]?.args).toContain("read-only");
  });

  it("非ゼロ終了を unavailable にし、失敗した呼び出しも通知する", async () => {
    const h = harness(`${JSON.stringify({ type: "error", message: "not logged in" })}\n`, 1);
    const calls = vi.fn();

    await expect(
      codexLlm({ ...h.options, onCall: calls }).chooseAction("次を決める"),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof PortError && error.kind === "unavailable",
    );
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ ok: false, tokens: 0 }));
  });

  it("DECIDE の usage limit も、読めた再開時刻を PortError に載せる", async () => {
    // ここで落とすと、DECIDE 側の WAIT(usage_limit) が毎ティック起き直す
    // （`resumeAfterOf`）。Actor 側と同じ経路にしておく。
    const message = "You've hit your usage limit. Try again at Aug 20th, 2026 9:00 PM.";
    const h = harness(`${JSON.stringify({ type: "error", message })}\n`, 1);

    await expect(codexLlm(h.options).chooseAction("次を決める")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PortError &&
        error.kind === "usage_limit" &&
        error.resumeAfter === new Date("Aug 20, 2026 9:00 PM").toISOString(),
    );
  });

  it("壊れた JSON を成功扱いしない", async () => {
    const h = harness(success("これは JSON ではない"));
    const calls = vi.fn();

    await expect(
      codexLlm({ ...h.options, onCall: calls }).chooseAction("次を決める"),
    ).rejects.toThrow();
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ ok: false, tokens: 120 }));
  });

  it("最終メッセージの後に failure event が来たら拒否する", async () => {
    const stdout = `${success('{"type":"REPLAN"}')}${JSON.stringify({ type: "turn.failed", error: "late failure" })}\n`;
    const h = harness(stdout);
    const calls = vi.fn();

    await expect(
      codexLlm({ ...h.options, onCall: calls }).chooseAction("次を決める"),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof PortError && error.kind === "unavailable",
    );
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ ok: false, tokens: 120 }));
  });

  it("生ログの保存に失敗しても使用量を1回だけ通知する", async () => {
    const h = harness(success('{"type":"REPLAN"}'));
    const calls = vi.fn();

    await expect(
      codexLlm({
        ...h.options,
        writeLog: async () => {
          throw new Error("disk full");
        },
        onCall: calls,
      }).chooseAction("次を決める"),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof PortError && error.kind === "unavailable",
    );
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ ok: false, tokens: 120 }));
  });
});
