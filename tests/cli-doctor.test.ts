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
      { slug: "record-the-tick", error: null },
      { slug: "list-goals", error: null },
    ],
    stateWritable: async () => true,
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
    expect(parseCommand(["show", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
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

  it("Goal YAML が読めなければ、どの slug かと理由を残す", async () => {
    const report = await doctorPayload(
      probes({
        loadGoals: async () => [
          { slug: "record-the-tick", error: null },
          { slug: "broken-goal", error: "budget.max_unchanged_reconciles が無い" },
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

  it("unknown だけでは失敗にしない", async () => {
    // 確かめられなかったことを不合格として扱うと、doctor が常に赤くなって読まれなくなる。
    const report = await doctorPayload(probes());

    expect(report.checks.some((c) => c.result === "unknown")).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  it("JSON にできる形で返す。ent show と同じく機械可読を保つ", async () => {
    const report = await doctorPayload(probes());

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    for (const check of report.checks) {
      expect(["ok", "failed", "unknown"]).toContain(check.result);
      expect(typeof check.name).toBe("string");
      expect(typeof check.detail).toBe("string");
    }
  });
});
