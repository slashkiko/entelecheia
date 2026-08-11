import { describe, expect, it } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import { type AgentQuery, claudeActor } from "../src/adapters/claude.js";
import { observedFactKeySchema } from "../src/domain/fact-keys.js";
import { goalSchema } from "../src/domain/goal.js";

/**
 * レビュー役の Agent が、実際にレビューを行える状態にあること。
 *
 * design.md §4.2 は `ActorRole = 'implement' | 'review' | 'investigate'` を
 * 宣言しているが、`src/` には role という語が1つも無い。いま起動できる Actor は
 * 1種類で、実装用のツール（Edit / Write / NotebookEdit）をそのまま持っている。
 * この状態で「レビューして」という intent を渡しても、それは実装役に読み方だけ
 * 変えるよう頼んでいるのと同じで、Agent が従わなければ実装を書き換えられる。
 * 指示ではなく権限で分ける。
 *
 * ここで固定するのは3つ。
 *
 * 1. review の Actor は読めるが書けないこと。読み取りのツールは持ち、
 *    編集のツールは持たない
 * 2. implement 側の権限が、この変更で弱まっていないこと。役割を足すついでに
 *    実装役の拒否リストが緩んでいれば、隔離そのものが後退する
 * 3. レビューの結論が観測キーとして残り、Goal YAML の
 *    `verification: { type: fact, key: review.verdict, equals: approved }`
 *    から参照できること
 *
 * 3 が要点になる。レビューの結論が Fact にならなければ、controller から見て
 * 「レビューを回した」と「レビューが通った」の区別が付かない。Fact になれば、
 * あとは既存の機構がそのまま働く。VERIFIED な Fact だけが完了判定に使われ
 * （design.md §3.1）、approved でない限り Gap が残るので COMPLETE には届かない。
 * guard に「レビューを通れ」という条件を足す必要は無い。
 *
 * **どの Port がその Fact を作るかは、ここでは固定しない。** レビュー役の Run の
 * 結果から作るのが素直だが、それは実装が決めてよい。ただし捏造しないこと——
 * レビューを回していないティックで approved を作らない。確かめられなければ
 * Fact を作らず unobserved に残す（design.md §3.1）。
 *
 * `review.verdict` は `src/domain/fact-keys.ts` への追加になる。あのレジストリは
 * 「変更が必要なら実装前に合意を取る」ものなので、追加そのものが本 Goal の
 * 合意事項にあたる。
 */

interface Recorded {
  query: AgentQuery;
  prompts: string[];
  options: { allowedTools?: string[]; disallowedTools?: string[]; cwd?: string }[];
}

function recorded(): Recorded {
  const prompts: string[] = [];
  const options: { allowedTools?: string[]; disallowedTools?: string[]; cwd?: string }[] = [];

  return {
    prompts,
    options,
    query: (params) => {
      prompts.push(params.prompt);
      options.push(
        (params.options ?? {}) as {
          allowedTools?: string[];
          disallowedTools?: string[];
          cwd?: string;
        },
      );
      return (async function* () {
        yield SUCCESS;
      })();
    },
  };
}

function deps(sink: Recorded) {
  return {
    query: sink.query,
    runsDir: "/tmp/entelecheia/runs",
    writeLog: async () => {},
  };
}

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "読みました",
  num_turns: 3,
  total_cost_usd: 0.12,
  usage: { input_tokens: 1200, output_tokens: 340 },
};

function invocation(over: Partial<ActorInvocation> = {}): ActorInvocation {
  return {
    runId: "42",
    goalId: "sample",
    intent: "実装をレビューする",
    role: "implement",
    worktree: { path: "/tmp/entelecheia/worktrees/sample", branch: "entelecheia/sample" },
    deniedOperations: ["merge", "force_push"],
    signal: new AbortController().signal,
    ...over,
  };
}

/** 実装役だけが持ってよいツール */
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

