import { describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { Run } from "../src/domain/run.js";
import type { Verification } from "../src/domain/verification.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type ProgressSink,
  type PublishTarget,
  type PullRequestDraft,
  publish,
} from "../src/publish/index.js";

/**
 * PR の確保と進捗の通知。design.md §9 の「PR と通知」。
 *
 * テストから実際の GitHub を叩かない。git push もしない。どちらも Port で注入する。
 */

const NOW = new Date("2026-08-09T06:00:00.000Z");

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

/**
 * レビュー役の Run。**`worktree` を実装役と別名にしてある。**
 *
 * `push` 先が `run.worktree` に戻る退行を、テストが捕まえられるようにするため。
 * 実装役の Run だけで固定していると `worktree` が `worktreeNameFor(id, "implement")`
 * と同じ値になり、押す先を Run 側に従わせても assert が通ってしまう。
 */
const REVIEW_RUN: Run = {
  id: "2",
  intent: "差分を読む",
  actor: "claude-code",
  role: "review",
  worktree: "sample-goal-review",
  attempt: 1,
  startedAt: NOW.toISOString(),
  status: "completed",
  finishedAt: NOW.toISOString(),
  exitCode: 0,
  logRef: "runs/2/log.jsonl",
  tokens: 1200,
  artifacts: [],
  detail: null,
};

const COMPLETED_RUN: Run = {
  id: "1",
  intent: "テストの失敗を直す",
  actor: "claude-code",
  role: "implement",
  worktree: "sample-goal",
  attempt: 1,
  startedAt: NOW.toISOString(),
  status: "completed",
  finishedAt: NOW.toISOString(),
  exitCode: 0,
  logRef: "runs/1/log.jsonl",
  tokens: 31397,
  artifacts: ["src/cli.ts"],
  detail: null,
};

const DECISION: Decision = {
  decidedAt: NOW.toISOString(),
  action: { type: "ACT", intent: "テストの失敗を直す" },
  rationale: "Gap が 1 件ある",
  decidedBy: "llm",
};

function verification(over: Partial<Verification> = {}): Verification {
  return {
    criterionId: "ac-1",
    result: "failed",
    reason: null,
    evidence: { source: "mise run test", detail: "exit_code=1" },
    detail: "exit_code=1",
    verifiedAt: NOW.toISOString(),
    ...over,
  };
}

const VERIFICATIONS: Verification[] = [verification()];

interface Sink {
  writer: CodeWriterPort;
  branch: BranchPort;
  created: PullRequestDraft[];
  comments: { prNumber: number; body: string }[];
  pushes: { name: string; base: string }[];
  finds: string[];
}

function sink(
  over: {
    existing?: number | null;
    pushed?: boolean;
    createFails?: boolean;
    commentFails?: boolean;
    pushFails?: boolean;
  } = {},
): Sink {
  const created: PullRequestDraft[] = [];
  const comments: { prNumber: number; body: string }[] = [];
  const pushes: { name: string; base: string }[] = [];
  const finds: string[] = [];

  return {
    created,
    comments,
    pushes,
    finds,
    writer: {
      findPullRequest: async (head) => {
        finds.push(head);
        return over.existing ?? null;
      },
      createPullRequest: async (draft) => {
        if (over.createFails === true) {
          throw new Error("422 Validation Failed");
        }
        created.push(draft);
        return 42;
      },
      addComment: async (prNumber, body) => {
        if (over.commentFails === true) {
          throw new Error("403 Forbidden");
        }
        comments.push({ prNumber, body });
      },
    },
    branch: {
      push: async (name, base) => {
        if (over.pushFails === true) {
          throw new Error("base ブランチには push しない: main");
        }
        pushes.push({ name, base });
        return { branch: `entelecheia/${name}`, pushed: over.pushed ?? true };
      },
    },
  };
}

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    goal: GOAL,
    run: COMPLETED_RUN,
    decision: DECISION,
    verifications: VERIFICATIONS,
    prNumber: null,
    digest: "digest-2",
    previousDigest: "digest-1",
    ...over,
  };
}

