import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INITIAL_REPO_STATE,
  nextRepoState,
  type RepoEvent,
  type RepoState,
} from "../src/factory/repo-state.js";
import {
  nextReviewStage,
  type ReviewOutcome,
  type ReviewStage,
  type ReviewStageInput,
} from "../src/factory/review-stage.js";
import {
  GOAL_STATUS_OF_WORK,
  isTerminalWork,
  nextWorkState,
  type WorkEvent,
  type WorkState,
} from "../src/factory/work-state.js";

// --- 作業の状態 -----------------------------------------------------------------

const WORK_STATES: WorkState[] = [
  "proposed",
  "accepted",
  "working",
  "pr_open",
  "needs_human",
  "merged",
  "done",
  "reverted",
  "rejected",
];

const WORK_EVENTS: WorkEvent[] = [
  { type: "triage_accepted" },
  { type: "expired" },
  { type: "criteria_approved" },
  { type: "pr_opened" },
  { type: "escalated", reason: "attempts" },
  { type: "check_infra_error" },
  { type: "decided", decision: "auto_merge" },
  { type: "decided", decision: "human_merge" },
  { type: "merged" },
  { type: "human_approved", pr: { approvedSha: "a1", headSha: "a1" } },
  { type: "human_approved", pr: { approvedSha: "a1", headSha: "b2" } },
  { type: "human_approved", pr: null },
  { type: "closed" },
  { type: "bake_passed" },
  { type: "reverted" },
];

function run(events: readonly WorkEvent[], from: WorkState = "proposed"): WorkState[] {
  const path = [from];
  for (const event of events) {
    path.push(nextWorkState(path[path.length - 1] as WorkState, event));
  }
  return path;
}

describe("作業の状態", () => {
  it("自動マージの流れを最後まで進む", () => {
    expect(
      run([
        { type: "triage_accepted" },
        { type: "criteria_approved" },
        { type: "pr_opened" },
        { type: "decided", decision: "auto_merge" },
        { type: "merged" },
        { type: "bake_passed" },
      ]),
    ).toEqual(["proposed", "accepted", "working", "pr_open", "pr_open", "merged", "done"]);
  });

  it("人がマージの判定は needs_human に行き、人の承認で判定をやり直す", () => {
    // PR がある承認は差分への承認なので、Actor を回し直さずに pr_open へ戻す。
    expect(
      run(
        [
          { type: "decided", decision: "human_merge" },
          { type: "human_approved", pr: { approvedSha: "a1", headSha: "a1" } },
        ],
        "pr_open",
      ),
    ).toEqual(["pr_open", "needs_human", "pr_open"]);
  });

  it("PR の無い作業が上限で止まったら、人の承認で working に戻る", () => {
    expect(
      run(
        [
          { type: "escalated", reason: "attempts" },
          { type: "human_approved", pr: null },
        ],
        "working",
      ),
    ).toEqual(["working", "needs_human", "working"]);
  });

  it("承認の後に push されていたら、その承認では動かない", () => {
    expect(
      nextWorkState("needs_human", {
        type: "human_approved",
        pr: { approvedSha: "a1", headSha: "b2" },
      }),
    ).toBe("needs_human");
  });

  it("needs_human からは人のマージで merged になる", () => {
    expect(nextWorkState("needs_human", { type: "merged" })).toBe("merged");
  });

  it("検査できなかったときは pr_open のまま再実行する", () => {
    expect(nextWorkState("pr_open", { type: "check_infra_error" })).toBe("pr_open");
  });

  it("上限に達したら needs_human に行く", () => {
    expect(nextWorkState("working", { type: "escalated", reason: "attempts" })).toBe("needs_human");
    expect(nextWorkState("pr_open", { type: "escalated", reason: "rounds" })).toBe("needs_human");
  });

  it("merge の後に revert されたら reverted になる", () => {
    expect(nextWorkState("merged", { type: "reverted" })).toBe("reverted");
  });

  it("proposed のまま期限が来たら rejected になる", () => {
    expect(nextWorkState("proposed", { type: "expired" })).toBe("rejected");
  });

  it.each(WORK_STATES.filter((s) => s !== "merged" && !isTerminalWork(s)))(
    "%s で閉じたら rejected になる",
    (from) => {
      expect(nextWorkState(from, { type: "closed" })).toBe("rejected");
    },
  );

  it("merged で閉じても merged のまま bake time を見張る", () => {
    expect(nextWorkState("merged", { type: "closed" })).toBe("merged");
  });

  it("すべての状態に Goal の対応がある。proposed にだけ Goal が無い", () => {
    for (const s of WORK_STATES) {
      expect(GOAL_STATUS_OF_WORK[s] === null).toBe(s === "proposed");
    }
  });

  it("作業の状態は、ent の Goal の決まった状態に読み替える", () => {
    // fleet の Goal は `ent list` でこの語で読まれる。値の入れ替えは型では
    // 止まらないので、表そのものを固定する。
    expect(GOAL_STATUS_OF_WORK).toEqual({
      proposed: null,
      accepted: "AWAITING_CRITERIA_APPROVAL",
      working: "ACTIVE",
      pr_open: "WAITING_EXTERNAL",
      needs_human: "WAITING_HUMAN",
      merged: "WAITING_EXTERNAL",
      done: "COMPLETED",
      reverted: "FAILED",
      rejected: "ABANDONED",
    });
  });
});

