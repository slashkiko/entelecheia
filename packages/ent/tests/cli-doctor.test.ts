import { describe, expect, it } from "vitest";
import { type DoctorProbes, doctorPayload, parseCommand } from "../src/cli.js";

/**
 * `ent doctor`。ティックを回す前に、前提が揃っているかを読み取り専用で確かめる。
 *
 * 6セッションを通して同じ形の摩擦が繰り返し起きた。入れ子の Claude Code が
 * 未ログインで LLM 呼び出しが全滅した。`GITHUB_TOKEN` が無いまま回して、
 * `github.ci.conclusion` が永久に unobserved になり ac-5 が埋まらなかった。
 * どれも記録には残っていて、気づけないだけだった。
 *
 * `ent run` の入口で落とす形にはしない。`main()` が書いているとおり、トークンが
 * 無くてもローカルの観測・検証コマンド・Actor の実行は進められる。入口で殺すと
 * 進められるものまで止まる。副作用のない別のサブコマンドとして分ける。
 *
 * 正直に作る。決定的に検査できるのは3つだけで、Claude のログイン状態は
 * トークンを消費せずには確かめられない。それを ok と偽らず `unknown` として出す。
 * 「確かめられなかったこと」を「問題なし」に畳まないのが design.md §3.1 の趣旨で、
 * doctor もそれに従う。
 *
 * `ent` が PATH に無い（`ent not found`）は ent 自身には直せないので対象外にする。
 */

function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    githubToken: () => "gho_xxx",
    loadGoals: async () => [
      { slug: "record-the-tick", error: null, dependsOn: [] },
      { slug: "list-goals", error: null, dependsOn: [] },
    ],
    stateWritable: async () => true,
    // 別のリポジトリで回せるかを見るための3つ。ここを見ないと、対象リポジトリで
    // 躓いたときに「なぜ動かないか」が例外の形でしか出てこない。
    nodeVersion: () => "v24.18.1",
    gitRepository: async () => true,
    stateIgnored: async () => true,
    ...over,
  };
}

