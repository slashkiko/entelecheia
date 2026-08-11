import { describe, expect, it } from "vitest";
import { worktreeNameFor } from "../src/act/index.js";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { Run } from "../src/domain/run.js";
import type { Verification } from "../src/domain/verification.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type PublishTarget,
  publish,
} from "../src/publish/index.js";

/**
 * 人間が commit した分を push する。
 *
 * `ESCALATE(uncommitted_changes)` の解決手順は、rationale が書いているとおり
 * 「差分を確かめて、残すなら commit する」になる。**その commit には Run が
 * 付かない。** ところが `ensurePullRequest` は「完了した Run が無い」ティックで
 * push を飛ばすので、人間が片付けた差分は remote に出ないまま残る。
 *
 * そこで止まるだけなら、次に Actor が走ったときに送られる。止まらない。
 * PR が立ったあとの DECIDE は `WAIT(review_pending)` を選び続けるので、
 * 次の ACT が来ない。**criteria がローカルで全部緑なのに、remote には仕様
 * テストだけが載っていて CI が赤い**という状態で固まる。`type: fact` の
 * criteria（`github.ci.conclusion`）は永久に埋まらない。
 *
 * 実際に `use-ent-in-any-repository`（PR #34）がこの形で止まり、人間が手で
 * push するまで動かなかった。Phase 3 で見つけた「push は commit 済みの差分
 * しか送らないのに VERIFY は作業ツリーを見る」と同じ族の断線で、今度は
 * 「push は Run が完了したティックでしか送らない」になる。
 *
 * push が送るのは commit 済みの差分だけで、そこは変えない。変えるのは
 * 「送る機会が Actor の実行に紐付いている」ところになる。
 */

const NOW = new Date("2026-08-10T09:00:00.000Z");

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプルを完成させる",
    desired_state: "何かが完成している",
    depends_on: [],
  },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  setup: [],
  acceptance_criteria: [
    {
      id: "ac-1",
      description: "テストが通る",
      verification: { type: "command", run: "mise run test" },
    },
  ],
  context: { background: "背景", constraints: [], references: [] },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

const FAILED_RUN: Run = {
  id: "1",
  intent: "テストの失敗を直す",
  actor: "claude-code",
  role: "implement",
  worktree: "sample-goal",
  attempt: 1,
  startedAt: NOW.toISOString(),
  status: "failed",
  finishedAt: NOW.toISOString(),
  exitCode: 1,
  logRef: "runs/1/log.jsonl",
  tokens: 12000,
  artifacts: [],
  detail: "usage limit",
};

/** ACT を選ばなかったティック。人間が commit したあとはこの形になる */
const WAIT_DECISION: Decision = {
  decidedAt: NOW.toISOString(),
  action: { type: "WAIT", reason: "review_pending", resumeAfter: null },
  rationale: "Gap が 2 件ある",
  decidedBy: "llm",
};

const VERIFICATIONS: Verification[] = [
  {
    criterionId: "ac-1",
    result: "passed",
    reason: null,
    evidence: { source: "mise run test", detail: "exit_code=0" },
    detail: "exit_code=0",
    verifiedAt: NOW.toISOString(),
  },
];

interface Sink {
  writer: CodeWriterPort;
  branch: BranchPort;
  pushes: { name: string; base: string }[];
}

function sink(over: { existing?: number | null; pushed?: boolean } = {}): Sink {
  const pushes: { name: string; base: string }[] = [];

  return {
    pushes,
    writer: {
      findPullRequest: async () => over.existing ?? null,
      createPullRequest: async () => 42,
      addComment: async () => {},
    },
    branch: {
      push: async (name, base) => {
        pushes.push({ name, base });
        return { branch: `entelecheia/${name}`, pushed: over.pushed ?? true };
      },
    },
  };
}

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    goal: GOAL,
    run: null,
    decision: WAIT_DECISION,
    verifications: VERIFICATIONS,
    prNumber: 34,
    digest: "digest-2",
    previousDigest: "digest-1",
    ...over,
  };
}

function deps(s: Sink) {
  return { writer: s.writer, branch: s.branch, now: () => NOW };
}

describe("Run が無いティックでも push する", () => {
  it("ACT を選ばなかったティックで push する", async () => {
    // 人間が commit したあとに来るのがこのティックになる。ここで送らないと、
    // 次に Actor が走るまで remote には出ない。
    const s = sink();

    await publish(target(), deps(s));

    expect(s.pushes).toHaveLength(1);
  });

  it("押す先は実装役の作業ツリーになる", async () => {
    // Run が無いので `run.worktree` は読めない。規則は act/index.ts が正で、
    // ここで別の名前を組み立てるとレビュー役の作業ツリーを押しかねない。
    const s = sink();

    await publish(target(), deps(s));

    expect(s.pushes[0]).toEqual({
      name: worktreeNameFor(GOAL.goal.id, "implement"),
      base: "main",
    });
  });

  it("PR がまだ無ければ、Run が無くても PR を作る", async () => {
    // 人間が commit した分だけで PR を立てる場面がある。push が通った以上、
    // 空の PR にはならない。
    const s = sink();

    const result = await publish(target({ prNumber: null }), deps(s));

    expect(result.prNumber).toBe(42);
    expect(result.created).toBe(true);
  });

  it("base との差分が無ければ PR は作らない", async () => {
    // 既にある性質を保つ。空の PR は通知にも検証にも使えない。
    const s = sink({ pushed: false });

    const result = await publish(target({ prNumber: null }), deps(s));

    expect(result.created).toBe(false);
  });

  it("Run が失敗したティックでも push する", async () => {
    // push が送るのは commit 済みの差分だけなので、失敗した Actor の書きかけは
    // そもそも乗らない。前のティックまでに commit された分を止める理由が無い。
    const s = sink();

    await publish(target({ run: FAILED_RUN }), deps(s));

    expect(s.pushes).toHaveLength(1);
  });
});

describe("関門が止めたティックでは push しない", () => {
  it("protected_path_touched なら Run が無くても push しない", async () => {
    // 制御ループ自体に触れた変更は remote に出さない（design.md §7）。
    // Run の有無で push を決めるのをやめても、この線は残す。
    const s = sink();
    const decision: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "ESCALATE", reason: "protected_path_touched" },
      rationale: "保護パスを編集した",
      decidedBy: "guard",
    };

    await publish(target({ decision }), deps(s));

    expect(s.pushes).toHaveLength(0);
  });

  it("guard_unavailable なら Run が無くても push しない", async () => {
    // 関門が動いていない状態で push するのは、関門が無いのと同じになる。
    const s = sink();
    const decision: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "ESCALATE", reason: "guard_unavailable" },
      rationale: "本体リポジトリ側を検査できなかった",
      decidedBy: "guard",
    };

    await publish(target({ decision }), deps(s));

    expect(s.pushes).toHaveLength(0);
  });
});