const arbitraryWorkEvents = fc.array(fc.constantFrom(...WORK_EVENTS), { maxLength: 30 });
const arbitraryWorkState = fc.constantFrom(...WORK_STATES);

describe("作業の状態の性質", () => {
  it("終端からは動かない", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("done", "reverted", "rejected" as const),
        arbitraryWorkEvents,
        (from, events) => run(events, from).every((s) => s === from),
      ),
    );
  });

  it("merged を通らずに done と reverted には行かない", () => {
    fc.assert(
      fc.property(arbitraryWorkState, arbitraryWorkEvents, (from, events) => {
        const path = run(events, from);
        for (let i = 1; i < path.length; i += 1) {
          const [prev, next] = [path[i - 1], path[i]];
          if (prev !== next && (next === "done" || next === "reverted") && prev !== "merged") {
            return false;
          }
        }
        return true;
      }),
    );
  });

  it("merged に入るのは merge の出来事だけ。自動マージの判定だけでは入らない", () => {
    fc.assert(
      fc.property(arbitraryWorkState, fc.constantFrom(...WORK_EVENTS), (from, event) => {
        const next = nextWorkState(from, event);
        return from === "merged" || next !== "merged" || event.type === "merged";
      }),
    );
  });

  it("承認の後に push されていたら、承認で状態は動かない", () => {
    fc.assert(
      fc.property(arbitraryWorkState, fc.string(), fc.string(), (from, approved, head) => {
        fc.pre(approved !== head);
        const event: WorkEvent = {
          type: "human_approved",
          pr: { approvedSha: approved, headSha: head },
        };
        return nextWorkState(from, event) === from;
      }),
    );
  });

  it("同じ出来事が何度届いても、2度目より後は状態を変えない", () => {
    // GitHub のラベルと DB が食い違うと、同じ出来事が重ねて届く。行き来はしない。
    fc.assert(
      fc.property(arbitraryWorkState, fc.constantFrom(...WORK_EVENTS), (from, event) => {
        const path = run([event, event, event, event], from);
        return path[2] === path[3] && path[3] === path[4];
      }),
    );
  });
});

// --- リポジトリの状態 -------------------------------------------------------------

const K = 3;

function runRepo(events: readonly RepoEvent[], from: RepoState = INITIAL_REPO_STATE): RepoState {
  return events.reduce((state, event) => nextRepoState(state, event, K), from);
}

