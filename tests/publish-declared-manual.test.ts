import { describe, expect, it } from "vitest";
import type { Decision } from "../src/domain/action.js";
import { type Goal, type PublishPolicy, publishPolicyOf } from "../src/domain/goal.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import type { Verification } from "../src/domain/verification.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type PublishTarget,
  type PullRequestDraft,
  publish,
} from "../src/publish/index.js";

/**
 * controller 自身の publish を、宣言で止める（issue #60）。
 *
 * `policies.require_human_approval` に書いたゲートは Actor に渡す拒否ツールにしか
 * ならない。push と PR 作成を行っているのは controller の publish で、そちらは
 * ゲートを1つも通らなかった。「PR を勝手に立てるな」を宣言する口が無い状態で、
 * 人間が確認しようとした時点では既に PR が立ち、レビュアーへの通知も飛んでいた。
 *
 * ここで固定するのは3つ。
 *
 * - **宣言が無ければ何も変わらない。** 既存の `.goals/*.yaml` は1本も挙動が変わらない
 * - 宣言した段は controller が行わない。`push_branch` と `open_pull_request` は別々に書ける
 * - 止めたことを結果に載せる。黙って何もしないのは、押せなかったのと区別がつかない
 *
 * テストから実際の GitHub を叩かない。git push もしない。どちらも Port で注入する。
 */

const NOW = new Date("2026-08-12T06:00:00.000Z");

function goalWith(policy?: PublishPolicy): Goal {
  return {
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
    policies: {
      require_human_approval: ["merge"],
      protected_paths: [],
      ...(policy === undefined ? {} : { publish: policy }),
    },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 3,
    },
  };
}

const DECISION: Decision = {
  decidedAt: NOW.toISOString(),
  action: { type: "ACT", intent: "テストの失敗を直す" },
  rationale: "Gap が 1 件ある",
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
  created: PullRequestDraft[];
  comments: { prNumber: number; body: string }[];
  pushes: { name: string; base: string }[];
}

function sink(over: { existing?: number | null } = {}): Sink {
  const created: PullRequestDraft[] = [];
  const comments: { prNumber: number; body: string }[] = [];
  const pushes: { name: string; base: string }[] = [];

  return {
    created,
    comments,
    pushes,
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
      push: async (name, base) => {
        pushes.push({ name, base });
        return { branch: `entelecheia/${name}`, pushed: true };
      },
    },
  };
}

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    goal: goalWith(),
    run: null,
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

