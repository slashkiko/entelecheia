import { describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import { PortError } from "../src/domain/port-error.js";
import type { Run } from "../src/domain/run.js";
import type { Verification } from "../src/domain/verification.js";
import type { ReviewPort, ReviewRunSnapshot } from "../src/observe/index.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type ProgressSink,
  type PublishTarget,
  type PullRequestDraft,
  publish,
} from "../src/publish/index.js";

/**
 * レビュー役の本文を `--report` の宛先に出す（issue #59 の案1）。
 *
 * レビュー役が返した本文は、Fact になる過程で `review.verdict` と
 * `review.reviewed_sha` の2つに畳まれる。本文そのものは
 * `.goals/.state/runs/<id>/log.jsonl` に残るだけで、`ent run` の出力にも
 * `--report` の出力にも出ない。人間が読めるのは verdict の1語になる。
 *
 * `approved` は「何も言うことが無い」ではない。いまの形は、承認と同時に
 * その承認の理由と留保を捨てている。
 *
 * 満たすべき性質:
 * - `--report` の本文の**後ろ**に節として足す。criteria の表の位置は動かさない
 * - 本文はそのまま出す。潰さない・切らない（要約ではなく本文を取り返す）
 * - PR コメントには載せない（issue #59 の案3 は採らない）。したがって
 *   `--report` の本文と PR コメントの本文は同じでなくなる
 * - `--report` を付けないティックでは、レビュー役のログを読みに行かない
 * - 読めなかったときも黙らない。黙って落とすと、この Goal が直そうとしている
 *   壊れ方をもう1つ作ることになる
 * - どの経路でも throw しない、という publish の既存の性質は変えない
 *
 * 出どころは既にある `ReviewPort` で、新しい Port も Adapter も作らない。
 * `ControllerDeps` は `ObserveDeps` を継承しているので、`publish` に渡っている
 * `deps` には既に `review` が入っている。`src/controller/index.ts` と
 * `src/wiring/index.ts`（どちらも `PROTECTED_PATH_FLOOR` の中）は触らずに読める。
 */

/** 節の見出し。宛先の本文のどこに足したかを、読む側が探せるようにする */
const HEADING = "## Review role message";

const NOW = new Date("2026-08-12T06:00:00.000Z");

/**
 * レビュー役が返した本文の代わり。**加工されたら気づける形にしてある。**
 *
 * 改行・表・コードブロック・`|`・120 字を超える行のどれかが落ちれば、
 * `toContain` が丸ごと落ちる。既存の `flatten` は改行を潰し、`oneLine` は
 * 120 字で切って `|` を退避するので、そこを通した実装はここで止まる。
 */
const REVIEW_MESSAGE = [
  "verdict: changes_requested",
  "reviewed_sha: 0123456789abcdef0123456789abcdef01234567",
  "",
  "## 指摘",
  "",
  "回帰テストの fixture が第3ソートキーで通っており、第1キーを外してもテストは同じ結果で通ってしまう。つまりこのテストは、宣言している性質を実際には確かめていない。",
  "",
  "| 箇所 | 種別 | 根拠 |",
  "|---|---|---|",
  "| tests/store-list.test.ts | 検証の穴 | fixture が第3キーで一意 |",
  "",
  "```ts",
  "expect(rows.map((r) => r.id)).toEqual(['a', 'b']);",
  "```",
].join("\n");

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

const COMPLETED_RUN: Run = {
  id: "1",
  intent: "実装する",
  actor: "claude-code",
  role: "implement",
  worktree: "sample-goal",
  attempt: 1,
  startedAt: NOW.toISOString(),
  status: "completed",
  finishedAt: NOW.toISOString(),
  exitCode: 0,
  logRef: "runs/1/log.jsonl",
  tokens: 3400,
  artifacts: [],
  detail: null,
};

const DECISION: Decision = {
  decidedAt: NOW.toISOString(),
  action: { type: "ACT", intent: "落ちているテストを通す", role: "implement" },
  rationale: "Gap が 1 件ある",
  decidedBy: "llm",
};

const VERIFICATIONS: Verification[] = [
  {
    criterionId: "ac-1",
    result: "failed",
    reason: null,
    evidence: { source: "mise run test", detail: "exit_code=1" },
    detail: "exit_code=1",
    verifiedAt: NOW.toISOString(),
  },
];

interface Sink {
  writer: CodeWriterPort;
  branch: BranchPort;
  comments: { prNumber: number; body: string }[];
}

function sink(over: { existing?: number | null } = {}): Sink {
  const comments: { prNumber: number; body: string }[] = [];
  const created: PullRequestDraft[] = [];

  return {
    comments,
    writer: {
      findPullRequest: async () => over.existing ?? null,
      createPullRequest: async (draft) => {
        created.push(draft);
        return 42;
      },
      addComment: async (prNumber, body) => {
        comments.push({ prNumber, body });
      },
    },
    branch: {
      push: async (name) => ({ branch: `entelecheia/${name}`, pushed: true }),
    },
  };
}

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    goal: GOAL,
    run: COMPLETED_RUN,
    decision: DECISION,
    verifications: VERIFICATIONS,
    prNumber: 11,
    digest: "digest-2",
    previousDigest: "digest-1",
    ...over,
  };
}

function deps(s: Sink) {
  return { writer: s.writer, branch: s.branch, now: () => NOW };
}

