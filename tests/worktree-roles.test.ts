import { describe, expect, it } from "vitest";
import {
  type ActDeps,
  type ActorInvocation,
  type ActorPort,
  type ActorResult,
  type ActTarget,
  act,
  type RunRecorderPort,
  type WorktreePort,
  worktreeBranchFor,
  worktreeNameFor,
} from "../src/act/index.js";
import type { Action, Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import { type RunIntent, type RunOutcome, runSchema } from "../src/domain/run.js";

/**
 * 役割の違う Agent が、同じ Goal の中で別々の worktree を持って協働できること。
 *
 * いまの `worktreeNameFor` は goal.id だけから名前を決めるので、1つの Goal が
 * 持てる作業ツリーは1つしかない。実装する Agent とレビューする Agent を同じ
 * Goal で動かすと、両者が同じ作業ツリーを共有する。レビュー側が checkout や
 * clean を行えば実装側の途中の差分が消えるし、実装側が書き換えれば
 * レビュー側は「いつの時点のコードを読んだのか」を言えなくなる。
 *
 * ここで固定するのは2つ。
 *
 * 1. worktree の名前が (goal.id, role) から決まり、role が違えば別の作業ツリー・
 *    別のブランチになること
 * 2. `implement` の名前だけは goal.id のまま据え置くこと。既存の worktree と
 *    PR のブランチは `entelecheia/<goal.id>` にあり、規則を変えると
 *    走行中の Goal が別ブランチに乗り換えて、それまでの差分が PR から消える
 *
 * `worktreeNameFor` の第2引数を必須にしてあるのは、呼び出し側に「どちらの
 * 作業ツリーの話か」を毎回書かせるため。既定値を持たせると、`verifyRoot` や
 * 未 commit の関門が review の作業ツリーを implement のものと取り違えても、
 * 型でもテストでも気づけない。あの関門は「観測した `local.branch` が
 * `worktreeBranchFor(worktreeNameFor(...))` と一致するか」で観測の出自を
 * 判定しているので、候補のブランチが2本になった時点で判定の意味が変わる。
 *
 * **並列実行はここでは求めない。** 1ティックで起動する Actor は1体のままで、
 * write-ahead も「1ティックに Decision 1行」も変えない。協働はティックを
 * またいだ交代で成立させる。同じティックで2体を同時に走らせると、
 * Run の確定と lease の設計まで巻き込むことになる（design.md §5 の
 * 「複数 Actor の並列実行」は据え置き）。
 */

const NOW = new Date("2026-08-09T04:00:00.000Z");
const GOAL_ID = "sample-goal";

const GOAL: Goal = {
  version: 1,
  goal: {
    id: GOAL_ID,
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
  context: { background: "背景", constraints: [], references: [] },
  policies: { require_human_approval: ["merge", "force_push"], protected_paths: [] },
  budget: {
    max_actor_runs: 10,
    max_reconciles: 20,
    max_wall_clock: "2h",
    max_consecutive_failures: 3,
    max_unchanged_reconciles: 3,
  },
};

const SUCCESS: ActorResult = {
  exitCode: 0,
  logRef: ".goals/.state/runs/run-1/log.txt",
  tokens: 12_345,
  artifacts: ["src/foo.ts"],
};

function decision(action: Action): Decision {
  return { decidedAt: NOW.toISOString(), action, rationale: "テスト", decidedBy: "llm" };
}

interface Spy {
  deps: ActDeps;
  ensured: { name: string; baseBranch: string }[];
  invocations: ActorInvocation[];
  started: RunIntent[];
  finished: { runId: string; outcome: RunOutcome }[];
}

function spy(): Spy {
  const ensured: { name: string; baseBranch: string }[] = [];
  const invocations: ActorInvocation[] = [];
  const started: RunIntent[] = [];
  const finished: { runId: string; outcome: RunOutcome }[] = [];

  const worktree: WorktreePort = {
    ensure: async (name, baseBranch) => {
      ensured.push({ name, baseBranch });
      return { path: `/tmp/entelecheia/worktrees/${name}`, branch: worktreeBranchFor(name) };
    },
    changedPaths: async () => [],
    repoDirtyState: async () => new Map(),
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async (invocation) => {
      invocations.push(invocation);
      return SUCCESS;
    },
  };

  const runs: RunRecorderPort = {
    start: async (intent) => {
      started.push(intent);
      return "run-1";
    },
    finish: async (runId, outcome) => {
      finished.push({ runId, outcome });
    },
  };

  return {
    deps: { worktree, actor, runs, now: () => NOW },
    ensured,
    invocations,
    started,
    finished,
  };
}

function target(action: Action): ActTarget {
  return { goal: GOAL, decision: decision(action), attempt: 1 };
}

describe("worktreeNameFor", () => {
  it("implement の名前は goal.id のまま据え置く", () => {
    // 既存の worktree と PR のブランチ（entelecheia/<goal.id>）を引き継ぐ。
    // ここを変えると、走行中の Goal の差分が PR から消える。
    expect(worktreeNameFor(GOAL_ID, "implement")).toBe(GOAL_ID);
  });

  it("review は implement と同じ作業ツリーを見る", () => {
    // 分けると、レビューの対象が実装に永久に追いつかない。レビュー役の作業ツリーは
    // base から切られるので実装役の commit が1つも入らず、review.reviewed_sha は
    // base のまま動かない。local.head_sha は実装役の作業ツリーから観測するので、
    // Actor が1回 commit した時点で二度と一致しない（worktreeNameFor の注記）。
    expect(worktreeNameFor(GOAL_ID, "review")).toBe(worktreeNameFor(GOAL_ID, "implement"));
  });

  it("investigate は分けたままにする", () => {
    // Goal の実装とは別のものを調べる役なので、実装の作業ツリーを汚す理由が無い。
    expect(worktreeNameFor(GOAL_ID, "investigate")).not.toBe(worktreeNameFor(GOAL_ID, "implement"));
  });

  it("同じ (goal.id, role) なら何度呼んでも同じ名前になる", () => {
    // ティックをまたいで同じ作業ツリーに差分を積み上げるため、
    // 試行ごとに変わってはいけない。
    expect(worktreeNameFor(GOAL_ID, "review")).toBe(worktreeNameFor(GOAL_ID, "review"));
  });

  it("Goal が違えば、同じ role でも別の作業ツリーになる", () => {
    expect(worktreeNameFor("other-goal", "review")).not.toBe(worktreeNameFor(GOAL_ID, "review"));
  });

  it("review が checkout するブランチも implement と同じになる", () => {
    // 未 commit の関門と verifyRoot は、観測した local.branch を
    // worktreeBranchFor(worktreeNameFor(...)) と突き合わせて観測の出自を見る。
    // review が同じブランチを見る以上、その突き合わせは実装役の側だけを指す。
    const implement = worktreeBranchFor(worktreeNameFor(GOAL_ID, "implement"));
    const review = worktreeBranchFor(worktreeNameFor(GOAL_ID, "review"));

    expect(review).toBe(implement);
    expect(worktreeBranchFor(worktreeNameFor(GOAL_ID, "investigate"))).not.toBe(implement);
  });
});

describe("act の role", () => {
  it("review の ACT は implement の worktree を用意する", async () => {
    const s = spy();
    await act(target({ type: "ACT", intent: "実装をレビューする", role: "review" }), s.deps);

    expect(s.ensured).toEqual([
      { name: worktreeNameFor(GOAL_ID, "implement"), baseBranch: "main" },
    ]);
  });

  it("review の Actor には実装役の作業ツリーが渡る", async () => {
    const s = spy();
    await act(target({ type: "ACT", intent: "実装をレビューする", role: "review" }), s.deps);

    // 読む対象が実装そのものでなければ、reviewed_sha は実装の HEAD に追いつかない。
    expect(s.invocations[0]?.worktree.path).toBe(
      `/tmp/entelecheia/worktrees/${worktreeNameFor(GOAL_ID, "implement")}`,
    );
  });

  it("role を書かない ACT は implement として扱う", async () => {
    // 既に走っている Goal の Decision には role が無い。読み直したときに
    // 別の作業ツリーへ移らないようにする。
    const s = spy();
    await act(target({ type: "ACT", intent: "テストの失敗を直す" }), s.deps);

    expect(s.ensured[0]?.name).toBe(worktreeNameFor(GOAL_ID, "implement"));
  });

  it("Actor に role を渡す", async () => {
    // Actor 側が role によって使ってよいツールを変える（tests/review-actor.test.ts）。
    // 渡っていなければ、レビュー役が実装を書き換えられる。
    const s = spy();
    await act(target({ type: "ACT", intent: "実装をレビューする", role: "review" }), s.deps);

    expect(s.invocations[0]?.role).toBe("review");
  });

  it("write-ahead で書く Run に role を残す", async () => {
    // 誰がどの作業ツリーで何をしたかは、あとから ent get で読めなければならない。
    // 副作用の前に書く側（starting）に入れる。あとから足すと、
    // 途中で kill された Run の role が空のまま残る。
    const s = spy();
    await act(target({ type: "ACT", intent: "実装をレビューする", role: "review" }), s.deps);

    expect(s.started[0]?.role).toBe("review");
    expect(s.started[0]?.worktree).toBe(worktreeNameFor(GOAL_ID, "review"));
  });

  it("Run のスキーマが role を持つ", async () => {
    const s = spy();
    const result = await act(
      target({ type: "ACT", intent: "実装をレビューする", role: "review" }),
      s.deps,
    );

    expect(result.acted).toBe(true);
    if (result.acted) {
      expect(runSchema.parse(result.run).role).toBe("review");
    }
  });

  it("implement と review は同じ作業ツリーを共有する", async () => {
    // 1ティックで起動する Actor は1体なので（design.md §5）、同じティックの中で
    // 両者が同じ作業ツリーを触ることはない。残る「レビュー役が破壊的な git を打つ」
    // 経路は、拒否リスト（DESTRUCTIVE_GIT）で塞ぐ。
    const s = spy();
    await act(target({ type: "ACT", intent: "実装する", role: "implement" }), s.deps);
    await act(target({ type: "ACT", intent: "レビューする", role: "review" }), s.deps);

    const paths = s.invocations.map((invocation) => invocation.worktree.path);
    expect(new Set(paths).size).toBe(1);
  });
});
