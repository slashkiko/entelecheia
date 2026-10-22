import { describe, expect, it } from "vitest";
import {
  type ActDeps,
  type ActorInvocation,
  type ActorPort,
  type ActTarget,
  act,
  type RunRecorderPort,
  type WorktreePort,
} from "../src/act/index.js";
import type { Action, Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";

/**
 * Goal の宣言部に書いた制約が、Actor に届いていることを固定する。
 *
 * `src/domain/goal.ts` の `constraints` には「ACT にそのまま渡る自由記述」と
 * 書いてあるが、`goal.context` を読むコードは `src/` のどこにも無い。
 * `ActorInvocation` が運ぶのは runId / intent / worktree / deniedOperations /
 * signal の5つだけで、`tests/act.test.ts` の「Actor への引き渡し」も
 * その3つしか見ていない。届かなくても落ちるものが無かった。
 *
 * 実害は tests/** の扱いに出る。`.goals/guard-the-controller.yaml` は
 * 「criteria を確かめる仕組みと確かめる中身は別」という理由で tests/** を
 * protected_paths から意図的に外し、代わりに各 Goal の constraints に
 * 「このテストは仕様なので変更しない」と書いてきた。その行が届いていないので、
 * criteria が `mise run test` の Actor は仕様テストを書き換えて通せる。
 * そうして出来た `criteria.ac-1.passed` は VERIFIED になり、design.md §3.1 が
 * 成立しなくなる。
 *
 * 渡し方は Actor に決めさせる。ここで固定するのは「文言が届くこと」だけで、
 * intent に畳むか ActorInvocation に足すかは実装側の判断でよい。
 */

const NOW = new Date("2026-08-09T04:00:00.000Z");

const CONSTRAINT_A = "tests/controller-uncommitted.test.ts は仕様なので変更しない";
const CONSTRAINT_B = "依存パッケージを増やさない";

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "sample-goal",
    name: "サンプル",
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
  context: {
    background: "背景",
    constraints: [CONSTRAINT_A, CONSTRAINT_B],
    references: [],
  },
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

const ACT_INTENT = "テストの失敗を直す";

function decision(action: Action): Decision {
  return { decidedAt: NOW.toISOString(), action, rationale: "テスト", decidedBy: "llm" };
}

function target(): ActTarget {
  return { goal: GOAL, decision: decision({ type: "ACT", intent: ACT_INTENT }), attempt: 1 };
}

function spy(): { deps: ActDeps; invocations: ActorInvocation[] } {
  const invocations: ActorInvocation[] = [];

  const worktree: WorktreePort = {
    ensure: async (name) => ({ path: `/tmp/entelecheia/${name}`, branch: `entelecheia/${name}` }),
    commit: async () => true,
    changedPaths: async () => [],
    repoDirtyState: async () => new Map(),
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async (invocation) => {
      invocations.push(invocation);
      return { exitCode: 0, logRef: "log.txt", tokens: 1, artifacts: [] };
    },
  };

  const runs: RunRecorderPort = {
    start: async (_intent: RunIntent) => "run-1",
    finish: async (_runId: string, _outcome: RunOutcome) => undefined,
  };

  return { deps: { worktree, actor, runs, now: () => NOW }, invocations };
}

/** invocation のどこに載っていても拾えるように、渡るもの全部を文字列にして見る */
function deliveredText(invocation: ActorInvocation): string {
  return JSON.stringify(invocation);
}

describe("Goal の宣言部が Actor に届く", () => {
  it("context.constraints が Actor に渡る", async () => {
    const s = spy();
    await act(target(), s.deps);

    const invocation = s.invocations[0];
    expect(invocation).toBeDefined();
    if (invocation === undefined) {
      return;
    }

    expect(deliveredText(invocation)).toContain(CONSTRAINT_A);
    expect(deliveredText(invocation)).toContain(CONSTRAINT_B);
  });

  it("intent は落とさない", async () => {
    // 制約を足すために intent を置き換えてしまうと、DECIDE が決めた
    // 「次に何をするか」が消える。両方が届いていること。
    const s = spy();
    await act(target(), s.deps);

    const invocation = s.invocations[0];
    expect(invocation).toBeDefined();
    if (invocation === undefined) {
      return;
    }

    expect(deliveredText(invocation)).toContain(ACT_INTENT);
  });
});