/** PR の外に書く宛先。`ent run --report` が渡すものと同じ形にする */
function recorder(): { sink: ProgressSink; written: string[] } {
  const written: string[] = [];
  return {
    written,
    sink: {
      destination: "file",
      write: async (body) => {
        written.push(body);
      },
    },
  };
}

/**
 * 直近のレビュー役の Run を読む口。呼ばれた回数を数える。
 *
 * `--report` を付けないティックで読みに行っていないことを、回数で確かめる。
 */
function reviewPort(over: { snapshot?: ReviewRunSnapshot | null; fails?: unknown } = {}): {
  port: ReviewPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      latest: async () => {
        calls += 1;
        if (over.fails !== undefined) {
          throw over.fails;
        }
        return over.snapshot === undefined
          ? { runId: "run-7", finalMessage: REVIEW_MESSAGE }
          : over.snapshot;
      },
    },
  };
}

/** レビュー役を読まない構成で書かれた、いまの進捗コメントの本文 */
async function bodyWithoutReview(): Promise<string> {
  const s = sink({ existing: 11 });
  await publish(target(), deps(s));
  const body = s.comments[0]?.body;
  if (body === undefined) {
    throw new Error("進捗コメントが書かれなかった");
  }
  return body;
}

describe("レビュー役の本文を --report に載せる", () => {
  it("最終メッセージがそのまま入る", async () => {
    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort();

    const result = await publish(target(), { ...deps(s), report: r.sink, review: review.port });

    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toContain(HEADING);
    // 潰さない・切らない。要約ではなく本文を取り返すのがこの Goal の目的になる。
    expect(r.written[0]).toContain(REVIEW_MESSAGE);
    // どの Run を読んだかが分からないと、生ログに戻れない。
    expect(r.written[0]).toContain("run-7");
    expect(result.report).toEqual({ destination: "file", written: true, error: null });
  });

  it("いまの本文の後ろに足す。criteria の表より前に割り込ませない", async () => {
    // 表は宛先を問わず同じ位置で読めるようにしておく。前に割り込ませると、
    // 14,000 字の本文を読み飛ばさないと pass 状況に辿り着けない。
    const base = await bodyWithoutReview();

    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort();
    await publish(target(), { ...deps(s), report: r.sink, review: review.port });

    expect(r.written[0]?.startsWith(base)).toBe(true);
    expect(r.written[0]?.length).toBeGreaterThan(base.length);
  });

  it("PR コメントには載せない。読みにも行かない", async () => {
    // issue #59 の案3（PR に投稿する）は採らない。使わない本文のために
    // 毎ティック生ログを開くのは無駄で、失敗する口も増える。
    const s = sink({ existing: 11 });
    const review = reviewPort();

    const result = await publish(target(), { ...deps(s), review: review.port });

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).not.toContain(HEADING);
    expect(s.comments[0]?.body).not.toContain("回帰テストの fixture");
    expect(review.calls()).toBe(0);
  });

  it("レビュー役を1度も起動していなければ、節そのものを出さない", async () => {
    const base = await bodyWithoutReview();

    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort({ snapshot: null });
    await publish(target(), { ...deps(s), report: r.sink, review: review.port });

    expect(review.calls()).toBe(1);
    expect(r.written[0]).toBe(base);
  });

  it("生ログを読めなかったときも黙らない", async () => {
    // 黙って落とすと、この Goal が直そうとしている壊れ方をもう1つ作ることになる。
    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort({
      fails: new PortError(
        "unavailable",
        "レビュー役の Run run-7 の生ログを読めなかった（runs/run-7/log.jsonl）: ENOENT",
      ),
    });

    const result = await publish(target(), { ...deps(s), report: r.sink, review: review.port });

    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toContain(HEADING);
    expect(r.written[0]).toContain("ENOENT");
    // 通知の失敗ではない。宛先には書けているので written は true のままになる。
    expect(result.report?.written).toBe(true);
  });

  it("読み取りが落ちても throw しない", async () => {
    // publish はどの経路でも throw しない（design.md §9）。この節のために
    // その性質を崩さない。通知の失敗でティック全体を落とさないのが元の理由になる。
    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort({ fails: new Error("boom") });

    await expect(
      publish(target(), { ...deps(s), report: r.sink, review: review.port }),
    ).resolves.toBeTruthy();
  });

  it("本文が残っていない Run でも、読んだ Run の id は出す", async () => {
    // 途中で切れた Run。Adapter は空文字で返す（`src/adapters/review-run.ts`）。
    // 「本文が空だった」と「レビューを回していない」を同じ見た目にしない。
    const base = await bodyWithoutReview();

    const s = sink({ existing: 11 });
    const r = recorder();
    const review = reviewPort({ snapshot: { runId: "run-9", finalMessage: "" } });
    await publish(target(), { ...deps(s), report: r.sink, review: review.port });

    expect(r.written[0]).toContain(HEADING);
    expect(r.written[0]).toContain("run-9");
    expect(r.written[0]).not.toBe(base);
  });

  it("review を渡さない呼び出しでも落ちない", async () => {
    // `PublishDeps.review` は任意にする。渡さない構成（既存のテストと、
    // publish を単体で呼ぶ経路）では、いままでどおり PR コメントと同じ本文になる。
    const base = await bodyWithoutReview();

    const s = sink({ existing: 11 });
    const r = recorder();
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(r.written[0]).toBe(base);
    expect(result.report?.written).toBe(true);
  });
});
