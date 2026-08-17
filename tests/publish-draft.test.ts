import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { githubCodeWriter } from "../src/adapters/github.js";
import type { Decision } from "../src/domain/action.js";
import { type Goal, goalSchema, goalTemplate, TEMPLATE_SLUG } from "../src/domain/goal.js";
import { configTemplate, parseGoalConfig } from "../src/domain/goal-config.js";
import { parseGoal } from "../src/domain/goal-parse.js";
import {
  type BranchPort,
  type CodeWriterPort,
  type PublishTarget,
  type PullRequestDraft,
  publish,
} from "../src/publish/index.js";

/**
 * PR を draft で立てる宣言（issue #65 の案1）。
 *
 * 対象リポジトリに「まず draft で出す」運用があると、ent が立てた PR は
 * ready のままレビュアーに通知が飛ぶ。規約に合わせる作業は、通知より前に
 * 済ませられなければ意味が無い。
 *
 * 満たすべき性質は3つ。
 *
 * - 宣言できる（`repository.pull_request.draft`）
 * - **宣言が無ければ、これまでと1バイトも変わらない。** 既存の `.goals/*.yaml` は
 *   1本もこれを書いていないので、既定が変わると全部の挙動が変わる。POST の body に
 *   `draft` が現れないところまで固定する
 * - 宣言は publish を素通りして GitHub まで届く。ここで落ちると、YAML には
 *   書いてあるのに ready で立つという、外から最も分かりにくい形になる
 *
 * テストから実際の GitHub を叩かない。git push もしない。どちらも Port で注入する。
 */

const NOW = new Date("2026-08-12T06:00:00.000Z");

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

const DECISION: Decision = {
  decidedAt: NOW.toISOString(),
  action: { type: "ACT", intent: "テストの失敗を直す" },
  rationale: "Gap が 1 件ある",
  decidedBy: "llm",
};

/** PR がまだ無く、push に差分があるティック。ここでだけ PR が作られる */
function target(goal: Goal): PublishTarget {
  return {
    goal,
    run: null,
    decision: DECISION,
    verifications: [],
    prNumber: null,
    digest: "d1",
    previousDigest: null,
  };
}

function sink(): { writer: CodeWriterPort; branch: BranchPort; created: PullRequestDraft[] } {
  const created: PullRequestDraft[] = [];

  return {
    created,
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async (draft) => {
        created.push(draft);
        return 42;
      },
      addComment: async () => {},
    },
    branch: {
      push: async () => ({ branch: "entelecheia/sample-goal", pushed: true }),
    },
  };
}

/** YAML の宣言部だけを差し替えて goalSchema に通す */
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
  constraints: []
policies:
  require_human_approval: [merge]
budget:
  max_actor_runs: 10
  max_reconciles: 20
  max_wall_clock: 2h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

function withRepositoryTail(tail: string): unknown {
  return parseYaml(MINIMAL.replace("  default_branch: main", `  default_branch: main\n${tail}`));
}

