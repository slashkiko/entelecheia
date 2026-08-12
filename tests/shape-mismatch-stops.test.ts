import { describe, expect, it } from "vitest";
import { type DecideTarget, decide, type LlmPort } from "../src/decide/index.js";
import type { Action } from "../src/domain/action.js";
import type { Unresolved } from "../src/domain/fact.js";
import type { Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";
import { nextStatus } from "../src/domain/goal-state.js";
import { PortError } from "../src/domain/port-error.js";
import { verify } from "../src/verify/index.js";

/**
 * 「届いたが読めなかった」を、待つのではなく止まる理由にする。
 *
 * `shape_mismatch` は既に入っている。`PortError` の kind にも
 * `Unresolved.reason` にもあり、observe は例外の種類から作り分けている
 * （tests/shape-mismatch.test.ts）。**分類はできたが、待ち方が変わっていない。**
 *
 * `src/decide/index.ts` の `waitReason` は `shape_mismatch` を `port_failed` と
 * 同じ集合に入れ、`WAIT(observation_failed)` を返す。Gap が無いティックの WAIT は
 * ループ検知より手前で return するので、恒久的な不一致が予算に当たるまで
 * 毎ティック再試行される。tests/shape-mismatch.test.ts の冒頭が
 * 「そのあいだ人間には『GitHub が不安定』に見え、原因に辿り着けない」と
 * 書いている状態が、そのまま残っている。
 *
 * ラベルを足しただけでは、人間は呼ばれない。**待っても直らないと分かっている
 * のだから、guard が止める。** 予算の枯渇・ループ・保護パスと同じで、停止条件は
 * LLM に決めさせない（design.md §7）。
 *
 * verify 側にも同じ穴がある。`type: human` の criteria は毎ティック
 * `githubApproval` を呼び、その中で reviews と comments を parse する。
 * ところが `judge()` の catch は例外の種類を見ずに `port_failed` を書くので、
 * **承認の経路だけは分類が届いていない。** observe が作り分けているのに
 * verify が畳んでいるなら、区別は片肺のままになる。
 */

const NOW = new Date("2026-08-09T03:00:00.000Z");

const BUDGET: Budget = {
  max_actor_runs: 10,
  max_reconciles: 20,
  max_wall_clock: "2h",
  max_consecutive_failures: 3,
  max_unchanged_reconciles: 3,
};

const CRITERIA: AcceptanceCriterion[] = [
  { id: "ac-1", description: "ac-1", verification: { type: "command", run: "mise run test" } },
];

const HUMAN: AcceptanceCriterion[] = [
  { id: "ac-6", description: "人間が確認する", verification: { type: "human", prompt: "見て" } },
];

const SHAPE: Unresolved = {
  key: "github.pr",
  reason: "shape_mismatch",
  detail: "CodeProviderPort.getPullRequest(12): number が string で来た",
};

const FAILED: Unresolved = {
  key: "github.ci",
  reason: "port_failed",
  detail: "CodeProviderPort.getLatestCiRun(...): 401",
};

function target(unresolved: Unresolved[], gaps: Gap[]): DecideTarget {
  return {
    criteria: CRITERIA,
    // レビュー役と WAIT を選択肢に載せてよいかを見る材料。この fixture では観測が無い。
    facts: [],
    // 今ティックの観測。`facts` と同じにしておく（この fixture では両方空）
    observedFacts: [],
    assessment: { assessedAt: NOW.toISOString(), gaps, satisfied: gaps.length === 0 },
    unresolved,
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: {
      actorRuns: 0,
      reconciles: 1,
      consecutiveFailures: 0,
      elapsedSeconds: 60,
      trailingDigest: { digest: null, count: 0 },
    },
  };
}

/** 呼ばれた回数を数える LlmPort。停止条件を LLM に渡していないことを見る */
function countingLlm(reply: unknown): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    chooseAction: async (): Promise<unknown> => {
      port.calls += 1;
      return reply;
    },
  };
  return port;
}

describe("guard が shape_mismatch で止める", () => {
  it("Gap が無ければ WAIT ではなく ESCALATE(shape_mismatch)", async () => {
    // これまでは WAIT(observation_failed)。Gap ゼロの WAIT はループ検知より
    // 手前で return するので、予算に当たるまで毎ティック再試行されていた。
    const llm = countingLlm({ type: "VERIFY" });
    const decision = await decide(target([SHAPE], []), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "shape_mismatch" });
    expect(decision.decidedBy).toBe("guard");
    expect(llm.calls).toBe(0);
  });

  it("Gap が残っていても shape_mismatch が先に止める", async () => {
    // 形が読めていないあいだの観測は信用できない。その上で Actor を起動すると、
    // 根拠の無い intent に予算を使う。
    const llm = countingLlm({ type: "ACT", intent: "直す" });
    const gaps: Gap[] = [{ criterionId: "ac-1", kind: "unknown", detail: "まだ確かめていない" }];
    const decision = await decide(target([SHAPE], gaps), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "shape_mismatch" });
    expect(llm.calls).toBe(0);
  });

  it("何が読めなかったかを rationale に残す", () => {
    // 人間が直す先は detail からしか読めない。「GitHub が不安定」に見せない。
    return decide(target([SHAPE], []), { llm: countingLlm({}), now: () => NOW }).then(
      (decision) => {
        expect(decision.rationale).toContain("github.pr");
        expect(decision.rationale).toContain("number が string で来た");
      },
    );
  });

  it("port_failed だけならこれまでどおり WAIT(observation_failed)", async () => {
    // 届かなかった失敗は待てば直りうる。倒す向きを変えない。
    const decision = await decide(target([FAILED], []), {
      llm: countingLlm({}),
      now: () => NOW,
    });

    expect(decision.action).toMatchObject({ type: "WAIT", reason: "observation_failed" });
  });

  it("port_failed と混ざっていても shape_mismatch を優先する", async () => {
    // 1件でも「待っても直らない」があるなら、全体を待ちにしない。
    const decision = await decide(target([FAILED, SHAPE], []), {
      llm: countingLlm({}),
      now: () => NOW,
    });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "shape_mismatch" });
  });

  it("unresolved が無ければこれまでどおり COMPLETE", async () => {
    const decision = await decide(target([], []), { llm: countingLlm({}), now: () => NOW });

    expect(decision.action).toEqual({ type: "COMPLETE" });
  });

  it("予算の枯渇は shape_mismatch より先に見る", async () => {
    // 既存の guard の順序を変えない。予算はどの理由より先に止める。
    const exhausted = target([SHAPE], []);
    exhausted.usage = { ...exhausted.usage, reconciles: 999 };
    const decision = await decide(exhausted, { llm: countingLlm({}), now: () => NOW });

    expect(decision.action).toEqual({ type: "ESCALATE", reason: "budget_exhausted" });
  });
});