describe("リポジトリの状態", () => {
  it("登録直後は K 件の bake を過ぎたら通常に上がる", () => {
    const bake: RepoEvent = { type: "bake_passed" };

    expect(runRepo([bake, bake])).toEqual({ phase: "onboarding", cleanMerges: 2 });
    expect(runRepo([bake, bake, bake])).toEqual({ phase: "normal" });
  });

  it("revert はどの状態からでも一時停止にし、数えかけを捨てる", () => {
    const reverted: RepoEvent = { type: "reverted", reason: "main red" };

    expect(nextRepoState({ phase: "onboarding", cleanMerges: 2 }, reverted, K)).toEqual({
      phase: "suspended",
      reason: "main red",
    });
    expect(nextRepoState({ phase: "normal" }, reverted, K).phase).toBe("suspended");
  });

  it("一時停止は人の再開でしか抜けず、抜けた先は通常", () => {
    const suspended: RepoState = { phase: "suspended", reason: "x" };

    expect(nextRepoState(suspended, { type: "bake_passed" }, K)).toBe(suspended);
    expect(nextRepoState(suspended, { type: "resumed", by: "human" }, K)).toEqual({
      phase: "normal",
    });
  });
});

const arbitraryRepoEvent: fc.Arbitrary<RepoEvent> = fc.constantFrom(
  { type: "bake_passed" },
  { type: "reverted", reason: "r" },
  { type: "resumed", by: "human" },
);

describe("リポジトリの状態の性質", () => {
  it("revert の後は、resumed が来るまで一時停止のまま", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryRepoEvent),
        fc.array(fc.constant<RepoEvent>({ type: "bake_passed" })),
        (before, bakes) => {
          const suspended = runRepo([...before, { type: "reverted", reason: "r" }]);
          return runRepo(bakes, suspended).phase === "suspended";
        },
      ),
    );
  });

  it("一度登録直後を抜けたら、登録直後には戻らない", () => {
    fc.assert(
      fc.property(fc.array(arbitraryRepoEvent, { maxLength: 30 }), (events) => {
        let state: RepoState = INITIAL_REPO_STATE;
        let left = false;
        for (const event of events) {
          state = nextRepoState(state, event, K);
          if (state.phase !== "onboarding") left = true;
          if (left && state.phase === "onboarding") return false;
        }
        return true;
      }),
    );
  });

  it("登録直後から通常へは、revert なしの bake が K 件続いたときだけ上がる", () => {
    fc.assert(
      fc.property(fc.array(arbitraryRepoEvent, { maxLength: 30 }), (events) => {
        let state: RepoState = INITIAL_REPO_STATE;
        let streak = 0;
        for (const event of events) {
          const next = nextRepoState(state, event, K);
          // 登録直後の resumed は何もしないので、数えかけを捨てるのは revert だけ
          if (event.type === "bake_passed") streak += 1;
          if (event.type === "reverted") streak = 0;
          if (state.phase === "onboarding" && next.phase === "normal" && streak < K) return false;
          state = next;
        }
        return true;
      }),
    );
  });
});

// --- レビューの段 ----------------------------------------------------------------

function stage(overrides: Partial<ReviewStageInput> = {}): ReviewStage {
  return nextReviewStage({
    current: "all",
    mode: "auto",
    outcomes: [],
    revertedAfterAutoMerge: false,
    window: 5,
    maxCorrectionRate: 0.2,
    ...overrides,
  });
}

