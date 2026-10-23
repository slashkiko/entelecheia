import { describe, expect, it } from "vitest";
import {
  type Attempt,
  type AttemptLedgerInput,
  attemptSignature,
  buildAttempts,
  trailingRepeatedAttempts,
  type VerificationRound,
} from "../src/domain/attempt.js";
import type { Snapshot } from "../src/domain/fact.js";
import type { Run } from "../src/domain/run.js";
import type { Verification } from "../src/domain/verification.js";

/**
 * Actor の試行台帳。
 *
 * Actor は毎ティック新しいセッションで走るので、前のティックが何を試して何が
 * 駄目だったかはどこにも引き継がれない。材料（Run / Verification / Snapshot）は
 * 既に3つのテーブルに揃っているので、新しいテーブルは作らず読むときに結ぶ。
 */

/** 1ティックの中は OBSERVE → ACT → 永続化の順。検証時刻は Run より前になる */
function tickAt(minute: number): string {
  return `2026-08-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    intent: "テストを通す",
    actor: "claude-code",
    role: "implement",
    worktree: "sample-goal",
    attempt: 1,
    startedAt: tickAt(1),
    status: "completed",
    finishedAt: tickAt(2),
    exitCode: 0,
    logRef: ".goals/.state/runs/run-1/log.jsonl",
    tokens: 100,
    artifacts: ["src/a.ts"],
    detail: null,
    ...over,
  };
}

function verification(over: Partial<Verification> = {}): Verification {
  return {
    criterionId: "ac-1",
    result: "failed",
    reason: null,
    evidence: { source: "mise run test", detail: "exit_code=1" },
    detail: "exit_code=1\n1 test failed",
    verifiedAt: tickAt(0),
    ...over,
  };
}

function round(seq: number, at: string, over: Partial<Verification> = {}): VerificationRound {
  return { reconcileSeq: seq, verifications: [verification({ verifiedAt: at, ...over })] };
}

function snapshot(at: string, headSha: string): Snapshot {
  return {
    observedAt: at,
    facts: [
      {
        key: "local.head_sha",
        value: headSha,
        observedAt: at,
        confidence: "VERIFIED",
        evidence: { source: "git rev-parse HEAD", detail: headSha },
      },
    ],
    unresolved: [],
  };
}

function input(over: Partial<AttemptLedgerInput> = {}): AttemptLedgerInput {
  return { runs: [], rounds: [], snapshots: [], ...over };
}

describe("台帳の組み立て", () => {
  it("Run 1件につき1行にする。役割も status も絞らない", () => {
    // 何を試したかは、失敗した試行にも中断された試行にも等しく残っている。
    const attempts = buildAttempts(
      input({
        runs: [
          run({ id: "run-1" }),
          run({ id: "run-2", role: "review", startedAt: tickAt(11) }),
          run({ id: "run-3", status: "failed", detail: "actor crashed", startedAt: tickAt(21) }),
        ],
      }),
    );

    expect(attempts.map((a) => a.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(attempts[2]?.failureDetail).toBe("actor crashed");
  });

  it("同じティックの検証結果では閉じない。閉じるのは次のティック", () => {
    // 1ティックの中は OBSERVE → ACT → 永続化の順なので、同じティックの検証は
    // Run より前の時刻を持つ。ここを取り違えると、試行の結果が「その試行が
    // 始まる前に観測されたもの」になる。
    const attempts = buildAttempts(
      input({
        runs: [run({ startedAt: tickAt(1) })],
        rounds: [round(1, tickAt(0)), round(2, tickAt(10), { result: "passed" })],
      }),
    );

    expect(attempts[0]?.outcome?.reconcileSeq).toBe(2);
    expect(attempts[0]?.outcome?.verifications[0]?.result).toBe("passed");
  });

  it("まだ閉じていない試行は outcome を null で残す", () => {
    // 「結果が出ていない」を「結果が出なかった」に畳まない（design.md §3.1）。
    const attempts = buildAttempts(
      input({ runs: [run({ startedAt: tickAt(1) })], rounds: [round(1, tickAt(0))] }),
    );

    expect(attempts[0]?.outcome).toBeNull();
  });

  it("前後の HEAD を、起動の直前と閉じたティックの観測から取る", () => {
    const attempts = buildAttempts(
      input({
        runs: [run({ startedAt: tickAt(1) })],
        rounds: [round(1, tickAt(0)), round(2, tickAt(10))],
        snapshots: [
          snapshot(tickAt(0), "aaaaaaaaaaaa1111"),
          snapshot(tickAt(10), "bbbbbbbbbbbb2222"),
        ],
      }),
    );

    expect(attempts[0]?.headBefore).toBe("aaaaaaaaaaaa1111");
    expect(attempts[0]?.outcome?.headAfter).toBe("bbbbbbbbbbbb2222");
  });

  it("観測できていない HEAD は null にする", () => {
    const attempts = buildAttempts(input({ runs: [run()], rounds: [round(2, tickAt(10))] }));

    expect(attempts[0]?.headBefore).toBeNull();
  });

  it("検証結果から Gap を導く。passed は Gap にならない", () => {
    const attempts = buildAttempts(
      input({
        runs: [run()],
        rounds: [
          {
            reconcileSeq: 2,
            verifications: [
              verification({ criterionId: "ac-1", result: "failed", verifiedAt: tickAt(10) }),
              verification({ criterionId: "ac-2", result: "passed", verifiedAt: tickAt(10) }),
              verification({
                criterionId: "ac-3",
                result: "unresolved",
                reason: "pending",
                verifiedAt: tickAt(10),
              }),
            ],
          },
        ],
      }),
    );

    expect(attempts[0]?.outcome?.gaps).toEqual([
      { criterionId: "ac-1", kind: "unmet", detail: "exit_code=1\n1 test failed" },
      { criterionId: "ac-3", kind: "unknown", detail: "exit_code=1\n1 test failed" },
    ]);
  });

  it("最終メッセージは読み込まない。在り処だけを残す", () => {
    // 本文は数十MBになりうる。台帳を作るたびに全部を読むことにしない。
    const attempts = buildAttempts(input({ runs: [run()] }));

    expect(attempts[0]?.actorClaim).toBeNull();
    expect(attempts[0]?.logRef).toBe(".goals/.state/runs/run-1/log.jsonl");
  });
});

describe("失敗シグネチャ", () => {
  function closed(over: Partial<Run>, at: string, verifications: Verification[]): Attempt {
    const attempts = buildAttempts(
      input({
        runs: [run(over)],
        rounds: [{ reconcileSeq: 2, verifications }],
      }),
    );
    const attempt = attempts[0];
    if (attempt === undefined) {
      throw new Error(`no attempt built for ${at}`);
    }
    return attempt;
  }

  it("Gap 集合と criteria 結果と失敗 detail が同じなら、同じ指紋になる", () => {
    const a = closed({ id: "run-1" }, tickAt(10), [verification({ verifiedAt: tickAt(10) })]);
    const b = closed({ id: "run-2", startedAt: tickAt(11) }, tickAt(20), [
      verification({ verifiedAt: tickAt(20) }),
    ]);

    expect(attemptSignature(a)).toBe(attemptSignature(b));
  });

  it("検証時刻は指紋に入らない。時刻が入ると毎回違う指紋になる", () => {
    const a = closed({ id: "run-1" }, tickAt(10), [verification({ verifiedAt: tickAt(10) })]);
    const b = closed({ id: "run-2" }, tickAt(30), [verification({ verifiedAt: tickAt(30) })]);

    expect(attemptSignature(a)).toBe(attemptSignature(b));
  });

  it("失敗 detail が1文字でも違えば別の指紋になる", () => {
    // 正規化しない。完全一致なら停滞の強い証拠になる代わりに、揺れた分は数え直す。
    const a = closed({ id: "run-1" }, tickAt(10), [verification({ verifiedAt: tickAt(10) })]);
    const b = closed({ id: "run-2" }, tickAt(20), [
      verification({ verifiedAt: tickAt(20), detail: "exit_code=1\n2 tests failed" }),
    ]);

    expect(attemptSignature(a)).not.toBe(attemptSignature(b));
  });

  it("閉じていない試行、レビュー役、失敗した Run は数えない", () => {
    const unclosed = buildAttempts(input({ runs: [run()] }))[0];
    const review = closed({ role: "review" }, tickAt(10), [
      verification({ verifiedAt: tickAt(10) }),
    ]);
    const failed = closed({ status: "failed" }, tickAt(10), [
      verification({ verifiedAt: tickAt(10) }),
    ]);

    expect(unclosed === undefined ? null : attemptSignature(unclosed)).toBeNull();
    expect(attemptSignature(review)).toBeNull();
    expect(attemptSignature(failed)).toBeNull();
  });
});

describe("反復の数え方", () => {
  /** 実装役の試行を n 件並べる。detail を渡した回だけ結果が変わる */
  function ledger(details: readonly (string | null)[]): Attempt[] {
    const runs: Run[] = details.map((_, i) =>
      run({ id: `run-${String(i)}`, startedAt: tickAt(i * 10 + 1) }),
    );
    const rounds: VerificationRound[] = details.map((detail, i) => ({
      reconcileSeq: i + 2,
      verifications: [
        verification({
          verifiedAt: tickAt(i * 10 + 5),
          ...(detail === null ? {} : { detail }),
        }),
      ],
    }));
    return buildAttempts(input({ runs, rounds }));
  }

  it("同じ結果が続いた回数を末尾から数える", () => {
    expect(trailingRepeatedAttempts(ledger([null, null, null])).count).toBe(3);
  });

  it("結果が変わったところで止まる", () => {
    // 直前の試行で1本でも通れば、そこまでは進んでいる。
    expect(trailingRepeatedAttempts(ledger(["別の失敗", null, null])).count).toBe(2);
  });

  it("1件も数えられなければ 0 を返す", () => {
    expect(trailingRepeatedAttempts([])).toEqual({ signature: null, count: 0 });
  });

  it("数えられない試行は飛ばすだけで、数え直さない", () => {
    // 実装役の試行のあいだに人間の承認待ちやレビューが挟まっても、実装が
    // 進んでいなければ停滞は続いている。
    const attempts = buildAttempts(
      input({
        runs: [
          run({ id: "run-1", startedAt: tickAt(1) }),
          run({ id: "run-2", role: "review", startedAt: tickAt(11) }),
          run({ id: "run-3", startedAt: tickAt(21) }),
        ],
        rounds: [
          { reconcileSeq: 2, verifications: [verification({ verifiedAt: tickAt(5) })] },
          { reconcileSeq: 3, verifications: [verification({ verifiedAt: tickAt(15) })] },
          { reconcileSeq: 4, verifications: [verification({ verifiedAt: tickAt(25) })] },
        ],
      }),
    );

    expect(trailingRepeatedAttempts(attempts).count).toBe(2);
  });

  it("レビューに依存する criteria が pending に倒れても、指紋は揃う", () => {
    // 実装役が走ったティックでは、レビュー系の criteria が `pendingReviewCriteria`
    // で pending に倒される（`src/controller/index.ts`）。**倒された側だけを比べる**
    // ので、空回りしているあいだは毎ティック同じ文面が並ぶ。片方だけ倒れた形を
    // 比べていると、この種の Goal でだけ検知が黙って死ぬ。
    const pending = verification({
      criterionId: "ac-review",
      result: "unresolved",
      reason: "pending",
      evidence: null,
      detail: "The implement role ran this tick, so review criteria are not judged this tick.",
    });
    const attempts = buildAttempts(
      input({
        runs: [
          run({ id: "run-1", startedAt: tickAt(1) }),
          run({ id: "run-2", startedAt: tickAt(11) }),
        ],
        rounds: [
          {
            reconcileSeq: 2,
            verifications: [
              verification({ verifiedAt: tickAt(5) }),
              { ...pending, verifiedAt: tickAt(5) },
            ],
          },
          {
            reconcileSeq: 3,
            verifications: [
              verification({ verifiedAt: tickAt(15) }),
              { ...pending, verifiedAt: tickAt(15) },
            ],
          },
        ],
      }),
    );

    expect(trailingRepeatedAttempts(attempts).count).toBe(2);
  });
});
