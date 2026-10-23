import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { LlmPort } from "../src/decide/index.js";
import type { Fact, Unresolved } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { AcceptanceCriterion, Goal } from "../src/domain/goal.js";
import { pendingReviewCriteria } from "../src/domain/verification.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * 実装が入ったティックで、古いレビューが「現在の HEAD へのレビュー」として
 * 通らないこと（issue #63）。
 *
 * 1ティックの中は OBSERVE → ACT → publish の順に進む。実装役が走ったティックでは、
 * VERIFY が読む `local.head_sha` は ACT より前の観測なので、`review.reviewed_sha` と
 * 一致する。そのティックの publish の時点では HEAD が次の commit へ動いているので、
 * 🟢 の根拠になった一致は「レビュー時点のスナップショットどうしの一致」でしかない。
 * 実測でも、実装役が動いたティックだけ `review.verdict == approved` の criterion が
 * 🟢 になり、次のティックで 🔴 に戻った。
 *
 * **鮮度の判定そのもの（`judgeReviewVerdict`）は触らない。** 順序の問題であって、
 * 判定ロジックの問題ではない。実装役が走ったティックでは、レビュー系の criteria を
 * 判定しない（pending）側へ倒す。
 *
 * 倒す先を「不合格」にしないのは design.md §3.1 と同じ理由になる。ACT のあとの
 * HEAD を誰かが読んだかどうかは、このティックでは確かめようがない。確かめられない
 * ものを不合格として記録すると、観測の穴が実装の不備として PR に出る。
 *
 * 逆向きの誤り——「レビュー系はいつでも判定しない」——も同じだけ困る。実装役が
 * 走らなかったティックでは HEAD が動かないので、これまでどおり判定する。
 */

const NOW = new Date("2026-08-12T09:00:00.000Z");
const WORKTREE_ROOT = "/tmp/entelecheia/worktrees";
const GOAL_ID = "review-pending-goal";
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

/** レビュー役の結論。`local.head_sha` と一致していれば「現在の HEAD へのレビュー」になる */
const REVIEW_CRITERION: AcceptanceCriterion = {
  id: "ac-review",
  description: "レビュー役が approved を返している",
  verification: { type: "fact", key: "review.verdict", equals: "approved" },
};

/** レビューとは関係のない fact criterion。判定を続けることを確かめる側 */
const FACT_CRITERION: AcceptanceCriterion = {
  id: "ac-clean",
  description: "作業ツリーに未 commit の変更が無い",
  verification: { type: "fact", key: "local.dirty", equals: false },
};

const COMMAND_CRITERION: AcceptanceCriterion = {
  id: "ac-test",
  description: "テストが通る",
  verification: { type: "command", run: "mise run test" },
};

/**
 * 承認されていない human の criterion。
 *
 * Gap を1つ残すために置く。Gap がゼロだと DECIDE は LLM を呼ばずに COMPLETE か
 * WAIT を返すので（`decide()` の3番目）、実装役が走るティックを作れない。
 */
const HUMAN_CRITERION: AcceptanceCriterion = {
  id: "ac-human",
  description: "人間が差分を読む",
  verification: { type: "human", prompt: "差分を読んでください" },
};

const CRITERIA = [REVIEW_CRITERION, FACT_CRITERION, COMMAND_CRITERION, HUMAN_CRITERION];

function goalWith(criteria: readonly AcceptanceCriterion[] = CRITERIA): Goal {
  return {
    version: 1,
    goal: { id: GOAL_ID, name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
    repository: {
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    },
    setup: [],
    acceptance_criteria: [...criteria],
    context: { background: "背景", constraints: [], references: [] },
    policies: { require_human_approval: ["merge"], protected_paths: [] },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 9,
    },
  };
}

/** レビュー役が返した本文。実物と同じく複数行にする */
function reviewMessage(sha: string): string {
  return [`読んだ commit は ${sha} です。`, "", "指摘はありません。", "", "verdict: approved"].join(
    "\n",
  );
}

interface Options {
  /** レビュー役が読んだ commit。既定は現在の HEAD（＝鮮度の判定は通る側） */
  reviewedSha?: string;
  /** LLM が返す行動。既定は実装役の ACT */
  llm?: LlmPort;
  /** 見るだけのティック（`ent run --dry-run`） */
  dryRun?: boolean;
  /** PR に書かれた進捗コメントの本文 */
  comments?: string[];
}