describe("LLM に shape_mismatch を選ばせない", () => {
  it("ESCALATE(shape_mismatch) を返してきても採らない", async () => {
    // 理由を1つ足したことで LLM 側の口が開かないことを確かめる。
    // 停止条件を推論に委ねない（design.md §7）。
    let call = 0;
    const llm: LlmPort = {
      chooseAction: async () => {
        call += 1;
        return call === 1 ? { type: "ESCALATE", reason: "shape_mismatch" } : { type: "VERIFY" };
      },
    };
    const gaps: Gap[] = [{ criterionId: "ac-1", kind: "unmet", detail: "exit_code=1" }];
    const decision = await decide(target([], gaps), { llm, now: () => NOW });

    expect(decision.action).toEqual({ type: "VERIFY" });
    expect(decision.decidedBy).toBe("llm");
  });
});

describe("状態機械に足すものは無い", () => {
  it("ESCALATE(shape_mismatch) は WAITING_HUMAN になる", () => {
    // budget_exhausted 以外の ESCALATE は WAITING_HUMAN。人間が直すまで動かない。
    const action: Action = { type: "ESCALATE", reason: "shape_mismatch" };

    expect(nextStatus("ACTIVE", action)).toBe("WAITING_HUMAN");
    expect(nextStatus("WAITING_EXTERNAL", action)).toBe("WAITING_HUMAN");
  });

  it("終端状態からは動かない", () => {
    expect(nextStatus("COMPLETED", { type: "ESCALATE", reason: "shape_mismatch" })).toBe(
      "COMPLETED",
    );
  });
});

describe("verify も理由を作り分ける", () => {
  const now = () => new Date("2026-08-09T03:00:00.000Z");
  const command = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

  const approvalThrowing = (error: unknown) => ({
    getApproval: async (): Promise<never> => {
      throw error;
    },
  });

  it("承認 Port の shape_mismatch を port_failed に畳まない", async () => {
    // ac-6 のような type: human は毎ティック githubApproval を呼ぶ。
    // reviews / comments の parse が落ちたとき、ここが port_failed のままだと
    // 承認の経路だけ「待てば直る」に戻り、guard も止められない。
    const result = await verify(
      { setup: [], criteria: HUMAN, facts: [] },
      {
        command,
        approval: approvalThrowing(new PortError("shape_mismatch", "state が数値")),
        now,
      },
    );

    expect(result.unverified.map((u) => u.reason)).toEqual(["shape_mismatch"]);
    expect(result.unverified[0]?.detail).toContain("state が数値");
  });

  it("承認 Port の unavailable はこれまでどおり port_failed", async () => {
    const result = await verify(
      { setup: [], criteria: HUMAN, facts: [] },
      { command, approval: approvalThrowing(new PortError("unavailable", "401")), now },
    );

    expect(result.unverified.map((u) => u.reason)).toEqual(["port_failed"]);
  });

  it("素の Error も port_failed のまま", async () => {
    // 区別できない失敗を恒久扱いにしない。倒す向きは再試行する側にする。
    const result = await verify(
      { setup: [], criteria: HUMAN, facts: [] },
      { command, approval: approvalThrowing(new Error("socket hang up")), now },
    );

    expect(result.unverified.map((u) => u.reason)).toEqual(["port_failed"]);
  });

  it("未承認は pending のまま。失敗と混ぜない", async () => {
    const result = await verify(
      { setup: [], criteria: HUMAN, facts: [] },
      { command, approval: { getApproval: async () => null }, now },
    );

    expect(result.unverified.map((u) => u.reason)).toEqual(["pending"]);
  });

  it("検証コマンドを起動できなかった場合は port_failed のまま", async () => {
    // シェルの失敗は Port の応答の形ではない。恒久扱いにしない。
    const result = await verify(
      { setup: [], criteria: CRITERIA, facts: [] },
      {
        command: {
          run: async () => {
            throw new Error("spawn ENOENT");
          },
        },
        approval: { getApproval: async () => null },
        now,
      },
    );

    expect(result.unverified.map((u) => u.reason)).toEqual(["port_failed"]);
  });
});
