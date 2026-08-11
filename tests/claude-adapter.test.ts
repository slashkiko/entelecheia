import { describe, expect, it } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import {
  type AgentQuery,
  CLAUDE_ACTOR_WITHHELD_ENV,
  claudeActor,
  claudeLlm,
} from "../src/adapters/claude.js";
import { PortError } from "../src/domain/port-error.js";
import { NEUTRALIZED_ENV } from "../src/domain/withheld-env.js";

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
  goalId: "sample",
  intent: "テストの失敗を直す",
  role: "implement",
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
    // インスタンスであることだけを見ていると、外から来た signal と繋がって
    // いなくても緑になる。実際に伝播することまで確かめる。
    expect(options.abortController?.signal.aborted).toBe(false);
    controller.abort();
    expect(options.abortController?.signal.aborted).toBe(true);
  });

  it("起動前に中断されていれば SDK 側も中断済みで渡す", async () => {
    const sink = recorded([SUCCESS]);
    const controller = new AbortController();
    controller.abort();
    await claudeActor(deps(sink)).run({ ...INVOCATION, signal: controller.signal });

    const options = sink.options[0] as { abortController?: AbortController };
    expect(options.abortController?.signal.aborted).toBe(true);
  });

  it("承認が要る操作を禁止ツールに落とす", async () => {
    // merge や force push を Agent に実行させない（design.md §7）。
    // 件数だけを見ていたころは、external_send を空にしても merge を
    // 旧コロン形式に戻しても緑のまま通った。中身まで固定する。
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run({
      ...INVOCATION,
      deniedOperations: ["merge", "external_send"],
    });

    const options = sink.options[0] as { disallowedTools?: string[] };
    expect(options.disallowedTools).toEqual([
      // Goal の設定によらず常に拒否する分。関門が観測に使っている前提を
      // Actor 側から壊せないようにする（base の ref を消すと commit 済みの
      // 違反が diff から消え、changedPaths が「変更なし」を返した）。
      "Bash(git update-ref *)",
      "Bash(git symbolic-ref *)",
      "Bash(git branch -D *)",
      "Bash(git branch -d *)",
      "Bash(git branch --delete *)",
      // ref を前に進める側も塞ぐ。`git branch -f main HEAD` でローカルの base を
      // 揃えると `<base>...HEAD` の差分が空になり、push だけが ahead を数える。
      "Bash(git branch -f *)",
      "Bash(git branch --force *)",
      "Bash(git fetch . *)",
      "Bash(git push . *)",
      "Bash(git worktree *)",
      // hooks の差し替えも常に拒否する。core.hooksPath を1回設定するだけで、
      // hooks のファイルを1つも触らずに、push のたびに走るスクリプト群を
      // まるごと別のディレクトリへ移せる。
      "Bash(git config core.hooksPath *)",
      "Bash(git config --local core.hooksPath *)",
      "Bash(git config --global core.hooksPath *)",
      "Bash(git merge)",
      "Bash(git merge *)",
      "Bash(gh pr merge *)",
      "Bash(curl *)",
      "Bash(gh api --method POST *)",
      "Bash(gh pr create *)",
      "Bash(gh pr comment *)",
      "Bash(gh issue comment *)",
    ]);
  });

  it("承認ゲートが空でも、関門の前提を壊す呼び出しは拒否する", async () => {
    // Goal が require_human_approval を1つも書かなくても、
    // base の ref を消す経路は塞ぐ。消されると、違反を commit してから
    // ref を消すだけで changedPaths が「変更なし」を返した。
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run({ ...INVOCATION, deniedOperations: [] });

    const options = sink.options[0] as { disallowedTools?: string[] };
    expect(options.disallowedTools).toContain("Bash(git update-ref *)");
    expect(options.disallowedTools).toContain("Bash(git worktree *)");
  });

  it("使ってよいツールと設定源を固定する", async () => {
    // settingSources を省くと、ホストの ~/.claude と repo の .claude が
    // すべて読まれ、controller が与えた拒否リスト以外の設定が混ざる。
    const sink = recorded([SUCCESS]);
    await claudeActor(deps(sink)).run(INVOCATION);

    expect(sink.options[0]).toMatchObject({
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "Bash", "TodoWrite"],
      permissionMode: "dontAsk",
      settingSources: [],
    });
  });

  it("controller の資格情報を Agent に渡さない", async () => {
    // Bash を許している以上 printenv も echo $GITHUB_TOKEN も実行できる。
    // どちらも secret_access の拒否パターンに一致しないので、拒否リストでは塞げない。
    //
    // 落とすキーは CLAUDE_ACTOR_WITHHELD_ENV から組み立てる。テスト側に同じ一覧を書き写すと、
    // 実装からキーが1つ減っても緑のまま通る。
    const secrets = Object.fromEntries(
      CLAUDE_ACTOR_WITHHELD_ENV.map((key) => [key, `secret-${key}`]),
    );
    const kept = { PATH: "/usr/bin", HOME: "/home/x" };
    const sink = recorded([SUCCESS]);
    await claudeActor({ ...deps(sink), env: { ...kept, ...secrets } }).run(INVOCATION);

    const options = sink.options[0] as { env?: Record<string, string> };
    expect(options.env).toEqual({ ...kept, ...NEUTRALIZED_ENV });
    // 一覧が空になっていないことも見る。空なら上の toEqual は素通りする。
    expect(CLAUDE_ACTOR_WITHHELD_ENV).toContain("GITHUB_TOKEN");
    expect(CLAUDE_ACTOR_WITHHELD_ENV).toContain("OPENAI_API_KEY");
  });

  it("Agent の中の gh を未認証にする", async () => {
    // トークンを落としても `HOME` は渡すので、`gh` はホストのログインで通る。
    // `/ent approve` は PR の作成者が書いても承認になる（design.md §10-4）ため、
    // Agent がコメントを1件投稿できれば自分の criterion を自分で通せる。
    // 拒否リストは glob なので `gh api -X POST` のような別綴りで抜けられる。
    // 資格情報そのものを届かせない側で塞ぐ。
    const sink = recorded([SUCCESS]);
    await claudeActor({
      ...deps(sink),
      env: { HOME: "/home/x", GH_CONFIG_DIR: "/home/x/.config/gh" },
    }).run(INVOCATION);

    const options = sink.options[0] as { env?: Record<string, string> };
    expect(options.env?.GH_CONFIG_DIR).toBe(NEUTRALIZED_ENV.GH_CONFIG_DIR);
    expect(options.env?.HOME).toBe("/home/x");
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

describe("claudeActor と中断", () => {
  it("中断されたら throw せず logRef を持って返る", async () => {
    // act が catch すると logRef を落とす。実際に SIGTERM を送ったとき、
    // 31KB のログがファイルにあるのに Run からは辿れない状態になった。
    const aborter = new AbortController();
    const sink = recorded([]);
    const failing: AgentQuery = () =>
      (async function* () {
        aborter.abort();
        yield { type: "assistant", message: { content: [] } };
        throw new Error("Claude Code process aborted by user");
      })();

    const result = await claudeActor({ ...deps(sink), query: failing }).run({
      ...INVOCATION,
      signal: aborter.signal,
    });

    expect(result.exitCode).toBe(1);
    expect(result.logRef).toBe("/tmp/entelecheia/runs/42/log.jsonl");
    expect(sink.logs).toHaveLength(1);
  });

  it("中断されていなければ throw をそのまま伝える", async () => {
    // 中断でない失敗を握ると、Actor が落ちたことが Run に残らない。
    const sink = recorded([]);
    const failing: AgentQuery = () =>
      (async function* () {
        yield { type: "assistant", message: { content: [] } };
        throw new Error("spawn ENOENT");
      })();

    await expect(claudeActor({ ...deps(sink), query: failing }).run(INVOCATION)).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
