import { describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import type { Goal } from "../src/domain/goal.js";
import type { Run } from "../src/domain/run.js";
import type { Verification } from "../src/domain/verification.js";
import {
  type BranchPort,
  type CodeWriterPort,
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
  goal: { id: "sample-goal", name: "サンプルを完成させる", desired_state: "何かが完成している" },
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
    expect(result.skipped).toContain("差分");
  });

  it("Run が無いティックでは何もしない", async () => {
    const s = sink();
    const result = await publish(target({ run: null }), deps(s));

    expect(s.pushes).toEqual([]);
    expect(result.skipped).toContain("Run");
  });

  it("失敗した Run では push しない", async () => {
    // 途中で落ちた作業を PR にすると、通知が実態とずれる。
    const s = sink();
    const result = await publish(
      target({ run: { ...COMPLETED_RUN, status: "failed", exitCode: 1 } }),
      deps(s),
    );

    expect(s.pushes).toEqual([]);
    expect(result.prNumber).toBeNull();
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
    expect(result.skipped).toContain("保護パス");
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
