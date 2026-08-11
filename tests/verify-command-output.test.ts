import { describe, expect, it } from "vitest";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { AcceptanceCriterion } from "../src/domain/goal.js";
import { describeCommandResult, type VerifyDeps, verify } from "../src/verify/index.js";

/**
 * 落ちた検証コマンドの出力を、あとから読める形で残す。
 *
 * これまで evidence に入るのは `exit_code=1` だけだった。実際に、criteria が
 * 一度だけ落ちて次のティックで通る、という揺れを踏んだ。同じ worktree で手で
 * 流すと 852 件すべて通り、worktree も clean で、Verification に残っていたのは
 * 終了コードだけ。**何が落ちたのかを追う手段が1つも無かった。**
 *
 * design.md §3.1 は「確かめられなかったことを黙って落とさない」を中核に置いて
 * いるが、落ちていたのは**確かめた結果が不合格だったときの中身**だった。
 * 「不合格だった」と「なぜ不合格だったか」は別で、後者を捨てると、同じことが
 * 起きたときに毎回ゼロから調べ直すことになる。
 *
 * 通ったときは足さない。全件緑の出力を毎ティック DB に積む理由が無い。
 */

const NOW = new Date("2026-08-11T09:00:00.000Z");

const CRITERION: AcceptanceCriterion = {
  id: "ac-1",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

function deps(result: { exitCode: number; stdout?: string; stderr?: string }): VerifyDeps {
  return {
    command: {
      run: async () => ({
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      }),
    },
    approval: { getApproval: async () => null },
    now: () => NOW,
  };
}

async function evidenceFor(result: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): Promise<string> {
  const verified = await verify({ setup: [], criteria: [CRITERION], facts: [] }, deps(result));
  const fact = verified.facts.find((f) => f.key === criterionFactKey(CRITERION.id));
  return fact?.evidence?.detail ?? "";
}

describe("落ちたコマンドの出力を残す", () => {
  it("stderr を evidence に載せる", async () => {
    const detail = await evidenceFor({
      exitCode: 1,
      stderr: "FAIL tests/foo.test.ts > 何かが壊れている",
    });

    expect(detail).toContain("exit_code=1");
    expect(detail).toContain("tests/foo.test.ts");
  });

  it("stderr が空なら stdout に落とす", async () => {
    // `mise run test` のように、失敗の要約を stdout に出すものがある。
    const detail = await evidenceFor({
      exitCode: 1,
      stdout: "Tests  1 failed | 851 passed",
      stderr: "",
    });

    expect(detail).toContain("851 passed");
  });

  it("どちらも空なら、出力が無かったと書く", async () => {
    // 空文字を残すと「まだ調べていない」と見分けが付かない（design.md §3.1）。
    const detail = await evidenceFor({ exitCode: 1 });

    expect(detail).toContain("exit_code=1");
    expect(detail).toContain("出力なし");
  });

  it("長い出力は末尾を残す", async () => {
    // テストランナーもリンタも、失敗の要約を最後に出す。先頭から切ると
    // 通ったケースの列挙で埋まる。
    const noise = "ok\n".repeat(5000);
    const detail = await evidenceFor({ exitCode: 1, stderr: `${noise}最後の1行が原因` });

    expect(detail).toContain("最後の1行が原因");
    expect(detail.length).toBeLessThan(3000);
  });

  it("切ったことを明示する", async () => {
    // 切ったと分からないと、読む側は「これで全部」と読む。
    const detail = await evidenceFor({ exitCode: 1, stderr: "x".repeat(5000) });

    expect(detail).toContain("切った");
  });
});

describe("通ったコマンドには足さない", () => {
  it("exit_code=0 だけを残す", async () => {
    const detail = await evidenceFor({
      exitCode: 0,
      stdout: "Tests  852 passed",
    });

    expect(detail).toBe("exit_code=0");
  });
});

describe("組み立てだけを見る", () => {
  it("純関数として単体でも使える", async () => {
    // 検証の全体を組み立てずに、書式だけを確かめられるようにしてある。
    expect(describeCommandResult({ exitCode: 0, stdout: "noise", stderr: "" })).toBe("exit_code=0");
    expect(describeCommandResult({ exitCode: 2, stdout: "", stderr: "壊れた" })).toContain(
      "壊れた",
    );
  });
});