describe("repository.pull_request の宣言", () => {
  it("draft: true を書ける", () => {
    const goal = goalSchema.parse(withRepositoryTail("  pull_request:\n    draft: true"));

    expect(goal.repository.pull_request?.draft).toBe(true);
  });

  it("書かなければキーごと現れない", () => {
    // **既定値を入れない。** 入れると、いま `.goals/` にある全部の Goal の
    // 解析結果が変わる。宣言部を読んで出す側（`ent get`）と保存する側が
    // 一斉に別のものを見ることになるので、無いものは無いままにする。
    const goal = goalSchema.parse(parseYaml(MINIMAL));

    expect(goal.repository.pull_request).toBeUndefined();
    expect("pull_request" in goal.repository).toBe(false);
  });

  it("pull_request を書いて draft を省くと ready になる", () => {
    // 案2（title_template / body_path）が入ったとき、draft を書かずに
    // そちらだけを書く形になる。そのときも既定は ready のままにする。
    const goal = goalSchema.parse(withRepositoryTail("  pull_request: {}"));

    expect(goal.repository.pull_request?.draft).toBe(false);
  });

  it("draft に真偽値以外は書けない", () => {
    expect(() =>
      goalSchema.parse(withRepositoryTail('  pull_request:\n    draft: "true"')),
    ).toThrow();
  });

  it("pull_request の下の未知キーは弾く", () => {
    // strictObject を外すと、`title_template` を先取りして書いた YAML が
    // 黙って無視される。案2 が入るまでは「まだ読めない」と言わせる。
    expect(() =>
      goalSchema.parse(withRepositoryTail("  pull_request:\n    title_template: 'feat: {name}'")),
    ).toThrow();
  });

  it("ent init が置く2本は、重ねればスキーマとして妥当なまま", () => {
    // 雛形に例を足しても、init を叩いた直後の状態が ent start に渡せることは崩さない。
    // `repository` は `.goals/config.yaml` へ移ったので、init と同じ順に重ねて読む。
    const parsed = parseGoal(
      goalTemplate(TEMPLATE_SLUG),
      TEMPLATE_SLUG,
      parseGoalConfig(
        configTemplate({ owner: "your-org", name: "your-repo", defaultBranch: "main" }),
      ),
    );

    expect(parsed.goal.id).toBe(TEMPLATE_SLUG);
    // 雛形が draft を有効にして配ると、そこから始めたリポジトリは全部 draft になる。
    expect(parsed.repository.pull_request?.draft ?? false).toBe(false);
  });
});

describe("publish が宣言を PR の作成まで運ぶ", () => {
  it("draft: true なら draft として立てる", async () => {
    const deps = sink();
    const goal: Goal = {
      ...GOAL,
      repository: { ...GOAL.repository, pull_request: { draft: true } },
    };

    const result = await publish(target(goal), { ...deps, now: () => NOW });

    expect(result.created).toBe(true);
    expect(deps.created[0]?.draft).toBe(true);
  });

  it("宣言が無ければ draft を指定しない", async () => {
    const deps = sink();

    const result = await publish(target(GOAL), { ...deps, now: () => NOW });

    expect(result.created).toBe(true);
    expect(deps.created[0]?.draft).toBeUndefined();
  });

  it("draft: false を明示したら false として渡す", async () => {
    const deps = sink();
    const goal: Goal = {
      ...GOAL,
      repository: { ...GOAL.repository, pull_request: { draft: false } },
    };

    await publish(target(goal), { ...deps, now: () => NOW });

    expect(deps.created[0]?.draft).toBe(false);
  });
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** POST の body だけを見たいので、応答は固定でよい */
function fakeFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : null,
    });
    return new Response(JSON.stringify({ number: 42 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

const BASE = { owner: "slashkiko", repo: "entelecheia", token: "t" };

describe("githubCodeWriter が draft を送る", () => {
  it("draft: true を POST の body に載せる", async () => {
    const fake = fakeFetch();
    await githubCodeWriter({ ...BASE, fetch: fake.fetch }).createPullRequest({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
      draft: true,
    });

    expect(fake.calls[0]?.body).toEqual({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
      draft: true,
    });
  });

  it("指定が無ければ body に draft を入れない", async () => {
    // 送る中身を変えない。`draft: false` は API の既定と同じだが、
    // 「宣言が無ければ現状維持」を意味の側だけでなく通信の側でも固定する。
    const fake = fakeFetch();
    await githubCodeWriter({ ...BASE, fetch: fake.fetch }).createPullRequest({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
    });

    expect(fake.calls[0]?.body).toEqual({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
    });
  });

  it("draft: false は false として送る", async () => {
    const fake = fakeFetch();
    await githubCodeWriter({ ...BASE, fetch: fake.fetch }).createPullRequest({
      head: "entelecheia/sample",
      base: "main",
      title: "サンプル",
      body: "本文",
      draft: false,
    });

    expect(fake.calls[0]?.body).toMatchObject({ draft: false });
  });
});
