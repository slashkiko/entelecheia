import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli.js";

/**
 * `ent run <slug> --pr <n> --issue <n>`。
 *
 * Store は setObserveTarget を持っているのに本番の呼び出し元が無く、
 * GoalState.prNumber が永久に null だった。その結果 observe は github.* を
 * 1つも観測せず、verification: { type: fact, key: github.* } の criteria は
 * 永久に unresolved に落ちる。初めて ent run を全周させたときに実際に踏んだ。
 *
 * controller が自分で PR を作って番号を書き戻すのは次の Goal の範囲で、
 * ここでは人間が渡す口だけを開ける。
 */
describe("parseCommand と観測対象", () => {
  it("--pr は数値として読む", () => {
    expect(parseCommand(["run", "record-the-tick", "--pr", "12"])).toEqual({
      kind: "run",
      slug: "record-the-tick",
      prNumber: 12,
    });
  });

  it("--issue も数値として読む", () => {
    expect(parseCommand(["run", "record-the-tick", "--issue", "34"])).toEqual({
      kind: "run",
      slug: "record-the-tick",
      issueNumber: 34,
    });
  });

  it("両方まとめて指定できる", () => {
    expect(parseCommand(["run", "record-the-tick", "--pr", "12", "--issue", "34"])).toEqual({
      kind: "run",
      slug: "record-the-tick",
      prNumber: 12,
      issueNumber: 34,
    });
  });

  it("指定が無ければ番号を持たない", () => {
    // 「未指定」と「明示的に対象なし」を区別する。未指定なら前回の値を保つ。
    const command = parseCommand(["run", "record-the-tick"]);
    expect(command).toEqual({ kind: "run", slug: "record-the-tick" });
    if (command.kind === "run") {
      expect(command.prNumber).toBeUndefined();
      expect(command.issueNumber).toBeUndefined();
    }
  });

  it("数値でない --pr は error", () => {
    // 黙って捨てると「指定しなかった」と同じ扱いになり、観測対象が変わらないまま回る。
    const result = parseCommand(["run", "record-the-tick", "--pr", "abc"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--pr");
    }
  });

  it("0 以下の --issue は error", () => {
    const result = parseCommand(["run", "record-the-tick", "--issue", "0"]);
    expect(result.kind).toBe("error");
  });

  it("start では --pr を受け付けない", () => {
    // 観測対象を書き換えるのは1ティックを回すときだけにする。
    const result = parseCommand(["start", "record-the-tick", "--pr", "12"]);
    expect(result.kind).toBe("error");
  });
});
