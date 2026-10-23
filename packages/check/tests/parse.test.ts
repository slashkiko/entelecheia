import { describe, expect, it } from "vitest";
import { DEFAULT_TASK, DEFAULT_TIMEOUT_MINUTES, parseCommand } from "../src/parse.js";

const REQUIRED = ["--repo", "example-owner/example-app", "--base", "main", "--head", "HEAD"];

describe("ent-check の引数", () => {
  it("必須の3つだけなら既定値で埋める", () => {
    expect(parseCommand(REQUIRED)).toEqual({
      kind: "check",
      repo: "example-owner/example-app",
      base: "main",
      head: "HEAD",
      pr: null,
      dir: null,
      task: DEFAULT_TASK,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      out: null,
    });
  });

  it("全部の option を読む", () => {
    expect(
      parseCommand([
        ...REQUIRED,
        "--pr",
        "12",
        "--dir",
        "target",
        "--task",
        "check:ci",
        "--timeout-minutes",
        "5",
        "--out",
        "evidence.json",
      ]),
    ).toMatchObject({
      pr: 12,
      dir: "target",
      task: "check:ci",
      timeoutMinutes: 5,
      out: "evidence.json",
    });
  });

  it.each([
    [["--repo", "example-owner/example-app", "--base", "main"], "missing --head"],
    [["--repo", "example-app", "--base", "main", "--head", "HEAD"], "--repo must be"],
    [[...REQUIRED, "--pr", "0"], "--pr must be a positive integer"],
    [[...REQUIRED, "--pr", "1.5"], "--pr must be a positive integer"],
    [[...REQUIRED, "--timeout-minutes", "-1"], "--timeout-minutes"],
    [[...REQUIRED, "--timeout-minutes", "40000"], "--timeout-minutes must be at most 1440"],
    [[...REQUIRED, "--task=-x"], "--task is not a task name"],
    [[...REQUIRED, "--unknown"], "Unknown option"],
    [[...REQUIRED, "extra"], "Unexpected argument"],
  ])("%o は引数の誤り", (argv, message) => {
    const command = parseCommand(argv);

    expect(command.kind).toBe("error");
    expect(command.kind === "error" ? command.message : "").toContain(message);
  });

  it("--help は使い方を出す", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
  });
});