/** 最小構成の Goal YAML。`policies.publish` を書いていない側 */
const MINIMAL = `
version: 1
goal:
  id: sample-goal
  name: サンプル
  desired_state: |
    何かが完成している。
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
acceptance_criteria:
  - id: ac-1
    description: テストが通る
    verification: { type: command, run: mise run test }
context:
  background: |
    背景。
  constraints:
    - 何かをしない
policies:
  require_human_approval: [merge]
budget:
  max_actor_runs: 10
  max_reconciles: 20
  max_wall_clock: 2h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

/** MINIMAL の policies に publish の宣言を差し込む */
function withPublish(line: string): string {
  return MINIMAL.replace("  require_human_approval: [merge]", `  publish:\n${line}`);
}

describe("宣言が無ければ、これまでどおり publish する", () => {
  it("push も PR 作成も止めない", async () => {
    const s = sink();

    const result = await publish(target(), deps(s));

    expect(s.pushes).toHaveLength(1);
    expect(s.created).toHaveLength(1);
    expect(result.created).toBe(true);
    expect(result.held).toBeNull();
  });

  it("スキーマは宣言を要求しない。既定はどちらも auto", () => {
    // 既存の .goals/*.yaml は publish を1本も書いていない。既定を manual に
    // 倒すと、回っている Goal が全部止まる。
    const goal = parseGoal(MINIMAL, "sample-goal");

    expect(goal.policies.publish).toBeUndefined();
    expect(publishPolicyOf(goal)).toEqual({ push_branch: "auto", open_pull_request: "auto" });
  });

  it("片方だけ書けば、もう片方は auto のまま", () => {
    const goal = parseGoal(withPublish("    open_pull_request: manual"), "sample-goal");

    expect(publishPolicyOf(goal)).toEqual({
      push_branch: "auto",
      open_pull_request: "manual",
    });
  });

  it("auto と manual 以外は書けない", () => {
    // 自由文字列にすると、`yes` や `human` のような書き間違いが「宣言した」と
    // 読まれずに素通りする。止めたつもりの宣言が効かないのが一番悪い。
    expect(() => parseGoal(withPublish("    push_branch: ask-me"), "sample-goal")).toThrow();
  });

  it("知らないキーは弾く", () => {
    // 段を書き間違えた宣言（`create: manual` など）を黙って捨てない。
    expect(() => parseGoal(withPublish("    merge: manual"), "sample-goal")).toThrow();
  });
});

describe("push_branch: manual", () => {
  it("push しない。PR も作らない", async () => {
    // push を止めた以上、その先の PR 作成も成立しない。
    const s = sink();

    const result = await publish(
      target({ goal: goalWith({ push_branch: "manual", open_pull_request: "auto" }) }),
      deps(s),
    );

    expect(s.pushes).toEqual([]);
    expect(s.created).toEqual([]);
    expect(result.created).toBe(false);
  });

  it("止めた段を結果に載せる", async () => {
    const s = sink();

    const result = await publish(
      target({ goal: goalWith({ push_branch: "manual", open_pull_request: "auto" }) }),
      deps(s),
    );

    expect(result.held?.step).toBe("push_branch");
    expect(result.skipped).toContain("push_branch");
  });

  it("PR が既にあるティックは、観測が変わっていなくても必ずコメントする", async () => {
    // 止まっているあいだ観測は1文字も変わらない。初回しか書かないと、PR が
    // 静かなまま人間が待ち続ける。人間に届かない関門は鳴っていないのと同じ。
    const s = sink();

    const result = await publish(
      target({
        goal: goalWith({ push_branch: "manual", open_pull_request: "auto" }),
        prNumber: 7,
        previousDigest: "digest-2",
      }),
      deps(s),
    );

    expect(result.commented).toBe(true);
    expect(s.comments[0]?.body).toContain("push_branch");
  });
});

describe("止めたことを PR の側から読める", () => {
  /** PR コメントに載る `> [!NOTE]` の中身。引用記号を外して返す */
  async function noteOf(policy: PublishPolicy): Promise<string> {
    const s = sink();
    await publish(target({ goal: goalWith(policy), prNumber: 7, previousDigest: "digest-2" }), {
      ...deps(s),
    });
    const body = s.comments[0]?.body ?? "";
    const lines = body.split("\n");
    const start = lines.indexOf("> [!NOTE]");
    if (start === -1) {
      return "";
    }
    const note: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("> ")) {
        break;
      }
      note.push(line.slice(2));
    }
    return note.join("\n");
  }

  it("push を止めたことに、手で押しても解けないことまで書く", async () => {
    // rationale（`publishHeldDecision`）は publish の**後ろ**で組み立てるので、
    // PR コメントに載るのは差し替え前の文面になる。止めた事情が PR に出るのは
    // この NOTE の分だけで、「push していない」しか書かないと、人間が最も要る
    // 2つ——手で押しても解けないことと、終端にする口があること——が PR から読めない。
    const note = await noteOf({ push_branch: "manual", open_pull_request: "auto" });

    expect(note).toContain("policies.publish.push_branch");
    expect(note).toContain("手で push しても");
    expect(note).toContain("auto");
    expect(note).toContain("ent abandon");
  });

  it("PR を止めたほうは、そもそも PR が無いので何も書けない", async () => {
    // `open_pull_request` で止まるのは「差分があり、まだ PR が無い」ティックだけに
    // なる（既にあるティックは止めない）。書く先が1本も無いので、この段の停止は
    // PR の側から読めない。**読むのは `ent get` と `publishHold` になる。**
    // ここを「PR コメントにも出る」と書くと、無い PR を探させることになる。
    const s = sink();

    const result = await publish(
      target({ goal: goalWith({ push_branch: "auto", open_pull_request: "manual" }) }),
      deps(s),
    );

    expect(result.held?.step).toBe("open_pull_request");
    expect(result.commented).toBe(false);
    expect(s.comments).toEqual([]);
  });

  it("NOTE を何行に増やしても、独立した1行を本文に作らない", async () => {
    // 承認の定型文は行全体で照合される（`approves`）。引用記号の付かない行を
    // 作ると、そこに `/ent approve <criterion-id>` が並んだときに承認として
    // 数えられる。増やす先は必ず `> ` の内側に留める。
    const s = sink();
    await publish(
      target({
        goal: goalWith({ push_branch: "manual", open_pull_request: "auto" }),
        prNumber: 7,
        previousDigest: "digest-2",
      }),
      deps(s),
    );
    const lines = (s.comments[0]?.body ?? "").split("\n");
    const start = lines.indexOf("> [!NOTE]");

    expect(start).toBeGreaterThan(-1);
    // NOTE の直後の行は、空行になるまで全部引用のままであること。
    const after = lines.slice(start + 1);
    const end = after.indexOf("");
    expect(end).toBeGreaterThan(0);
    for (const line of after.slice(0, end)) {
      expect(line.startsWith("> ")).toBe(true);
    }
    expect(lines.some((line) => line.trim().startsWith("/ent approve"))).toBe(false);
  });
});

describe("open_pull_request: manual", () => {
  it("push はするが、PR は作らない", async () => {
    // ブランチが remote にあること自体は通知を伴わない。止めたいのは
    // レビュアーに通知が飛ぶ側だけ、という宣言ができる。
    const s = sink();

    const result = await publish(
      target({ goal: goalWith({ push_branch: "auto", open_pull_request: "manual" }) }),
      deps(s),
    );

    expect(s.pushes).toHaveLength(1);
    expect(s.created).toEqual([]);
    expect(result.prNumber).toBeNull();
    expect(result.held?.step).toBe("open_pull_request");
    expect(result.skipped).toContain("open_pull_request");
  });

  it("人間が立てた PR を見つけたら、そのまま進む", async () => {
    // 止めるのは「作る」ことだけになる。人間が立てた PR を次のティックが拾って
    // 進めるので、宣言を書き換えなくても手で承認したのと同じ形で先へ行ける。
    const s = sink({ existing: 42 });

    const result = await publish(
      target({ goal: goalWith({ push_branch: "auto", open_pull_request: "manual" }) }),
      deps(s),
    );

    expect(result.prNumber).toBe(42);
    expect(result.held).toBeNull();
    expect(s.created).toEqual([]);
  });

  it("PR が既にあるティックは止めない", async () => {
    // 作る段ではない。既にある PR への進捗コメントまで止めると、宣言した Goal は
    // 何も報告しなくなる。
    const s = sink();

    const result = await publish(
      target({
        goal: goalWith({ push_branch: "auto", open_pull_request: "manual" }),
        prNumber: 7,
      }),
      deps(s),
    );

    expect(result.held).toBeNull();
    expect(result.commented).toBe(true);
  });
});
