import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActorInvocation } from "../src/act/index.js";
import { type AgentQuery, claudeActor } from "../src/adapters/claude.js";
import { findViolations } from "../src/domain/protected-paths.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
  type ReviewPort,
} from "../src/observe/index.js";

/**
 * レビュー役に `semantic-review` の skill を渡す。
 *
 * 観点（何を見るか）は skill が持ち、契約（何を返すか）は controller が持つ、
 * という分け方をここで固定する。3つが揃っていないと成立しない。
 *
 * 1. **skill が届くこと。** `settingSources: []` を解かずに渡す。ホストの
 *    `~/.claude` とリポジトリの `.claude` を読ませない判断（design.md §7）は
 *    そのままで、controller が名指しした plugin だけを見せる
 * 2. **skill が ent に依存しないこと。** `plugins/ent-review/skills/` の中身は
 *    ent の外でも使う汎用の skill で、Goal も verdict も知らない。ent 側の
 *    読み替えは `REVIEW_PROMPT` が持つ。ここが混ざると切り出せなくなる
 * 3. **出力が観測側と噛み合うこと。** skill の出力形式は末尾が `<sub>` の
 *    フッタで、判定の語彙も `MISALIGNED` / `INSUFFICIENT_CONTEXT` / `ALIGNED` に
 *    なる。そのままでは `review.verdict` にならないので、プロンプトが本文の
 *    後ろに `reviewed_sha:` と `verdict:` の2行を足させる
 *
 * 3 を「プロンプトにその文言があること」だけで確かめても足りない。observe まで
 * 通して、実際に Fact が2つ出ることを見る。
 */

interface Recorded {
  query: AgentQuery;
  prompts: string[];
  options: {
    plugins?: { type: string; path: string }[];
    skills?: string[];
    settingSources?: string[];
  }[];
}

function recorded(): Recorded {
  const prompts: string[] = [];
  const options: Recorded["options"] = [];

  return {
    prompts,
    options,
    query: (params) => {
      prompts.push(params.prompt);
      options.push((params.options ?? {}) as Recorded["options"][number]);
      return (async function* () {
        yield SUCCESS;
      })();
    },
  };
}

function deps(sink: Recorded) {
  return { query: sink.query, runsDir: "/tmp/entelecheia/runs", writeLog: async () => {} };
}

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "読みました",
  usage: { input_tokens: 1200, output_tokens: 340 },
};

function invocation(over: Partial<ActorInvocation> = {}): ActorInvocation {
  return {
    runId: "42",
    goalId: "use-ent-in-any-repository",
    intent: "実装をレビューする",
    role: "review",
    worktree: { path: "/tmp/entelecheia/worktrees/sample", branch: "entelecheia/sample" },
    deniedOperations: ["merge"],
    signal: new AbortController().signal,
    ...over,
  };
}

async function optionsFor(role: ActorInvocation["role"]): Promise<Recorded["options"][number]> {
  const sink = recorded();
  await claudeActor(deps(sink)).run(invocation({ role }));
  return sink.options[0] ?? {};
}

async function promptFor(over: Partial<ActorInvocation> = {}): Promise<string> {
  const sink = recorded();
  await claudeActor(deps(sink)).run(invocation(over));
  return sink.prompts[0] ?? "";
}

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/ent-review", import.meta.url));

describe("skill をレビュー役にだけ渡す", () => {
  it("plugin の置き場所を渡す", async () => {
    const options = await optionsFor("review");

    expect(options.plugins).toEqual([{ type: "local", path: PLUGIN_DIR }]);
  });

  it("渡した plugin が実在し、skill が入っている", () => {
    // パスは `import.meta.url` から引いている。src/ から見ても dist/ から見ても
    // 同じ場所を指す必要があり、外れていても型では気づけない。
    const plugin = JSON.parse(readFileSync(`${PLUGIN_DIR}/.claude-plugin/plugin.json`, "utf8")) as {
      name: string;
    };
    const skill = readFileSync(`${PLUGIN_DIR}/skills/semantic-review/SKILL.md`, "utf8");

    expect(plugin.name).toBe("ent-review");
    expect(skill).toContain("name: semantic-review");
  });

  it("有効にする skill を名指しする", async () => {
    const options = await optionsFor("review");

    expect(options.skills).toEqual(["semantic-review"]);
  });

  it("実装役には plugin も skill も渡さない", async () => {
    // レビューの観点を実装役に渡すと、「観点を満たすように書く」余地ができる。
    // 空配列ではなくキーごと渡さない。`skills: []` は「1つも有効にしない」で、
    // 省略とは意味が違う。
    const options = await optionsFor("implement");

    expect(options.plugins).toBeUndefined();
    expect(options.skills).toBeUndefined();
  });

  it("調べる役にも渡さない", async () => {
    const options = await optionsFor("investigate");

    expect(options.plugins).toBeUndefined();
    expect(options.skills).toBeUndefined();
  });

  it("ホストとリポジトリの設定は読ませないまま", async () => {
    // skill を渡すために `settingSources` を緩めない。緩めると controller が
    // 与えた拒否リスト以外の設定が Agent の挙動に混ざる。
    const options = await optionsFor("review");

    expect(options.settingSources).toEqual([]);
  });
});