function deps(s: Sink) {
  return { writer: s.writer, branch: s.branch, now: () => NOW };
}

/**
 * PR の外に書く宛先。`ent run --report` が渡すものと同じ形にする。
 *
 * 実際のファイルにも stdout にも触らない。宛先の実体は CLI 側の責務で、
 * ここで確かめたいのは「PR ではなくこちらに1回だけ書く」ことになる。
 */
function recorder(over: { fails?: boolean } = {}): { sink: ProgressSink; written: string[] } {
  const written: string[] = [];
  return {
    written,
    sink: {
      destination: "file",
      write: async (body) => {
        if (over.fails === true) {
          throw new Error("EACCES: permission denied");
        }
        written.push(body);
      },
    },
  };
}

describe("PR を確保する", () => {
  it("完了した Run と差分があれば PR を作る", async () => {
    const s = sink();
    const result = await publish(target(), deps(s));

    expect(result.prNumber).toBe(42);
    expect(result.created).toBe(true);
    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
    expect(s.created[0]?.head).toBe("entelecheia/sample-goal");
    expect(s.created[0]?.base).toBe("main");
  });

  it("作る前に既存の PR を探す", async () => {
    // push まで済んで作成の前に kill されたとき、2本目を立てるとどちらが正かを決められない。
    const s = sink({ existing: 7 });
    const result = await publish(target(), deps(s));

    expect(s.finds).toEqual(["entelecheia/sample-goal"]);
    expect(result.prNumber).toBe(7);
    expect(result.created).toBe(false);
    expect(s.created).toEqual([]);
  });

  it("既に番号を知っていれば探索も作成もしない", async () => {
    // push はする。ここで止めていたのが誤りだった（下の「2ティック目以降の push」）。
    const s = sink();
    const result = await publish(target({ prNumber: 11 }), deps(s));

    expect(result.prNumber).toBe(11);
    expect(s.finds).toEqual([]);
    expect(s.created).toEqual([]);
  });

  it("差分が無ければ PR を作らない", async () => {
    // 空の PR は通知にも検証にも使えない。
    const s = sink({ pushed: false });
    const result = await publish(target(), deps(s));

    expect(result.prNumber).toBeNull();
    expect(s.created).toEqual([]);
    expect(result.skipped).toContain("diff");
  });

  it("Run が無いティックでも push して PR を確保する", async () => {
    // ここは以前「Run が無いティックでは何もしない」を固定していた。その線を
    // 残すと、人間が commit した分（Run が付かない）は remote に永久に出ない。
    // 押す先は実装役の作業ツリーで、規則は worktreeNameFor が正になる
    // （理由は tests/publish-human-commit.test.ts）。
    const s = sink();
    const result = await publish(target({ run: null }), deps(s));

    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
    expect(result.prNumber).toBe(42);
    expect(result.created).toBe(true);
  });

  it("失敗した Run のティックでも commit 済みの差分は push する", async () => {
    // 途中で落ちた作業が PR に乗ることはない。push が送るのは commit 済みの差分
    // だけで、Actor の書きかけは worktree に残る（未 commit は controller の関門が
    // 見る）。前のティックまでに commit された分を止める理由が無い。
    const s = sink();
    const result = await publish(
      target({ run: { ...COMPLETED_RUN, status: "failed", exitCode: 1 } }),
      deps(s),
    );

    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
    expect(result.prNumber).toBe(42);
  });

  it("レビュー役の Run のティックでも、押すのは実装役の作業ツリー", async () => {
    // レビュー役の木には実装が無い。押す先を run.worktree に従わせると、
    // 実装役の commit は remote に出ないまま、レビュー役のブランチに
    // 2本目の PR が立つ。押す先は Goal と role だけから決まる。
    const s = sink();
    await publish(target({ run: REVIEW_RUN }), deps(s));

    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
  });

  it("PR を作れなくても throw しない", async () => {
    // 観測と判断は済んでいる。通知の失敗でティック全体を落とさない。
    const s = sink({ createFails: true });
    const result = await publish(target(), deps(s));

    expect(result.prNumber).toBeNull();
    expect(result.skipped).toContain("422");
  });

  it("push できなくても throw しない", async () => {
    const s = sink({ pushFails: true });
    const result = await publish(target(), deps(s));

    expect(result.skipped).toContain("push");
  });

  it("PR が既にあるなら、push が落ちてもコメントは書く", async () => {
    // push の機会を Actor の実行から外したので、ESCALATE(uncommitted_changes) の
    // ティック——人間が作業ツリーを手で触っている、まさに push が落ちやすい
    // 状態——でも push を試す。そこで降りると、止めた理由が PR に一度も出ない
    // まま WAITING_HUMAN になる。人間に届かない関門は鳴っていないのと同じ。
    const s = sink({ pushFails: true });
    const result = await publish(target({ prNumber: 42 }), deps(s));

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).toContain("Could not push");
  });

  it("観測が前のティックと同じでも、push が落ちたら書く", async () => {
    // 観測が変わらないまま push だけ落ち続ける状態を黙って飛ばすと、PR は
    // 静かなまま人間が待ち続ける。
    const s = sink({ pushFails: true });
    const result = await publish(
      target({ prNumber: 42, previousDigest: "same", digest: "same" }),
      deps(s),
    );

    expect(result.commented).toBe(true);
  });
});

