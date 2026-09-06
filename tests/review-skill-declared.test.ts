import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActDeps,
  type ActorInvocation,
  type ActorPort,
  act,
  type RunRecorderPort,
  type WorktreePort,
} from "../src/act/index.js";
import { PROMPT_FOR } from "../src/adapters/agent-prompt.js";
import { type AgentQuery, claudeActor } from "../src/adapters/claude.js";
import { goalSchema } from "../src/domain/goal.js";
import { parseGoalConfig } from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import { renderGoal } from "../src/domain/goal-render.js";
import { findViolations } from "../src/domain/protected-paths.js";

/**
 * レビュー役に渡す skill を宣言から選ぶ（`policies.review_skill`）。
 *
 * 観点はリポジトリの性質で決まるので、Go の DDD 規約を見たいリポジトリと
 * React のアクセシビリティを見たいリポジトリに同じ1件を配る形をやめる。
 * 成立に要るのは4つで、どれが欠けても「差し替えられる」とは言えない。
 *
 * 1. **宣言が届くこと。** Goal でも `.goals/config.yaml` でも名指しでき、
 *    書かなければ同梱の `semantic-review` のままになる
 * 2. **名指しした本文が守られること。** リポジトリの中を指せる以上、実装役が
 *    観点を書き換えられる。plugin ディレクトリを保護パスに足して塞ぐ
 * 3. **`references/` を持たない skill でも渡ること。** 同梱のものは持っているが、
 *    任意の skill を許した時点で持たないものが来る
 * 4. **契約が provider によらず1つのままであること。** 渡し方（Skill ツール／
 *    本文の差し込み）だけが分かれ、`reviewed_sha:` と `verdict:` は両方に出る
 */

/** 宣言部の最小形。`policies` の中身だけを差し替えて使う */
function goalYaml(policies: string): string {
  return `version: 1

goal:
  id: sample
  name: sample
  desired_state: |
    something
  depends_on: []

repository:
  provider: github
  owner: acme
  name: repo
  default_branch: main

setup: []

acceptance_criteria:
  - id: ac-1
    description: something checkable
    verification:
      type: command
      run: "true"

context:
  background: |
    why
  constraints: []
  references: []

policies:
${policies}

budget:
  max_actor_runs: 8
  max_reconciles: 20
  max_wall_clock: 3h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 4
`;
}

const DECLARED = "plugins/repo-review/skills/go-ddd-review";

/**
 * 作業ツリーに見立てたディレクトリ。名指しした skill をここに置く。
 *
 * `reviewSkillOf` は `worktree.path` を基点にファイルの実在を見るので、
 * 文字列だけの fixture では通らない。
 */
let worktree: string;

beforeAll(() => {
  worktree = mkdtempSync(join(tmpdir(), "ent-review-skill-"));
  const skill = join(worktree, DECLARED);
  mkdirSync(join(skill, "references"), { recursive: true });
  const manifest = join(worktree, "plugins/repo-review/.claude-plugin");
  mkdirSync(manifest, { recursive: true });
  writeFileSync(join(manifest, "plugin.json"), '{ "name": "repo-review", "version": "0.1.0" }\n');
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: go-ddd-review\n---\n\nCheck the aggregates.\n",
  );
  writeFileSync(join(skill, "references", "layers.md"), "Domain must not import infrastructure.\n");
  // `references/` を持たない skill。素の readdirSync だと ENOENT で落ちる形。
  const bare = join(worktree, "plugins/repo-review/skills/bare-review");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "SKILL.md"), "---\nname: bare-review\n---\n\nRead the diff.\n");
});

function invocation(over: Partial<ActorInvocation> = {}): ActorInvocation {
  return {
    runId: "42",
    goalId: "sample",
    intent: "実装をレビューする",
    role: "review",
    worktree: { path: worktree, branch: "entelecheia/sample" },
    deniedOperations: ["merge"],
    signal: new AbortController().signal,
    ...over,
  };
}

describe("宣言から skill を名指しする", () => {
  it("Goal が書けば、その skill を読ませる", () => {
    const goal = parseGoal(goalYaml(`  review_skill: ${DECLARED}`), "sample");

    expect(goal.policies.review_skill).toBe(DECLARED);
  });

  it("書かなければ、同梱の semantic-review のまま", () => {
    const goal = parseGoal(goalYaml("  protected_paths: []"), "sample");

    expect(goal.policies.review_skill).toBeUndefined();
    expect(PROMPT_FOR.review(invocation(), "tool")).toContain("`semantic-review` skill");
  });

  it("書かない宣言の protected_paths は、これまでと1つも変わらない", () => {
    // 「既存の宣言を1文字も書き換えずに済む」は、ここが一致することで言える。
    // 導出を無条件に足すと、書いていない Goal の保護範囲まで黙って広がる。
    const before = goalSchema.parse({
      version: 1,
      goal: { id: "sample", name: "sample", desired_state: "x" },
      repository: { provider: "github", owner: "acme", name: "repo", default_branch: "main" },
      acceptance_criteria: [
        { id: "ac-1", description: "d", verification: { type: "command", run: "true" } },
      ],
      context: { background: "b", constraints: [], references: [] },
      policies: { protected_paths: ["docs/**"] },
      budget: {
        max_actor_runs: 8,
        max_reconciles: 20,
        max_wall_clock: "3h",
        max_consecutive_failures: 3,
        max_unchanged_reconciles: 4,
      },
    });

    expect(before.policies.protected_paths[0]).toBe("docs/**");
    expect(before.policies.protected_paths).not.toContain(`${DECLARED}/**`);
  });

  it("往復しても宣言が落ちない", () => {
    const goal = parseGoal(goalYaml(`  review_skill: ${DECLARED}`), "sample");

    expect(parseGoal(renderGoal(goal), "sample")).toEqual(goal);
  });
});

