import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Goal } from "../src/domain/goal.js";
import type { RunIntent, RunOutcome } from "../src/domain/run.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `runs` の行だけでなく、行が**指している先の中身**も関門に載せる。
 *
 * `log_ref` が指すのは `.goals/.state/runs/<id>/log.jsonl` で、実装役の Agent は
 * worktree の外にあるそれを Bash で上書きできる。書き換えても誰も見ていなかった。
 * `changedPaths` は worktree の中しか見ず、`repoDirtyState` の `git status` は
 * `--ignored` を付けないので gitignore 済みのそこに届かず、`outOfSightState` が
 * 見るのは `.git/hooks/**` と `core.hooksPath` だけになる。
 *
 * そのファイルは飾りではない。`reviewRunLog` が直近の完了したレビュー役の Run の
 * 本文をそこから読み、observe が `review.verdict` と `review.reviewed_sha` を
 * **VERIFIED な Fact** にする。実装役が自分で commit して HEAD を固定し、前の
 * レビューのログに `verdict: approved` とその sha を書けば、次のティックで
 * `{ type: fact, key: review.verdict, equals: approved }` が緑になる。しかも
 * `reviewedHeadOf` が「同じ commit を2度レビューさせない」ため、**本物のレビューは
 * もう走らない。** 人間に届く証拠は、誰も書いていないレビューになる。
 *
 * `ownRunDrift` は `UPDATE runs SET role='review'`（実装役が自分の Run を
 * レビュー役に化けさせる形）を止めていた。その隣で、より安い生ログの上書きが
 * 通っていた。行と中身で守り方を変える理由が無いので、中身も同じ関門に載せる。
 */

const NOW = new Date("2026-08-12T08:00:00.000Z");

let dir: string;
let store: Store;

function goalWith(id: string): Goal {
  return {
    version: 1,
    goal: { id, name: "サンプル", desired_state: "何かが完成している", depends_on: [] },
    repository: {
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    },
    setup: [],
    acceptance_criteria: [],
    policies: {
      max_reconciles: 10,
      max_actor_runs: 5,
      max_unchanged_reconciles: 3,
      max_wall_clock: "24h",
      require_human_approval: [],
      protected_paths: [],
    },
  } as unknown as Goal;
}

/** 生ログを1本置いて、その Run を完了させる。返すのは log の置き場所 */
function completedRun(role: RunIntent["role"], body: string): { runId: string; logRef: string } {
  const runId = store.startRun("goal-a", {
    intent: "レビューする",
    actor: "claude-code",
    role,
    worktree: "w",
    attempt: 1,
    startedAt: NOW.toISOString(),
  });
  const logRef = join(dir, ".goals", ".state", "runs", runId, "log.jsonl");
  mkdirSync(join(logRef, ".."), { recursive: true });
  writeFileSync(logRef, body);

  const outcome: RunOutcome = {
    status: "completed",
    finishedAt: NOW.toISOString(),
    exitCode: 0,
    logRef,
    tokens: 1,
    artifacts: [],
    detail: null,
  };
  store.finishRun(runId, outcome);
  return { runId, logRef };
}