function deps(store: Store, options: Options = {}): ControllerDeps {
  const comments = options.comments;
  return {
    store,
    owner: "worker-a",
    leaseSeconds: 300,
    worktreeRoot: WORKTREE_ROOT,
    review: {
      latest: async () => ({
        runId: "run-7",
        finalMessage: reviewMessage(options.reviewedSha ?? HEAD),
      }),
    },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({
        branch: `entelecheia/${GOAL_ID}`,
        headSha: HEAD,
        dirty: false,
      }),
    },
    command: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    approval: {
      getApproval: async () => null,
    },
    worktree: {
      ensure: async (name) => ({
        path: `${WORKTREE_ROOT}/${name}`,
        branch: `entelecheia/${name}`,
      }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    },
    actor: {
      kind: "claude-code",
      run: async () => ({ exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] }),
    },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async (_prNumber, body) => {
        comments?.push(body);
      },
    },
    branch: {
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }),
    },
    llm: options.llm ?? { chooseAction: async () => ({ type: "ACT", intent: "実装を進める" }) },
    now: () => NOW,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  };
}

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

function activate(goal: Goal): void {
  store.upsertGoal(goal);
  store.setStatus(GOAL_ID, "ACTIVE", null);
}

/** 保存された criteria 単位の検証結果を1件引く */
function verificationFor(id: string) {
  return store.latestVerifications(GOAL_ID).find((v) => v.criterionId === id);
}

describe("実装役が走ったティックでは、レビュー系の criteria を判定しない", () => {
  it("レビュー時点と同じ sha でも 🟢 にしない", async () => {
    // これが issue #63 で観測された形。OBSERVE の時点では
    // review.reviewed_sha == local.head_sha だが、そのティックの publish で
    // HEAD は次の commit へ動いている。
    const goal = goalWith();
    activate(goal);

    const result = await tick(goal, deps(store));

    expect(result.run?.role).toBe("implement");
    expect(verificationFor("ac-review")?.result).not.toBe("passed");
  });

  it("判定できないものを不合格として記録しない", async () => {
    // 「🔴 落ちた」と「⏸ このティックでは判定しない」を混ぜない（design.md §3.1）。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    const verification = verificationFor("ac-review");
    expect(verification?.result).toBe("unresolved");
    expect(verification?.reason).toBe("pending");
  });

  it("なぜ判定しないのかが detail に残る", async () => {
    // `ent get` と PR の進捗コメントに出る唯一の説明になる。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    expect(verificationFor("ac-review")?.detail).toContain("implement role");
  });

  it("判定できなかった criterion の Fact を残さない", async () => {
    // `criteria.<id>.passed` は次のティックへ引き継がれる。true のまま残すと、
    // 誰も読んでいない commit への承認が VERIFIED な Fact として生き続ける。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    const facts = store.latestSnapshot(GOAL_ID)?.facts ?? [];
    expect(facts.map((f) => f.key)).not.toContain(criterionFactKey("ac-review"));
  });

  it("結論が出なかった対象として残す", async () => {
    // Fact を落とすだけだと、§3.1 が避けたかった「Fact の不在」に畳まれる。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    const unresolved = store.latestSnapshot(GOAL_ID)?.unresolved ?? [];
    expect(unresolved.map((u) => u.key)).toContain(criterionFactKey("ac-review"));
  });

  it("レビュー役が読んだ結論そのもの（review.verdict）は消さない", async () => {
    // いつどの commit を読んだかは、後から追えるようにしておく。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    const facts = store.latestSnapshot(GOAL_ID)?.facts ?? [];
    expect(facts.find((f) => f.key === "review.verdict")?.value).toBe("approved");
    expect(facts.find((f) => f.key === "review.reviewed_sha")?.value).toBe(HEAD);
  });

  it("レビューに依存しない fact criterion は、これまでどおり判定する", async () => {
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    expect(verificationFor("ac-clean")?.result).toBe("passed");
  });

  it("command 型の criteria も、これまでどおり判定する", async () => {
    // 機械側の criteria が通ったティックで controller が commit する経路
    // （design.md §10-11）を、レビューの都合で止めない。
    const goal = goalWith();
    activate(goal);

    await tick(goal, deps(store));

    expect(verificationFor("ac-test")?.result).toBe("passed");
  });

  it("進捗コメントから pending だと読める", async () => {
    const goal = goalWith();
    activate(goal);
    const comments: string[] = [];

    await tick(goal, deps(store, { comments }));

    // 落ちた criteria と同じ見た目にしない。表は `MARKERS` で色分けされる。
    const row = comments
      .join("\n")
      .split("\n")
      .find((line) => line.startsWith("| `ac-review` |"));
    expect(row).toContain("🟡 unresolved");
    expect(row).toContain("implement role");
  });
});