describe("進捗を書く", () => {
  it("観測が変わっていればコメントする", async () => {
    const s = sink({ existing: 11 });
    const result = await publish(target(), deps(s));

    expect(result.commented).toBe(true);
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]?.prNumber).toBe(11);
  });

  it("観測が前のティックと同じなら書かない", async () => {
    // 同じ状態を毎ティック通知すると、人間が読むのをやめる。
    const s = sink({ existing: 11 });
    const result = await publish(target({ digest: "same", previousDigest: "same" }), deps(s));

    expect(result.commented).toBe(false);
    expect(s.comments).toEqual([]);
  });

  it("関門が止めたティックは、観測が同じでも必ず書く", async () => {
    // ダイジェストは Fact だけから作るので Decision を含まない。Actor が
    // worktree の外だけを書いたティックは、観測が1文字も変わらないまま
    // decision だけが ESCALATE に差し替わる。そこを飛ばすと、隔離が破れた
    // ことが PR に一度も出ないまま WAITING_HUMAN になる。
    const s = sink({ existing: 11 });
    const result = await publish(
      target({
        digest: "same",
        previousDigest: "same",
        // 関門が止めたティックでは PR を作らないので、既にある PR に書く。
        prNumber: 11,
        decision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ESCALATE", reason: "protected_path_touched" },
          rationale: "制御ループ自体に触れたので停止する",
          decidedBy: "guard",
        },
      }),
      deps(s),
    );

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).toContain("制御ループ自体に触れた");
    // 通知はするが push はしない。
    expect(s.pushes).toEqual([]);
  });

  it("loop_detected も、観測が同じでも必ず書く", async () => {
    // `loop_detected` はダイジェストが動かないことが発火条件そのものなので、
    // 「観測が前ティックと同じなら飛ばす」に必ず捕まる。飛ばすと、空回りで止めた
    // ティックが PR に一度も出ないまま WAITING_HUMAN になり、PR だけ見ている人間には
    // 止まった理由が届かない（design.md §4.3）。
    const s = sink({ existing: 11 });
    const result = await publish(
      target({
        digest: "same",
        previousDigest: "same",
        prNumber: 11,
        // criterion が参照する観測を読めていない状態が、rationale と criteria の
        // 両方に出る。
        verifications: [
          verification({
            result: "unresolved",
            reason: "pending",
            evidence: null,
            detail: "github.pr.unresolved_threads is not observed as a VERIFIED Fact",
          }),
        ],
        decision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ESCALATE", reason: "loop_detected" },
          rationale:
            "stopping: the observation stayed unchanged for 3/3 reconciles, yet these Gaps remain: " +
            "ac-1 [unknown] criteria.ac-1.passed has no conclusion " +
            "(pending: github.pr.unresolved_threads is not observed as a VERIFIED Fact)",
          decidedBy: "guard",
        },
      }),
      deps(s),
    );

    expect(result.commented).toBe(true);
    // 停止理由も、詰まっている criterion も PR から読める。
    expect(s.comments[0]?.body).toContain("loop_detected");
    expect(s.comments[0]?.body).toContain("github.pr.unresolved_threads is not observed");
  });

  it("同じガード停止が観測も変わらず続けば、2度目は書かない", async () => {
    // 恒久的に読めない観測で止まった Goal は WAITING_HUMAN のまま毎ティック
    // 再ティックされる。同じ停止理由の同じコメントを積み続けると、人間はかえって
    // 読まなくなる。停止の初回は出し、変化の無い繰り返しは畳む。
    const s = sink({ existing: 11 });
    const loop: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "ESCALATE", reason: "loop_detected" },
      rationale: "stopping: the observation stayed unchanged for 3/3 reconciles",
      decidedBy: "guard",
    };
    const result = await publish(
      target({
        digest: "same",
        previousDigest: "same",
        prNumber: 11,
        decision: loop,
        // 前ティックも同じ loop_detected だった。
        previousDecision: loop,
      }),
      deps(s),
    );

    expect(result.commented).toBe(false);
    expect(result.skipped).toContain("identical to the previous tick");
    expect(s.comments).toEqual([]);
  });

  it("ガード停止（protected_path_touched）も、同じ停止が続けば2度目は畳む", async () => {
    // 安全側の信号も、Goal が止まっている以上は停止そのものが危険を抑えている。
    // 同じ reason の同じコメントを積み増しても情報は増えないので、初回だけ出す。
    const s = sink({ existing: 11 });
    const guard: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "ESCALATE", reason: "protected_path_touched" },
      rationale: "制御ループ自体に触れたので停止する",
      decidedBy: "guard",
    };
    const result = await publish(
      target({
        digest: "same",
        previousDigest: "same",
        prNumber: 11,
        decision: guard,
        previousDecision: guard,
      }),
      deps(s),
    );

    expect(result.commented).toBe(false);
    expect(s.comments).toEqual([]);
  });

  it("停止に入ったティックは、前が別の行動なら観測が同じでも書く", async () => {
    // 隔離が破れた・空回りに落ちた「その瞬間」は、観測が前ティックと変わらなくても
    // 必ず PR に出す。畳むのは、同じ停止が続く2ティック目以降だけ。
    const s = sink({ existing: 11 });
    const result = await publish(
      target({
        digest: "same",
        previousDigest: "same",
        prNumber: 11,
        decision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ESCALATE", reason: "loop_detected" },
          rationale: "stopping: the observation stayed unchanged for 3/3 reconciles",
          decidedBy: "guard",
        },
        // 前ティックは実装役を動かしていた（別の行動）。
        previousDecision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ACT", intent: "fix the failing test" },
          rationale: "a Gap remained",
          decidedBy: "llm",
        },
      }),
      deps(s),
    );

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).toContain("loop_detected");
  });

  it("action と rationale と criteria の結果を載せる", async () => {
    const s = sink({ existing: 11 });
    await publish(target(), deps(s));
    const body = s.comments[0]?.body ?? "";

    expect(body).toContain("ACT");
    expect(body).toContain("Gap が 1 件ある");
    expect(body).toContain("ac-1");
    expect(body).toContain("failed");
    // GFM の表として描画されるにはヘッダ区切り行が要る。
    expect(body).toContain("|---|");
  });

  it("Run のトークンを載せる", async () => {
    // design.md §7。Claude Max 経由でも記録する。
    const s = sink({ existing: 11 });
    await publish(target(), deps(s));

    expect(s.comments[0]?.body).toContain("31397");
  });

  it("detail の改行と | を潰して表を壊さない", async () => {
    const s = sink({ existing: 11 });
    await publish(
      target({
        verifications: [verification({ detail: "1行目\n2行目 | 3列目" })],
      }),
      deps(s),
    );

    const row = (s.comments[0]?.body ?? "").split("\n").find((l) => l.includes("ac-1")) ?? "";
    expect(row).toContain("1行目 2行目 \\| 3列目");
  });

  it("コメントに失敗しても throw しない", async () => {
    const s = sink({ existing: 11, commentFails: true });
    const result = await publish(target(), deps(s));

    expect(result.prNumber).toBe(11);
    expect(result.commented).toBe(false);
    expect(result.skipped).toContain("403");
  });

  it("PR が無ければコメントしない", async () => {
    const s = sink({ pushed: false });
    const result = await publish(target(), deps(s));

    expect(s.comments).toEqual([]);
    expect(result.commented).toBe(false);
  });
});