describe("置き場所は <plugin>/skills/<name> に限る", () => {
  const rejected = [
    "/abs/skills/x",
    "../escape/skills/x",
    "plugins/no-skills-segment",
    // plugin ディレクトリが空になる形。glob が作業ツリー全体か何も指さないかになる。
    "skills/x",
    // `path.join` が畳む形。通すと保護パスの glob と読みに行く先がずれる。
    "./skills/x",
    "plugins/./rev/skills/x",
    "plugins/rev/./skills/x",
    "a//skills/x",
    "plugins/../rev/skills/x",
    // 区切りはスラッシュだけ。バックスラッシュは畳まれ方が OS で変わる。
    "plugins\\rev/skills/x",
  ];

  it.each(rejected)("%s は受け付けない", (path) => {
    expect(() => parseGoal(goalYaml(`  review_skill: ${path}`), "sample")).toThrow();
  });

  it("Claude が plugin を読む形（.claude-plugin/plugin.json）に合わせてある", () => {
    // 好きなパスを書ける形にしても、この並びでなければ Claude 側には届かない。
    // 書ける形と実際に届く形を揃えておく。
    expect(() => parseGoal(goalYaml(`  review_skill: ${DECLARED}`), "sample")).not.toThrow();
  });
});

describe("リポジトリ全体の宣言から継承する", () => {
  const config = parseGoalConfig(`version: 1\npolicies:\n  review_skill: ${DECLARED}\n`);

  it("config が書けば、Goal は書かなくても届く", () => {
    const goal = parseGoal(goalYaml("  protected_paths: []"), "sample", config);

    expect(goal.policies.review_skill).toBe(DECLARED);
  });

  it("Goal が書けば Goal が勝つ", () => {
    // 観点は1件しか渡せないので、`protected_paths` のように足し合わせられない。
    const other = "plugins/repo-review/skills/bare-review";
    const goal = parseGoal(goalYaml(`  review_skill: ${other}`), "sample", config);

    expect(goal.policies.review_skill).toBe(other);
  });
});

describe("名指しした skill を実装役から守る", () => {
  const goal = parseGoal(goalYaml(`  review_skill: ${DECLARED}`), "sample");

  it("plugin ディレクトリが保護パスに入る", () => {
    // skill のディレクトリだけでは足りない。`.claude-plugin/` の manifest は
    // skill の解決に参加しているので、そこを書き換えれば名前ごと消せる。
    expect(goal.policies.protected_paths).toContain("plugins/repo-review/**");
  });

  it("観点の本文を編集すると関門に掛かる", () => {
    const violations = findViolations(
      [join(worktree, DECLARED, "SKILL.md")],
      worktree,
      goal.policies.protected_paths,
    );

    expect(violations).toEqual([
      {
        kind: "protected_path",
        path: join(worktree, DECLARED, "SKILL.md"),
        pattern: "plugins/repo-review/**",
      },
    ]);
  });

  it("manifest を編集しても関門に掛かる", () => {
    const manifest = join(worktree, "plugins/repo-review/.claude-plugin/plugin.json");
    const violations = findViolations([manifest], worktree, goal.policies.protected_paths);

    expect(violations.map((violation) => violation.kind)).toEqual(["protected_path"]);
  });
});

