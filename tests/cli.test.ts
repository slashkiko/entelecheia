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

  it("show は slug を取る", () => {
    expect(parseCommand(["show", "assess-and-decide"])).toEqual({
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
});
