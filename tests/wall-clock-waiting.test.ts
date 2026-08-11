import { describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import { elapsedSecondsSince, waitedSeconds } from "../src/domain/guard-rules.js";

/**
 * `max_wall_clock` が数えるのは、機械側が動けた実時間になる。
 *
 * PR #39 の実走で踏んだ形をここに固定する。ac-1〜ac-6 が緑になり
 * `WAITING_HUMAN` で承認を待ち、人間が一晩置いてから承認した。承認そのものは
 * 正しく届いていたのに、それを観測する前に `経過時間 47341s/5h` で
 * `ESCALATE(budget_exhausted)` になった。`ent complete` は無いので、その Goal は
 * COMPLETED に到達する手段を失い、`abandon` で終端にするしかなくなった。
 *
 * 待てと指示したのは controller の側になる。`WAIT` も予算切れ以外の `ESCALATE` も、
 * 次のティックが何をしても状態は変わらない。その時間を Goal の予算から引くのは
 * 筋が通らない。
 *
 * 逆向きの誤り——待っていない時間まで引く——も同じだけ困る。引きすぎれば
 * `max_wall_clock` が効かなくなり、暴走を止める停止条件が1つ消える。
 */

const ACTIVATED = "2026-08-10T00:00:00.000Z";

function decision(decidedAt: string, action: Decision["action"]): Decision {
  return { decidedAt, action, rationale: "テスト", decidedBy: "llm" };
}

function at(hours: number): string {
  return new Date(Date.parse(ACTIVATED) + hours * 3600_000).toISOString();
}

describe("人間や外部を待っていた分は max_wall_clock から引く", () => {
  it("WAIT から次のティックまでを待ちに数える", () => {
    const decisions = [
      decision(at(0), { type: "ACT", intent: "実装する" }),
      decision(at(1), { type: "WAIT", reason: "review_pending", resumeAfter: null }),
      decision(at(9), { type: "VERIFY" }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(10)))).toBe(8 * 3600);
  });

  it("最後の Decision が待ちなら、いまも待っている", () => {
    const decisions = [
      decision(at(0), { type: "ACT", intent: "実装する" }),
      decision(at(1), { type: "WAIT", reason: "review_pending", resumeAfter: null }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(13)))).toBe(12 * 3600);
  });

  it("予算切れ以外の ESCALATE も待ちに数える", () => {
    // protected_path_touched も guard_unavailable も、人間が片付けるまで
    // 次のティックでは解けない。待っている相手が人間なのは WAIT と同じになる。
    const decisions = [
      decision(at(0), { type: "ESCALATE", reason: "protected_path_touched" }),
      decision(at(5), { type: "ACT", intent: "続きを実装する" }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(6)))).toBe(5 * 3600);
  });

  it("budget_exhausted の ESCALATE は引かない", () => {
    // そこに至った時点で上限の判定は済んでいる。引く相手にならない。
    const decisions = [decision(at(0), { type: "ESCALATE", reason: "budget_exhausted" })];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(6)))).toBe(0);
  });

  it("動いていたティックは1秒も引かない", () => {
    const decisions = [
      decision(at(0), { type: "ACT", intent: "実装する" }),
      decision(at(1), { type: "VERIFY" }),
      decision(at(2), { type: "REPLAN" }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(3)))).toBe(0);
  });

  it("ACTIVE になる前の待ちは数えない", () => {
    // 経過時間が activatedAt から始まるので、引く相手もそこから揃える。
    // 揃えないと、引いた分だけ上限が伸びる。
    const before = new Date(Date.parse(ACTIVATED) - 5 * 3600_000).toISOString();
    const decisions = [
      decision(before, { type: "WAIT", reason: "ci_running", resumeAfter: null }),
      decision(at(1), { type: "VERIFY" }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(2)))).toBe(3600);
  });

  it("Decision が1件も無ければ引かない", () => {
    expect(waitedSeconds([], ACTIVATED, new Date(at(3)))).toBe(0);
  });

  it("ACTIVE になっていない Goal では引かない", () => {
    const decisions = [decision(at(0), { type: "WAIT", reason: "ci_running", resumeAfter: null })];

    expect(waitedSeconds(decisions, null, new Date(at(3)))).toBe(0);
  });

  it("読めない時刻を待ちに数えない", () => {
    // 0 と読むと、activatedAt からの全部が待ちになる。確かめられなかったものを
    // 有利な側に倒さない（design.md §3.1）。
    const decisions = [
      decision("いつ", { type: "WAIT", reason: "ci_running", resumeAfter: null }),
      decision(at(1), { type: "VERIFY" }),
    ];

    expect(waitedSeconds(decisions, ACTIVATED, new Date(at(2)))).toBe(0);
  });

  it("引いた残りが、機械側が動けた実時間になる", () => {
    // 実走で踏んだ形。13時間のうち12時間が承認待ちだった。
    const decisions = [
      decision(at(0), { type: "ACT", intent: "実装する" }),
      decision(at(1), { type: "WAIT", reason: "review_pending", resumeAfter: null }),
    ];
    const now = new Date(at(13));

    const elapsed = elapsedSecondsSince(ACTIVATED, now);
    expect(elapsed).toBe(13 * 3600);
    expect(elapsed - waitedSeconds(decisions, ACTIVATED, now)).toBe(3600);
  });
});