describe("宣言が Actor まで届く", () => {
  /**
   * **ここだけが `policies.review_skill` から `ActorInvocation.reviewSkill` への
   * 実配線を通す。** 他のテストは `invocation()` で ActorInvocation を手で組むので、
   * `src/act/index.ts` がその値を載せ忘れても1つも落ちない。載せ忘れると、宣言した
   * Goal が黙って同梱の skill でレビューされ、外からは正常なレビューに見える。
   *
   * 既に同じ形で守られている隣（`pullRequest`、tests/review-pr-text.test.ts）と
   * 揃えてある。
   */
  async function invocationFromGoal(policies: string): Promise<ActorInvocation> {
    const seen: ActorInvocation[] = [];
    const actor: ActorPort = {
      kind: "claude-code",
      run: async (invocation) => {
        seen.push(invocation);
        return { exitCode: 0, logRef: "log", tokens: 1, artifacts: [] };
      },
    };
    const worktreePort: WorktreePort = {
      ensure: async (name) => ({ path: worktree, branch: `entelecheia/${name}` }),
      commit: async () => true,
      changedPaths: async () => [],
      repoDirtyState: async () => new Map(),
    };
    const runs: RunRecorderPort = { start: async () => "run-1", finish: async () => {} };
    const deps: ActDeps = {
      worktree: worktreePort,
      actor,
      runs,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
    };
    await act(
      {
        goal: parseGoal(goalYaml(policies), "sample"),
        decision: {
          decidedAt: "2026-09-07T00:00:00.000Z",
          action: { type: "ACT", intent: "レビューする", role: "review" },
          rationale: "テスト",
          decidedBy: "llm",
        },
        attempt: 1,
      },
      deps,
    );
    const invocation = seen[0];
    if (invocation === undefined) {
      throw new Error("Actor が起動していない");
    }
    return invocation;
  }

  it("Goal が書いた review_skill が invocation に載る", async () => {
    expect((await invocationFromGoal(`  review_skill: ${DECLARED}`)).reviewSkill).toBe(DECLARED);
  });

  it("書いていなければ null で、Adapter 側が同梱の skill に倒す", async () => {
    expect((await invocationFromGoal("  protected_paths: []")).reviewSkill).toBeNull();
  });
});

describe("契約は provider によらず1つのまま", () => {
  it("Claude には名指しした plugin だけを渡す", async () => {
    const options = await optionsFor(invocation({ reviewSkill: DECLARED }));

    expect(options.plugins).toEqual([
      { type: "local", path: join(worktree, "plugins/repo-review") },
    ]);
    expect(options.skills).toEqual(["go-ddd-review"]);
    // 名指しした skill 以外が見えるようになる形は採らない。
    expect(options.settingSources).toEqual([]);
  });

  it("Codex には本文を差し込む", () => {
    const prompt = PROMPT_FOR.review(invocation({ reviewSkill: DECLARED }), "inline");

    expect(prompt).toContain("Check the aggregates.");
    expect(prompt).toContain("Domain must not import infrastructure.");
  });

  it("どちらの渡し方でも、求める2行は同じ", () => {
    for (const delivery of ["tool", "inline"] as const) {
      const prompt = PROMPT_FOR.review(invocation({ reviewSkill: DECLARED }), delivery);

      expect(prompt).toContain("reviewed_sha:");
      expect(prompt).toContain("verdict: <either approved or changes_requested>");
      expect(prompt).toContain("go-ddd-review");
    }
  });
});

describe("任意の skill を許した結果として起きること", () => {
  it("references/ を持たない skill でも落ちない", () => {
    // 同梱の semantic-review は持っているので、固定だったあいだは当たらなかった。
    const prompt = PROMPT_FOR.review(
      invocation({ reviewSkill: "plugins/repo-review/skills/bare-review" }),
      "inline",
    );

    expect(prompt).toContain("Read the diff.");
    expect(prompt).not.toContain("references/");
  });

  it("plugin の manifest が無ければ落ちる", () => {
    // ドキュメントは `.claude-plugin/plugin.json` を必須と書いている。書いてある
    // 条件をここで実際に確かめないと、文書が約束した形と ent が通す形が別になり、
    // 揃っていない plugin は Claude Code の中で分かりにくく落ちる。
    const bare = join(worktree, "plugins/manifestless/skills/x");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "SKILL.md"), "---\nname: x\n---\n\nRead it.\n");

    expect(() =>
      PROMPT_FOR.review(invocation({ reviewSkill: "plugins/manifestless/skills/x" }), "inline"),
    ).toThrow(/\.claude-plugin\/plugin\.json/);
  });

  it("SKILL.md が作業ツリーに無ければ、黙って既定へ倒さず落ちる", () => {
    // 落とさないと、観点を1つも読まないまま契約どおりの `verdict:` が返る。
    // 外からは通常のレビューと見分けが付かない。
    expect(() =>
      PROMPT_FOR.review(invocation({ reviewSkill: "plugins/absent/skills/nothing" }), "inline"),
    ).toThrow(/plugins\/absent\/skills\/nothing/);
  });

  it("Claude 側でも同じところで落ちる", async () => {
    await expect(
      optionsFor(invocation({ reviewSkill: "plugins/absent/skills/nothing" })),
    ).rejects.toThrow(/SKILL\.md/);
  });
});

interface RecordedOptions {
  plugins?: { type: string; path: string }[];
  skills?: string[];
  settingSources?: string[];
}

async function optionsFor(actorInvocation: ActorInvocation): Promise<RecordedOptions> {
  const seen: RecordedOptions[] = [];
  const query: AgentQuery = (params) => {
    seen.push((params.options ?? {}) as RecordedOptions);
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "読みました",
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    })();
  };
  await claudeActor({ query, runsDir: "/tmp/entelecheia/runs", writeLog: async () => {} }).run(
    actorInvocation,
  );
  return seen[0] ?? {};
}