describe("実装役が走らなかったティックは、これまでどおり", () => {
  it("ACT を選ばなかったティックでは、レビュー系の criteria を判定する", async () => {
    // HEAD が動かないティックでは、OBSERVE 時点の一致がそのまま publish 時点の
    // 一致になる。ここまで pending にすると、レビューは永久に完了判定に使えない。
    const goal = goalWith();
    activate(goal);
    const llm: LlmPort = {
      chooseAction: async () => ({ type: "WAIT", reason: "review_pending" }),
    };

    const result = await tick(goal, deps(store, { llm }));

    expect(result.run).toBeNull();
    expect(verificationFor("ac-review")?.result).toBe("passed");
  });

  it("レビュー役が走ったティックでは、これまでどおり判定する", async () => {
    // レビュー役は読むだけなので、押す木の HEAD は動かない。
    // 古い commit を読んだ結論はこれまでどおり 🔴 になる。
    const goal = goalWith();
    activate(goal);
    const llm: LlmPort = {
      chooseAction: async () => ({ type: "ACT", role: "review", intent: "差分を読む" }),
    };

    const result = await tick(goal, deps(store, { llm, reviewedSha: OLDER }));

    expect(result.run?.role).toBe("review");
    expect(verificationFor("ac-review")?.result).toBe("failed");
  });

  it("dry-run は書かないので、これまでどおり判定する", async () => {
    // 見るだけのティックは Actor を起動しない。HEAD が動かない以上、
    // 観測した時点の判定をそのまま見せるのが正しい。
    const goal = goalWith();
    activate(goal);

    const result = await tick(goal, deps(store, { dryRun: true }));

    const verification = result.observed?.verifications.find((v) => v.criterionId === "ac-review");
    expect(verification?.result).toBe("passed");
  });
});

describe("pendingReviewCriteria", () => {
  function fact(key: string, value: unknown): Fact {
    return {
      key,
      value,
      observedAt: NOW.toISOString(),
      confidence: "VERIFIED",
      evidence: { source: "verify", detail: "detail" },
    };
  }

  const REVIEWED_SHA_CRITERION: AcceptanceCriterion = {
    id: "ac-sha",
    description: "レビュー役が現在の HEAD を読んでいる",
    verification: { type: "fact", key: "review.reviewed_sha", equals: HEAD },
  };

  it("review.verdict を見る criterion を pending にする", () => {
    const result = pendingReviewCriteria(
      [REVIEW_CRITERION],
      [fact(criterionFactKey("ac-review"), true)],
      [],
    );

    expect(result.facts).toEqual([]);
    expect(result.unresolved).toEqual([
      { key: criterionFactKey("ac-review"), reason: "pending", detail: expect.any(String) },
    ]);
  });

  it("review.reviewed_sha を見る criterion も pending にする", () => {
    // 鮮度を criterion に直接書く形もある。どちらのキーも ACT より前の観測になる。
    const result = pendingReviewCriteria(
      [REVIEWED_SHA_CRITERION],
      [fact(criterionFactKey("ac-sha"), true)],
      [],
    );

    expect(result.facts).toEqual([]);
    expect(result.unresolved.map((u) => u.key)).toEqual([criterionFactKey("ac-sha")]);
  });

  it("レビューに依存しない criterion の Fact は落とさない", () => {
    const result = pendingReviewCriteria(
      [REVIEW_CRITERION, FACT_CRITERION],
      [fact(criterionFactKey("ac-review"), true), fact(criterionFactKey("ac-clean"), true)],
      [],
    );

    expect(result.facts.map((f) => f.key)).toEqual([criterionFactKey("ac-clean")]);
  });

  it("観測そのものの Fact は落とさない", () => {
    // レビューをいつ回したかは、後から追えるようにしておく。
    const result = pendingReviewCriteria(
      [REVIEW_CRITERION],
      [fact("review.verdict", "approved"), fact("review.reviewed_sha", HEAD)],
      [],
    );

    expect(result.facts.map((f) => f.key)).toEqual(["review.verdict", "review.reviewed_sha"]);
  });

  it("既に unresolved に積まれている criterion を二重にしない", () => {
    // 検証できなかった理由が既にあるなら、そちらを残す。
    const already: Unresolved = {
      key: criterionFactKey("ac-review"),
      reason: "port_failed",
      detail: "ReviewPort が落ちた",
    };

    const result = pendingReviewCriteria([REVIEW_CRITERION], [], [already]);

    expect(result.unresolved).toEqual([already]);
  });

  it("レビュー系の criteria が1つも無ければ何も変えない", () => {
    const facts = [fact(criterionFactKey("ac-clean"), true)];

    const result = pendingReviewCriteria([FACT_CRITERION], facts, []);

    expect(result.facts).toEqual(facts);
    expect(result.unresolved).toEqual([]);
  });
});
