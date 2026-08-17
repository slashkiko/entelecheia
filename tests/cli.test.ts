import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli.js";

describe("parseCommand", () => {
  it("start は slug を取る", () => {
    expect(parseCommand(["start", "assess-and-decide"])).toEqual({
      kind: "start",
      slug: "assess-and-decide",
    });
  });

  it("run は1ティックだけ回す", () => {
    expect(parseCommand(["run", "assess-and-decide"])).toEqual({
      kind: "run",
      slug: "assess-and-decide",
    });
  });

  it("run --once は run と同じ。常駐する形は用意しない", () => {
    // design.md §3.6。--once を明示しても既定と変わらないことを型で示す。
    expect(parseCommand(["run", "assess-and-decide", "--once"])).toEqual({
      kind: "run",
      slug: "assess-and-decide",
    });
  });

  it("get は slug を取る", () => {
    // 打つのは get。判別タグは show のまま変えない（gist 3.1）。
    expect(parseCommand(["get", "assess-and-decide"])).toEqual({
      kind: "show",
      slug: "assess-and-decide",
    });
  });

  it("引数が無ければ help", () => {
    expect(parseCommand([])).toEqual({ kind: "help" });
  });

  it("--help は help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
  });

  it("知らないサブコマンドは error", () => {
    // 黙って無視すると、打ち間違いが「何も起きなかった」に見える。
    const result = parseCommand(["reconcile", "assess-and-decide"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("reconcile");
    }
  });

  it("slug が無ければ error", () => {
    // どの Goal を回すかは既定値で埋められない。
    const result = parseCommand(["run"]);
    expect(result.kind).toBe("error");
  });

  it("知らないオプションは error", () => {
    const result = parseCommand(["run", "assess-and-decide", "--forever"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("plan は slug を取らず、分解したい内容を受け取る", () => {
    expect(parseCommand(["plan", "--desire", "add plan to the CLI"])).toEqual({
      kind: "plan",
      desire: { kind: "text", value: "add plan to the CLI" },
    });
  });

  it("plan は --from でファイルから読める。読むのは cli 側なのでパスだけ運ぶ", () => {
    expect(parseCommand(["plan", "--from", "./desire.md", "--dry-run"])).toEqual({
      kind: "plan",
      desire: { kind: "file", path: "./desire.md" },
      dryRun: true,
    });
  });

  it("plan は --desire と --from の同時指定を断る", () => {
    // 片方に倒して黙って無視すると、渡したはずの文章が分解に入らないまま Goal が書かれる。
    const result = parseCommand(["plan", "--desire", "x", "--from", "./y.md"]);
    expect(result.kind).toBe("error");
  });

  it("plan は分解したい内容が無ければ error", () => {
    const result = parseCommand(["plan"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--desire");
    }
  });

  it("plan は slug を受け取らない", () => {
    // 指す先がまだ無い。打ち間違いを黙って無視しない。
    const result = parseCommand(["plan", "some-goal", "--desire", "x"]);
    expect(result.kind).toBe("error");
  });

  it("plan は --max に正の整数だけを受け取る", () => {
    expect(parseCommand(["plan", "--desire", "x", "--max", "3"])).toEqual({
      kind: "plan",
      desire: { kind: "text", value: "x" },
      max: 3,
    });
    expect(parseCommand(["plan", "--desire", "x", "--max", "0"]).kind).toBe("error");
  });
});