describe("保護パスに触れたとき", () => {
  const blocked: Decision = {
    decidedAt: NOW.toISOString(),
    action: { type: "ESCALATE", reason: "protected_path_touched" },
    rationale: "制御ループ自体に触れたので停止する",
    decidedBy: "guard",
  };

  it("PR を作らない", async () => {
    // 立てると、保護パスへの変更が通常の変更として流れてしまう。
    const s = sink();
    const result = await publish(target({ decision: blocked }), deps(s));

    expect(s.created).toEqual([]);
    expect(s.pushes).toEqual([]);
    expect(result.skipped).toContain("protected path");
  });

  it("既に PR があればコメントで知らせる", async () => {
    // 人間を呼ぶ以上、何が起きたかは PR に残す。
    const s = sink();
    const result = await publish(target({ decision: blocked, prNumber: 11 }), deps(s));

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).toContain("protected_path_touched");
  });
});

describe("2ティック目以降の push", () => {
  it("PR があっても push する", async () => {
    // ここで止めていたせいで、自己ホストで回したとき2ティック目以降の
    // Actor の commit が remote に届かず、PR は1ティック目の内容のまま止まった。
    const s = sink();
    const result = await publish(target({ prNumber: 11 }), deps(s));

    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
    expect(result.prNumber).toBe(11);
    // 既にあるので作らない。探しにも行かない。
    expect(s.created).toEqual([]);
    expect(s.finds).toEqual([]);
  });

  it("差分が無ければ PR があっても何も送らない", async () => {
    const s = sink({ pushed: false });
    const result = await publish(target({ prNumber: 11 }), deps(s));

    expect(result.prNumber).toBe(11);
    expect(s.created).toEqual([]);
  });

  it("保護パスに触れていたら push もしない", async () => {
    // remote に出た時点で、通常の変更として流れる余地が生まれる。
    const s = sink();
    const blocked: Decision = {
      decidedAt: NOW.toISOString(),
      action: { type: "ESCALATE", reason: "protected_path_touched" },
      rationale: "制御ループ自体に触れた",
      decidedBy: "guard",
    };
    await publish(target({ prNumber: 11, decision: blocked }), deps(s));

    expect(s.pushes).toEqual([]);
  });
});