describe("レビューの段", () => {
  it("N 件そろって、直した割合が上限以下なら1段上げる", () => {
    const outcomes: ReviewOutcome[] = ["approved", "approved", "corrected", "approved", "approved"];

    expect(stage({ outcomes })).toBe("sample");
    expect(stage({ current: "sample", outcomes })).toBe("none");
  });

  it("N 件に満たないうちは動かさない", () => {
    expect(stage({ outcomes: ["approved", "approved", "approved", "approved"] })).toBe("all");
  });

  it("直した割合が上限を超えたら上げない", () => {
    const outcomes: ReviewOutcome[] = [
      "approved",
      "corrected",
      "corrected",
      "approved",
      "approved",
    ];

    expect(stage({ outcomes })).toBe("all");
  });

  it("自動マージの後に revert が出たら1段下げる。上げる条件より先に見る", () => {
    const outcomes: ReviewOutcome[] = Array(5).fill("approved");

    expect(stage({ current: "none", outcomes, revertedAfterAutoMerge: true })).toBe("sample");
    expect(stage({ current: "sample", outcomes, revertedAfterAutoMerge: true })).toBe("all");
  });

  it("見るのは直近の N 件だけ。古い直しは上げる判定に入れない", () => {
    const outcomes: ReviewOutcome[] = [
      "corrected",
      "corrected",
      "corrected",
      ...Array<ReviewOutcome>(5).fill("approved"),
    ];

    expect(stage({ outcomes })).toBe("sample");
  });

  it("直近に直しが続けば、古い承認がそろっていても上げない", () => {
    const outcomes: ReviewOutcome[] = [
      ...Array<ReviewOutcome>(5).fill("approved"),
      "corrected",
      "corrected",
    ];

    expect(stage({ outcomes })).toBe("all");
  });

  it("N が0以下なら、件数が足りないものとして動かさない", () => {
    expect(stage({ window: 0, outcomes: Array(5).fill("approved") })).toBe("all");
    expect(stage({ window: -1, outcomes: Array(5).fill("approved") })).toBe("all");
  });

  it("抜き取りで却下が出たら all へ戻す", () => {
    expect(stage({ current: "sample", outcomes: ["approved", "rejected"] })).toBe("all");
  });

  it.each(["all", "sample", "none"] as const)("mode が %s に固定なら、実績で動かさない", (mode) => {
    expect(
      stage({
        mode,
        current: "all",
        outcomes: Array(5).fill("approved"),
        revertedAfterAutoMerge: true,
      }),
    ).toBe(mode);
  });
});

const STAGES: ReviewStage[] = ["all", "sample", "none"];
const UP_OF: Record<ReviewStage, ReviewStage> = { all: "sample", sample: "none", none: "none" };

const arbitraryStageInput: fc.Arbitrary<ReviewStageInput> = fc.record({
  current: fc.constantFrom(...STAGES),
  mode: fc.constant("auto" as const),
  outcomes: fc.array(fc.constantFrom<ReviewOutcome>("approved", "corrected", "rejected"), {
    maxLength: 12,
  }),
  revertedAfterAutoMerge: fc.boolean(),
  window: fc.integer({ min: 1, max: 8 }),
  maxCorrectionRate: fc.double({ min: 0, max: 1, noNaN: true }),
});

describe("レビューの段の性質", () => {
  it("1回に動くのは1段だけ", () => {
    fc.assert(
      fc.property(arbitraryStageInput, (input) => {
        const distance = Math.abs(
          STAGES.indexOf(nextReviewStage(input)) - STAGES.indexOf(input.current),
        );
        return distance <= 1;
      }),
    );
  });

  it("revert が出たら上がらない", () => {
    fc.assert(
      fc.property(arbitraryStageInput, (input) => {
        const next = nextReviewStage({ ...input, revertedAfterAutoMerge: true });
        return STAGES.indexOf(next) <= STAGES.indexOf(input.current);
      }),
    );
  });

  it("直近 N 件の直しの割合だけで、上がるかが決まる", () => {
    // 却下を含む sample は先に下がるので外す。revert も先に見るので外す。
    fc.assert(
      fc.property(arbitraryStageInput, (input) => {
        fc.pre(!input.revertedAfterAutoMerge && input.outcomes.length >= input.window);
        fc.pre(!(input.current === "sample" && input.outcomes.includes("rejected")));
        const recent = input.outcomes.slice(-input.window);
        const rate = recent.filter((o) => o !== "approved").length / recent.length;
        const expected = rate <= input.maxCorrectionRate ? UP_OF[input.current] : input.current;
        return nextReviewStage(input) === expected;
      }),
    );
  });

  it("N 件に満たなければ上がらない", () => {
    fc.assert(
      fc.property(arbitraryStageInput, (input) => {
        const outcomes = input.outcomes.slice(0, input.window - 1);
        const next = nextReviewStage({ ...input, outcomes });
        return STAGES.indexOf(next) <= STAGES.indexOf(input.current);
      }),
    );
  });
});