describe("parseCommand と doctor", () => {
  it("doctor は slug を取らない", () => {
    expect(parseCommand(["doctor"])).toEqual({ kind: "doctor" });
  });

  it("余分な引数は error", () => {
    expect(parseCommand(["doctor", "sample-goal"]).kind).toBe("error");
  });

  it("知らないオプションは error", () => {
    expect(parseCommand(["doctor", "--fix"]).kind).toBe("error");
  });

  it("既存のサブコマンドを壊さない", () => {
    expect(parseCommand(["list"])).toEqual({ kind: "list" });
    expect(parseCommand(["get", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
  });
});

describe("doctorPayload", () => {
  it("すべて揃っていれば ok になり、終了コードは 0", async () => {
    const report = await doctorPayload(probes());

    expect(report.exitCode).toBe(0);
    expect(report.checks.every((c) => c.result !== "failed")).toBe(true);
  });

  it("GITHUB_TOKEN が無ければ failed にし、何が観測できなくなるかを書く", async () => {
    const report = await doctorPayload(probes({ githubToken: () => null }));

    const check = report.checks.find((c) => c.name === "github_token");
    expect(check?.result).toBe("failed");
    expect(check?.detail).toContain("github");
    expect(report.exitCode).toBe(1);
  });

  it("token が読めないときは、環境変数だけでなく gh も候補だったことを書く", async () => {
    // 環境変数を渡し忘れただけで毎回赤くなる検査は読まれなくなり、本当に
    // 落ちた回を見落とす。読む順（GITHUB_TOKEN → GH_TOKEN → gh auth token）を
    // 落ちたときのメッセージにも出して、次に何をすればよいかを1行で示す。
    const report = await doctorPayload(probes({ githubToken: () => null }));

    const check = report.checks.find((c) => c.name === "github_token");
    expect(check?.detail).toContain("gh auth token");
  });

  it("token を渡さないと決めた場合も failed として出す", async () => {
    // 空文字は「読めなかった」ではなく「渡さないと決めた」。doctor は
    // どちらも failed にする。GitHub の観測が埋まらないことに変わりはない。
    const report = await doctorPayload(probes({ githubToken: () => "" }));

    expect(report.checks.find((c) => c.name === "github_token")?.result).toBe("failed");
  });

  it("token を読めた検査は、値そのものを出さない", async () => {
    const report = await doctorPayload(probes({ githubToken: () => "gho_secret" }));

    const check = report.checks.find((c) => c.name === "github_token");
    expect(check?.result).toBe("ok");
    expect(check?.detail).not.toContain("gho_secret");
  });

  it("Goal YAML が読めなければ、どの slug かと理由を残す", async () => {
    const report = await doctorPayload(
      probes({
        loadGoals: async () => [
          { slug: "record-the-tick", error: null, dependsOn: [] },
          {
            slug: "broken-goal",
            error: "budget.max_unchanged_reconciles が無い",
            dependsOn: [],
          },
        ],
      }),
    );

    const check = report.checks.find((c) => c.name === "goals");
    expect(check?.result).toBe("failed");
    expect(check?.detail).toContain("broken-goal");
    expect(check?.detail).toContain("max_unchanged_reconciles");
  });

  it("state ディレクトリに書けなければ failed", async () => {
    const report = await doctorPayload(probes({ stateWritable: async () => false }));

    expect(report.checks.find((c) => c.name === "state_dir")?.result).toBe("failed");
    expect(report.exitCode).toBe(1);
  });

  it("Claude のログイン状態は ok と偽らず unknown にする", async () => {
    // トークンを消費せずには確かめられない。分からないものは分からないまま残す。
    const report = await doctorPayload(probes());

    const check = report.checks.find((c) => c.name === "claude_login");
    expect(check?.result).toBe("unknown");
    expect(check?.detail.length).toBeGreaterThan(0);
  });

  it("Codex を選んだときは Codex のログイン確認方法を出す", async () => {
    const report = await doctorPayload(probes({ actorKind: () => "codex" }));

    const check = report.checks.find((c) => c.name === "codex_login");
    expect(check?.result).toBe("unknown");
    expect(check?.detail).toContain("codex login status");
    expect(report.checks.some((c) => c.name === "claude_login")).toBe(false);
  });

  it("phase ごとに実行主体が違うときは両方のログイン前提を出す", async () => {
    const report = await doctorPayload(
      probes({ actorKinds: () => ["claude-code", "codex", "codex"] }),
    );

    expect(report.checks.filter((c) => c.name === "claude_login")).toHaveLength(1);
    expect(report.checks.filter((c) => c.name === "codex_login")).toHaveLength(1);
  });

  it("unknown だけでは失敗にしない", async () => {
    // 確かめられなかったことを不合格として扱うと、doctor が常に赤くなって読まれなくなる。
    const report = await doctorPayload(probes());

    expect(report.checks.some((c) => c.result === "unknown")).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  it("Node が 24 未満なら failed。必要なバージョンと実際のバージョンを両方書く", async () => {
    // node:sqlite（src/store/sqlite.ts）が Node 24 以上を要求する。足りない Node で
    // 叩かれると import が例外になり、ent の話だとメッセージから読み取れない。
    // 対象リポジトリ側の Node が使われる構成——shebang の /usr/bin/env node、
    // mise や nvm を効かせた shell——では必ず起きる。
    const report = await doctorPayload(probes({ nodeVersion: () => "v22.14.0" }));

    const check = report.checks.find((c) => c.name === "node_version");
    expect(check?.result).toBe("failed");
    expect(check?.detail).toContain("24");
    expect(check?.detail).toContain("22.14.0");
    expect(report.exitCode).toBe(1);
  });

  it("Node が足りていれば ok", async () => {
    const report = await doctorPayload(probes({ nodeVersion: () => "v24.0.0" }));

    expect(report.checks.find((c) => c.name === "node_version")?.result).toBe("ok");
  });

  it("git リポジトリでなければ failed", async () => {
    // controller は worktree を作れないし、.goals/.state/ の gitignore も
    // 意味を持たない。回す前に分かる。
    const report = await doctorPayload(probes({ gitRepository: async () => false }));

    const check = report.checks.find((c) => c.name === "git_repository");
    expect(check?.result).toBe("failed");
    expect(report.exitCode).toBe(1);
  });

  it(".goals/.state/ が gitignore されていなければ failed。何が git に載るかを書く", async () => {
    // 状態 DB・worktree・Agent の生ログが対象リポジトリの git に載る。
    // 気づかないまま commit されるので、回す前に言う。
    const report = await doctorPayload(probes({ stateIgnored: async () => false }));

    const check = report.checks.find((c) => c.name === "state_ignored");
    expect(check?.result).toBe("failed");
    expect(check?.detail).toContain(".goals/.state");
    expect(report.exitCode).toBe(1);
  });

  it("gitignore を確かめられなければ unknown にする", async () => {
    // git に聞けなかったのを「無視できていない」に畳むと、doctor が常に赤くなる。
    const report = await doctorPayload(probes({ stateIgnored: async () => null }));

    expect(report.checks.find((c) => c.name === "state_ignored")?.result).toBe("unknown");
    expect(report.exitCode).toBe(0);
  });

  it(".goals/ がまだ無いときは、次に叩くものが detail から読める", async () => {
    // 「読めなかった」だけだと、壊れているのか、まだ始めていないのかが
    // 読み分けられない。対象リポジトリで最初に叩くものを名指しする。
    const report = await doctorPayload(
      probes({
        loadGoals: async () => {
          throw new Error("ENOENT: no such file or directory, scandir '.goals'");
        },
      }),
    );

    const check = report.checks.find((c) => c.name === "goals");
    expect(check?.result).toBe("failed");
    expect(check?.detail).toContain("ent init");
  });

  it("JSON にできる形で返す。ent get と同じく機械可読を保つ", async () => {
    const report = await doctorPayload(probes());

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    for (const check of report.checks) {
      expect(["ok", "failed", "unknown"]).toContain(check.result);
      expect(typeof check.name).toBe("string");
      expect(typeof check.detail).toBe("string");
    }
  });
});