/**
 * 進捗の宛先を PR の外に移す（`ent run <slug> --report`）。
 *
 * criteria の pass 状況が毎ティック PR に積まれると困る場面がある。試走のたびに
 * レビュー中の PR が伸びる、公開リポジトリで手元の検証結果を出したくない、
 * そもそも GITHUB_TOKEN が無い、など。宛先を変えるだけで、観測も判断も変えない。
 *
 * 満たすべき性質:
 * - 宛先を移したら PR には投稿しない。両方に出すと「投稿しない」を満たさない
 * - **PR を確保できるかどうかと切り離す。** 進捗を PR の外に書く動機の多くは
 *   「PR がまだ無い」「トークンが無い」側にある。PR を確保できたときにしか
 *   書けないなら、この口は要るときに使えない
 * - push と PR の作成は止めない。移すのは通知の宛先だけで、Actor の成果を
 *   remote に出す経路には触れない
 * - 本文は PR コメントと同じものにする。宛先で内容が変わると、PR で読んだ人と
 *   ファイルで読んだ人が別のものを見る
 * - 書けなくても throw しない。既存の通知と同じく、失敗は結果に載せて返す
 */
describe("進捗を PR の外に書く", () => {
  it("PR にはコメントせず、宛先の方に書く", async () => {
    const s = sink({ existing: 11 });
    const r = recorder();
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(s.comments).toEqual([]);
    expect(result.commented).toBe(false);
    expect(r.written).toHaveLength(1);
    expect(result.report).toEqual({ destination: "file", written: true, error: null });
  });

  it("本文は PR コメントと同じ", async () => {
    // 宛先で内容が変わると、PR で読んだ人とファイルで読んだ人が別のものを見る。
    const onPr = sink({ existing: 11 });
    await publish(target(), deps(onPr));

    const s = sink({ existing: 11 });
    const r = recorder();
    await publish(target(), { ...deps(s), report: r.sink });

    expect(r.written[0]).toBe(onPr.comments[0]?.body);
  });

  it("PR がまだ無くても書く", async () => {
    // 差分が無ければ PR は作らない（空の PR は使えない）。それでも criteria の
    // pass 状況は読めないと、この口を使う意味が無い。
    const s = sink({ pushed: false });
    const r = recorder();
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(result.prNumber).toBeNull();
    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toContain("ac-1");
  });

  it("PR を作れなくても書く", async () => {
    // GITHUB_TOKEN が無いときの経路。Port は呼ばれた時点で throw する。
    const s = sink({ createFails: true });
    const r = recorder();
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(r.written).toHaveLength(1);
    expect(result.report?.written).toBe(true);
  });

  it("保護パスの関門で止まったティックでも書く", async () => {
    // 人間を呼ぶ以上、何が起きたかは必ずどこかに残す。PR には出さないので、
    // ここで落とすと関門が鳴ったことがどこにも出ない。
    const s = sink();
    const r = recorder();
    await publish(
      target({
        decision: {
          decidedAt: NOW.toISOString(),
          action: { type: "ESCALATE", reason: "protected_path_touched" },
          rationale: "制御ループ自体に触れたので停止する",
          decidedBy: "guard",
        },
      }),
      { ...deps(s), report: r.sink },
    );

    expect(r.written[0]).toContain("protected_path_touched");
    // 関門の扱いは変えない。push も PR の作成も止まったままにする。
    expect(s.pushes).toEqual([]);
    expect(s.created).toEqual([]);
  });

  it("観測が前のティックと同じでも書く", async () => {
    // PR コメントを飛ばすのは「同じ通知が積まれると読まれなくなる」ため。
    // 1回叩いて1回出す宛先では、黙って何も出さない方が読めない。
    const s = sink({ existing: 11 });
    const r = recorder();
    await publish(target({ digest: "same", previousDigest: "same" }), {
      ...deps(s),
      report: r.sink,
    });

    expect(r.written).toHaveLength(1);
    expect(s.comments).toEqual([]);
  });

  it("push と PR の作成は止めない", async () => {
    // 移すのは通知の宛先だけ。Actor の成果を remote に出す経路には触れない。
    const s = sink();
    const r = recorder();
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(s.pushes).toEqual([{ name: "sample-goal", base: "main" }]);
    expect(result.prNumber).toBe(42);
    expect(result.created).toBe(true);
  });

  it("書けなくても throw せず、理由を返す", async () => {
    const s = sink({ existing: 11 });
    const r = recorder({ fails: true });
    const result = await publish(target(), { ...deps(s), report: r.sink });

    expect(result.report?.written).toBe(false);
    expect(result.report?.error).toContain("EACCES");
    // 書けなかったからといって PR に流し直さない。投稿しないと言われている。
    expect(s.comments).toEqual([]);
  });

  it("指定が無ければ従来どおり PR に投稿する", async () => {
    const s = sink({ existing: 11 });
    const result = await publish(target(), deps(s));

    expect(result.report).toBeNull();
    expect(s.comments).toHaveLength(1);
  });
});