describe("ent 側の読み替えはプロンプトが持つ", () => {
  it("宣言部を goalId で名指しする", async () => {
    // ブランチ名（`worktreeBranchFor`）から引かせない。命名規則を変えたときに
    // レビューだけが黙って意図を読めなくなる。
    const prompt = await promptFor({ goalId: "use-ent-in-any-repository" });

    expect(prompt).toContain(".goals/use-ent-in-any-repository.yaml");
  });

  it("PR ではなく作業ツリーを見るよう読み替える", async () => {
    const prompt = await promptFor();

    expect(prompt).toContain("semantic-review");
    expect(prompt).toContain("現在の作業ツリーの HEAD");
    expect(prompt).toContain("gh やコネクタでチケットや議論を読む");
  });

  it("結論の2行を、判定の対応付きで求める", async () => {
    const prompt = await promptFor();

    expect(prompt).toContain("reviewed_sha:");
    expect(prompt).toContain("| ALIGNED | approved |");
    expect(prompt).toContain("| MISALIGNED | changes_requested |");
    // 確かめられなかったものを approved に倒さない。
    expect(prompt).toContain("| INSUFFICIENT_CONTEXT | changes_requested |");
  });

  it("実装役と調べる役のプロンプトは skill を求めない", async () => {
    for (const role of ["implement", "investigate"] as const) {
      expect(await promptFor({ role })).not.toContain("semantic-review");
    }
  });
});

describe("skill は ent に依存しない", () => {
  const files = ["SKILL.md", "references/criteria.md", "references/output-format.md"];

  it.each(files)("%s に ent の語彙が入っていない", (file) => {
    // ここが混ざると、skill を別リポジトリへ切り出すときにコピーで済まなくなる。
    // 逆向きの依存（ent が skill を読む）だけにしておく。
    const contents = readFileSync(`${PLUGIN_DIR}/skills/semantic-review/${file}`, "utf8");

    for (const word of ["verdict", ".goals", "entelecheia", "acceptance_criteria"]) {
      expect(contents).not.toContain(word);
    }
  });
});

describe("宣言部を読むことは関門に触れない", () => {
  it("Read した .goals/*.yaml は artifacts に入らない", async () => {
    // **`.goals/**` は `PROTECTED_PATH_FLOOR` の中にある。** そこを読ませる指示を
    // プロンプトに書いた以上、読んだだけで保護パス違反になっていないかを見る。
    // 違反になっていれば、レビューを回すたびに ESCALATE する。
    //
    // 関門が見るのは Run の artifacts で、artifacts に積まれるのは編集のツール
    // （`EDIT_TOOL_NAMES`）が触ったパスだけになる。レビュー役はそもそも編集の
    // ツールを持たないが、Read が artifacts に入らないことは別の性質なので
    // ここで固定する。
    const readGoal = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/tmp/entelecheia/worktrees/sample/.goals/sample.yaml" },
          },
        ],
      },
    };
    const query: AgentQuery = () =>
      (async function* () {
        yield readGoal;
        yield SUCCESS;
      })();

    const result = await claudeActor({
      query,
      runsDir: "/tmp/entelecheia/runs",
      writeLog: async () => {},
    }).run(invocation());

    expect(result.artifacts).toEqual([]);
    expect(
      findViolations(result.artifacts, "/tmp/entelecheia/worktrees/sample", [".goals/**"]),
    ).toEqual([]);
  });
});

/** semantic-review の出力形式に、プロンプトが求める2行を足したもの */
const REVIEWED = "b".repeat(40);
const BASE = "c".repeat(40);
const SEMANTIC_REVIEW_OUTPUT = `## Semantic Review

<!-- semantic-review:summary -->

> [!CAUTION]
> **判定: MISALIGNED** — 要対応 1 件
> 評価した観点: A・B・C・D

### 要対応

#### SR-001 宣言にない振る舞いの変更

- 観点: A2
- 場所: \`src/act/index.ts:320\`

<details>

<summary>調査結果の詳細</summary>

#### レビュー範囲

| 項目 | 内容 |
| --- | --- |
| 比較対象 | \`${BASE}\` … \`${REVIEWED}\` |

</details>

<sub>Semantic Review は PR の意図・仕様・実装の意味的な食い違いを確認します。</sub>

reviewed_sha: ${REVIEWED}
verdict: changes_requested`;

describe("skill の出力形式のまま観測できる", () => {
  const NOW = new Date("2026-08-11T03:00:00.000Z");

  function observeDeps(finalMessage: string): ObserveDeps {
    const code: CodeProviderPort = {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    };
    const local: LocalRepoPort = {
      snapshot: async () => ({ branch: "entelecheia/g", headSha: REVIEWED, dirty: false }),
    };
    const review: ReviewPort = { latest: async () => ({ runId: "run-30", finalMessage }) };
    return { code, local, review, now: () => NOW };
  }

  it("verdict と読んだ commit が対で Fact になる", async () => {
    // skill の本文には base と head の2つの sha が入る。`reviewed_sha:` の
    // 名指しを先に見る規則（src/observe/index.ts）があるので、数えるだけの
    // 規則には落ちない。**skill の出力形式を変えずに噛み合う**ことがここの要点。
    const result = await observe(
      { prNumber: null, issueNumber: null },
      observeDeps(SEMANTIC_REVIEW_OUTPUT),
    );

    expect(result.facts.find((fact) => fact.key === "review.verdict")?.value).toBe(
      "changes_requested",
    );
    expect(result.facts.find((fact) => fact.key === "review.reviewed_sha")?.value).toBe(REVIEWED);
  });
});