function resultLine(text: string): string {
  return `${JSON.stringify({ type: "result", result: text })}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ent-review-log-"));
  mkdirSync(join(dir, ".goals", ".state"), { recursive: true });
  store = openStore(join(dir, ".goals", ".state", "goals.db"));
  store.upsertGoal(goalWith("goal-a"));
  store.setStatus("goal-a", "ACTIVE", null, NOW.toISOString());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("レビュー役の生ログの上書きで、関門が鳴る", () => {
  it("本文を書き換えるとダイジェストが動く", () => {
    const { logRef } = completedRun("review", resultLine("verdict: changes_requested"));
    const before = store.guardDigest("goal-a");

    // 実装役が worktree の外から上書きする形。行は1バイトも変わらない。
    writeFileSync(logRef, resultLine("verdict: approved\nreviewed_sha: " + "a".repeat(40)));

    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("生ログを消してもダイジェストが動く", () => {
    const { logRef } = completedRun("review", resultLine("verdict: changes_requested"));
    const before = store.guardDigest("goal-a");

    rmSync(logRef);

    // 読めないことを `missing` に倒す。throw して guard_unavailable にはしない。
    expect(store.guardDigest("goal-a")).not.toBe(before);
  });

  it("触らなければ値は動かない", () => {
    completedRun("review", resultLine("verdict: changes_requested"));

    expect(store.guardDigest("goal-a")).toBe(store.guardDigest("goal-a"));
  });
});

describe("載せるのは、Fact の材料になる生ログだけ", () => {
  it("実装役の生ログは載せない", () => {
    // 読む対象ではないので、ティックごとに全 Run 分の I/O を増やさない。
    const { logRef } = completedRun("implement", resultLine("実装した"));
    const before = store.guardDigest("goal-a");

    writeFileSync(logRef, resultLine("何か別のことを書いた"));

    expect(store.guardDigest("goal-a")).toBe(before);
  });

  it("完了していないレビュー役の生ログは載せない", () => {
    // `latestReviewRun` が選ばないもの。走行中の Run のログは Adapter が
    // まさに書いている最中で、前後で比べれば必ず動く。
    const runId = store.startRun("goal-a", {
      intent: "レビューする",
      actor: "claude-code",
      role: "review",
      worktree: "w",
      attempt: 1,
      startedAt: NOW.toISOString(),
    });
    const logRef = join(dir, ".goals", ".state", "runs", runId, "log.jsonl");
    mkdirSync(join(logRef, ".."), { recursive: true });
    writeFileSync(logRef, resultLine("途中"));

    const before = store.guardDigest("goal-a");
    writeFileSync(logRef, resultLine("まだ途中"));

    expect(store.guardDigest("goal-a")).toBe(before);
  });

  it("自分のティックで作った Run の生ログは載せない", () => {
    // ACT の窓のあいだ Adapter が書き続ける。落とさないと毎ティック鳴る。
    const { runId, logRef } = completedRun("review", resultLine("verdict: approved"));
    const before = store.guardDigest("goal-a", [runId]);

    writeFileSync(logRef, resultLine("verdict: changes_requested"));

    expect(store.guardDigest("goal-a", [runId])).toBe(before);
  });

  it("別の Goal のレビュー役の生ログでは動かない", () => {
    store.upsertGoal(goalWith("goal-b"));
    store.setStatus("goal-b", "ACTIVE", null, NOW.toISOString());
    completedRun("review", resultLine("verdict: approved"));
    const before = store.guardDigest("goal-b");

    const otherRun = store.startRun("goal-b", {
      intent: "レビューする",
      actor: "claude-code",
      role: "review",
      worktree: "w",
      attempt: 1,
      startedAt: NOW.toISOString(),
    });
    const otherLog = join(dir, ".goals", ".state", "runs", otherRun, "log.jsonl");
    mkdirSync(join(otherLog, ".."), { recursive: true });
    writeFileSync(otherLog, resultLine("verdict: approved"));
    store.finishRun(otherRun, {
      status: "completed",
      finishedAt: NOW.toISOString(),
      exitCode: 0,
      logRef: otherLog,
      tokens: 1,
      artifacts: [],
      detail: null,
    });

    // goal-b 側は行が増えたので動く。goal-a 側は動かない、が下の主張。
    expect(store.guardDigest("goal-b")).not.toBe(before);
  });

  it("別の Goal の生ログを書き換えても、こちらの値は動かない", () => {
    completedRun("review", resultLine("verdict: approved"));
    store.upsertGoal(goalWith("goal-b"));
    store.setStatus("goal-b", "ACTIVE", null, NOW.toISOString());

    const otherRun = store.startRun("goal-b", {
      intent: "レビューする",
      actor: "claude-code",
      role: "review",
      worktree: "w",
      attempt: 1,
      startedAt: NOW.toISOString(),
    });
    const otherLog = join(dir, ".goals", ".state", "runs", otherRun, "log.jsonl");
    mkdirSync(join(otherLog, ".."), { recursive: true });
    writeFileSync(otherLog, resultLine("verdict: approved"));
    store.finishRun(otherRun, {
      status: "completed",
      finishedAt: NOW.toISOString(),
      exitCode: 0,
      logRef: otherLog,
      tokens: 1,
      artifacts: [],
      detail: null,
    });

    const before = store.guardDigest("goal-a");
    writeFileSync(otherLog, resultLine("verdict: changes_requested"));

    expect(store.guardDigest("goal-a")).toBe(before);
  });
});