describe("review の Actor", () => {
  it("編集のツールを1つも持たない", async () => {
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    const allowed = sink.options[0]?.allowedTools ?? [];
    for (const tool of EDIT_TOOLS) {
      expect(allowed).not.toContain(tool);
    }
  });

  it("編集のツールを拒否リストにも入れる", async () => {
    // allowedTools から外すだけでは、設定の読み込み順や既定値が変わったときに
    // 素通りしうる。拒否ルールは許可ルールより先に評価されるので、
    // 二重にしておく（実装役の deniedOperations と同じ扱い）。
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    for (const tool of EDIT_TOOLS) {
      expect(disallowed).toContain(tool);
    }
  });

  it("作業ツリーを消す git を拒否リストに入れる", async () => {
    // レビュー役は実装役と同じ作業ツリーを見る（worktreeNameFor）。編集のツールを
    // 外しても Bash は残るので、`git checkout .` の1行で実装側の未 commit の
    // 差分を消せる。分けないぶん、この経路だけは拒否リストで塞ぐ。
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    for (const tool of ["checkout", "restore", "clean", "reset", "stash"]) {
      expect(disallowed.some((denied) => denied.startsWith(`Bash(git ${tool}`))).toBe(true);
    }
  });

  it("読むためのツールは持つ", async () => {
    // 読めなければレビューにならない。Bash はテストの実行に要るので残す。
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    const allowed = sink.options[0]?.allowedTools ?? [];
    expect(allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
  });

  it("deniedOperations は role によらずそのまま効く", async () => {
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    expect(disallowed.some((tool) => tool.includes("merge"))).toBe(true);
  });

  it("渡された worktree を cwd にする", async () => {
    // レビュー役は自分の作業ツリーで読む。実装役の作業ツリーを直接触らせない
    // （tests/worktree-roles.test.ts が名前を分けている）。
    const sink = recorded();
    await claudeActor(deps(sink)).run(
      invocation({ role: "review", worktree: { path: "/tmp/wt/review", branch: "b" } }),
    );

    expect(sink.options[0]?.cwd).toBe("/tmp/wt/review");
  });

  it("実装役とは別のプロンプトで起動する", async () => {
    // 同じ intent でも、読む側と書く側では求めるものが違う。
    // 権限だけ分けてプロンプトが同じだと、レビュー役は編集を試みて失敗し続ける。
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "implement" }));
    await claudeActor(deps(sink)).run(invocation({ role: "review" }));

    expect(sink.prompts[1]).not.toBe(sink.prompts[0]);
  });
});

describe("implement の Actor（弱めない）", () => {
  it("編集のツールを持ったままにする", async () => {
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "implement" }));

    const allowed = sink.options[0]?.allowedTools ?? [];
    expect(allowed).toEqual(expect.arrayContaining([...EDIT_TOOLS, "Read", "Bash"]));
  });

  it("編集のツールを拒否リストに入れない", async () => {
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "implement" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    for (const tool of EDIT_TOOLS) {
      expect(disallowed).not.toContain(tool);
    }
  });

  it("常に拒否する操作は残ったままにする", async () => {
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "implement" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    expect(disallowed.some((tool) => tool.startsWith("Bash(git worktree"))).toBe(true);
  });

  it("作業ツリーを消す git は拒否しない", async () => {
    // 実装役は自分の作業ツリーを持つ。やり直しのために checkout も reset も要る。
    // 塞ぐのは、他人の作業ツリーを読むだけの役割に限る。
    const sink = recorded();
    await claudeActor(deps(sink)).run(invocation({ role: "implement" }));

    const disallowed = sink.options[0]?.disallowedTools ?? [];
    expect(disallowed.some((tool) => tool.startsWith("Bash(git checkout"))).toBe(false);
  });
});

describe("レビューの結論を Fact にする", () => {
  it("review.verdict が観測キーとして登録されている", () => {
    expect(observedFactKeySchema.safeParse("review.verdict").success).toBe(true);
  });

  it("Goal YAML の criteria から review.verdict を参照できる", () => {
    const goal = {
      version: 1,
      goal: { id: "g", name: "n", desired_state: "d" },
      repository: { provider: "github", owner: "o", name: "r", default_branch: "main" },
      setup: [],
      acceptance_criteria: [
        {
          id: "ac-1",
          description: "レビューが通っている",
          verification: { type: "fact", key: "review.verdict", equals: "approved" },
        },
      ],
      context: { background: "b", constraints: [], references: [] },
      policies: { require_human_approval: ["merge"], protected_paths: [] },
      budget: {
        max_actor_runs: 10,
        max_reconciles: 20,
        max_wall_clock: "2h",
        max_consecutive_failures: 3,
        max_unchanged_reconciles: 3,
      },
    };

    expect(goalSchema.safeParse(goal).success).toBe(true);
  });

  it("どの commit を読んだかも観測キーとして残る", () => {
    // 「通った」だけでは、いつの時点のコードのレビューか分からない。
    // 実装が進んだあとの Fact を、そのまま完了判定に使わせない。
    expect(observedFactKeySchema.safeParse("review.reviewed_sha").success).toBe(true);
  });
});
