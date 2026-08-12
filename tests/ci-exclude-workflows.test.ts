import { describe, expect, it } from "vitest";
import { githubCodeProvider } from "../src/adapters/github.js";
import { type Fact, verifiedOnly } from "../src/domain/fact.js";
import { criterionFactKey, observedFactKeySchema } from "../src/domain/fact-keys.js";
import { type AcceptanceCriterion, repositorySchema } from "../src/domain/goal.js";
import {
  type CodeProviderPort,
  type LocalRepoPort,
  type ObserveDeps,
  observe,
} from "../src/observe/index.js";
import {
  type ApprovalPort,
  type CommandRunnerPort,
  type VerifyDeps,
  verify,
} from "../src/verify/index.js";

/**
 * 恒久的に落ちる（または pending のままの）check を、落ちている job の数から外す。
 *
 * `github.ci.failed_job_count`（issue #58 / PR #71）は head sha に紐づく全 workflow run を
 * 横断して数える。横断するようにしたことで、**リポジトリの運用として意図的に赤いまま／
 * 保留のままにしてある gate も数に入る**ようになった。「特定の人のレビューが通るまで
 * mergeable にしない」種類の gate がそれにあたる。数に入ると `equals: 0` は永久に埋まらない。
 *
 * そこで**宣言部から除外を書ける**ようにする。
 *
 *   repository:
 *     ci:
 *       exclude_workflows:
 *         - Require owner approval
 *
 * 満たすべき性質は4つ。
 *
 *   既定は除外なし  宣言が無ければ**観測の側は**1文字も変わらない。`failed_job_count` の
 *                  detail の文言も含めて（`DETAIL_WITHOUT_DECLARATION`）。
 *                  ただし判定の側は変わる。除外を人間が読む場所まで通すために
 *                  `observedContext`（src/verify/index.ts）を足しており、あれは
 *                  `type: fact` の criterion **全部**の detail に観測の detail を繋ぐ。
 *                  除外を1つも書いていない Goal でも、進捗コメントの detail 列は伸びる。
 *                  値を言い直しただけの detail は繋がないので、`conclusion=success` の
 *                  ような大半のキーは伸びない（下の「値を言い直しただけの detail は繋がない」）
 *   run 単位       除外の単位は workflow run。`failedJobCount` は「未確定の run が1本でも
 *                  あれば null」で決まるので、恒久的に pending の gate を数から外すには
 *                  run ごと外すしかない。job 名で外しても run が pending であることは変わらず、
 *                  数は永久に null のままになる
 *   黙って隠さない  何を除外したかが Fact の detail と `github.ci.excluded_workflows` から読める。
 *                  外した run 1本ずつの見え方（`waiting` / `failure` …）まで出す。
 *                  **除外した run の失敗ジョブは `github.ci.failed_jobs` からも消える**ので、
 *                  消えたものが赤かったかはここでしか読めない。
 *                  「全部緑」と「除外した上で緑」が同じ見た目になると、issue #58 が直そうと
 *                  した壊れ方を作り直すことになる
 *   意味を変えない  `github.ci.conclusion` と `headSha` は最新の run 1本のまま。除外を宣言しても
 *                  「最新の run」の選び方は動かさない（PR #71 が変えないと約束した箇所）
 *
 * run の総数と1ページの上限（`per_page: 100`）の関係は tests/ci-failed-job-count.test.ts の
 * 「1ページで読み切れていないなら数を出さない」で固定してある。**除外はページを取った
 * あとに走る**ので、除外予定の run も 100 本の枠を消費する。
 */

const NOW = new Date("2026-08-12T03:00:00.000Z");
const SHA = "a".repeat(40);

const EXCLUDED_KEY = "github.ci.excluded_workflows";
const COUNT_KEY = "github.ci.failed_job_count";

/** 宣言が無いときの detail。PR #71 が出しているものと1文字も変えない */
const DETAIL_WITHOUT_DECLARATION = "failed_job_count=0 (across all workflow runs for the head sha)";

interface Route {
  match: string;
  body?: unknown;
}

/** 実際の GitHub を叩かない。fetch を注入して octokit の下を差し替える */
function provider(
  routes: Route[],
  excludeWorkflows?: readonly string[],
  /** 叩いた URL を記録する。往復が増えていないことを見るテストが読む */
  requested: string[] = [],
): CodeProviderPort {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return githubCodeProvider({
    owner: "slashkiko",
    repo: "entelecheia",
    token: "ghp_test",
    fetch: impl as unknown as typeof fetch,
    ...(excludeWorkflows === undefined ? {} : { excludeWorkflows }),
  });
}

function deps(over: {
  code?: Partial<CodeProviderPort>;
  local?: Partial<LocalRepoPort>;
}): ObserveDeps {
  return {
    review: { latest: async () => null },
    code: {
      getPullRequest: async () => ({
        number: 12,
        state: "open",
        mergeable: null,
        headSha: SHA,
        reviewDecision: null,
        requestedReviewers: [],
        title: "サンプル PR",
        body: "本文",
        unresolvedThreads: null,
      }),
      getLatestCiRun: async () => null,
      getIssue: async () => null,
      ...over.code,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: SHA, dirty: false }),
      ...over.local,
    },
    now: () => NOW,
  };
}

function byKey(facts: readonly Fact[], key: string): Fact | undefined {
  return facts.find((f) => f.key === key);
}

describe("除外を宣言部に書ける", () => {
  it("repository.ci.exclude_workflows が書ける", () => {
    const parsed = repositorySchema.safeParse({
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
      ci: { exclude_workflows: ["Require owner approval"] },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.ci?.exclude_workflows).toEqual(["Require owner approval"]);
  });

  it("書かなければキーごと生えない", () => {
    // `.default({})` にすると、1本も YAML を触っていない既存 Goal の解析結果に
    // `ci` が生える。`ent get` はそれをそのまま出すので、出力が黙って変わる。
    // repository.pull_request と同じ扱いにしてある。
    const parsed = repositorySchema.parse({
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    });

    expect("ci" in parsed).toBe(false);
  });

  it("typo は strictObject が弾く", () => {
    const parsed = repositorySchema.safeParse({
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
      ci: { exclude_workflow: ["typo"] },
    });

    expect(parsed.success).toBe(false);
  });

  it("観測キーとして github.ci.excluded_workflows が実在する", () => {
    expect(observedFactKeySchema.safeParse(EXCLUDED_KEY).success).toBe(true);
  });
});

describe("除外した run は数に入らない", () => {
  const RUNS = {
    match: "/actions/runs?",
    body: {
      total_count: 2,
      workflow_runs: [
        { id: 9, name: "CI", head_sha: SHA, status: "completed", conclusion: "failure" },
        {
          id: 8,
          name: "Require owner approval",
          head_sha: SHA,
          status: "completed",
          conclusion: "failure",
        },
      ],
    },
  };
  const CI_JOBS = {
    match: "/actions/runs/9/jobs",
    body: { jobs: [{ name: "lint", conclusion: "failure", html_url: "https://g/j/9" }] },
  };
  const GATE_JOBS = {
    match: "/actions/runs/8/jobs",
    body: { jobs: [{ name: "approval", conclusion: "failure", html_url: "https://g/j/8" }] },
  };

  it("宣言が無ければ両方数える", async () => {
    const ci = await provider([RUNS, CI_JOBS, GATE_JOBS]).getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(2);
    expect(ci?.excludedWorkflows).toEqual([]);
  });

  it("宣言した workflow の失敗ジョブは数からも failedJobs からも落ちる", async () => {
    const ci = await provider(
      [RUNS, CI_JOBS, GATE_JOBS],
      ["Require owner approval"],
    ).getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(1);
    expect(ci?.failedJobs).toEqual([{ name: "lint", logUrl: "https://g/j/9" }]);
  });

  it("除外した run の jobs は引きに行かない", async () => {
    // 除外した run を数に入れないだけなら jobs を引いてから捨ててもよいが、
    // それは workflow の数だけ API を1往復ずつ増やす。run 単位で外すと往復ごと減る。
    const requested: string[] = [];
    const ci = await provider(
      [RUNS, CI_JOBS, GATE_JOBS],
      ["Require owner approval"],
      requested,
    ).getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(1);
    expect(requested.some((url) => url.includes("/actions/runs/9/jobs"))).toBe(true);
    expect(requested.some((url) => url.includes("/actions/runs/8/jobs"))).toBe(false);
  });
});

describe("恒久的に pending の gate を外せる", () => {
  const RUNS = {
    match: "/actions/runs?",
    body: {
      total_count: 2,
      workflow_runs: [
        { id: 9, name: "CI", head_sha: SHA, status: "completed", conclusion: "success" },
        {
          id: 8,
          name: "Require owner approval",
          head_sha: SHA,
          status: "waiting",
          conclusion: null,
        },
      ],
    },
  };

  it("宣言が無ければ数は確定しない", async () => {
    // ここが除外の単位を run にした理由になる。承認待ちの gate は completed に
    // ならないので、数は永久に null のままで `equals: 0` は届かない。
    expect((await provider([RUNS]).getLatestCiRun(SHA))?.failedJobCount).toBeNull();
  });

  it("除外すれば残りの run だけで数が確定する", async () => {
    const ci = await provider([RUNS], ["Require owner approval"]).getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(0);
    // 外した run が保留のままだったことが、外した側から読める。
    expect(ci?.excludedWorkflows).toEqual([
      { name: "Require owner approval", runs: 1, states: ["waiting"] },
    ]);
  });
});

describe("全部の run を外したとき", () => {
  it("数は 0 になる。除外したことは観測に残る", async () => {
    // 数えた結果 1件も無かったのと同じ値が出る。「1本も見ていないのに緑」に
    // 見えるが、ここで数を出さない側に倒すと「除外したのに数が出ない」になり、
    // 宣言した通りに動いていないように見える。除外したことは
    // excludedWorkflows に出るので、外から読めば区別できる。
    const runs = {
      match: "/actions/runs?",
      body: {
        total_count: 1,
        workflow_runs: [
          {
            id: 8,
            name: "Require owner approval",
            head_sha: SHA,
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    };

    const ci = await provider([runs], ["Require owner approval"]).getLatestCiRun(SHA);

    expect(ci?.failedJobCount).toBe(0);
    // **外したのが赤い run だったことが読める。** ここが数だけだと、保留のままの
    // gate を外したのか本物の失敗を外したのかが区別できない。除外した run の
    // 失敗ジョブは failedJobs からも消えるので、消えたものの色はここでしか読めない。
    expect(ci?.excludedWorkflows).toEqual([
      { name: "Require owner approval", runs: 1, states: ["failure"] },
    ]);
    expect(ci?.failedJobs).toEqual([]);
    // 最新の run はそのまま残るので、conclusion からも赤いことが読める。
    expect(ci?.conclusion).toBe("failure");
  });
});

describe("除外しても conclusion の意味は変わらない", () => {
  it("最新の run が除外対象でも、conclusion はその run のまま", async () => {
    // PR #71 は「`github.ci.conclusion` の意味を変えない」を約束している。
    // 除外は数の側の話で、最新の run の選び方には触らない。触ると、宣言を
    // 足しただけで既存の `conclusion == success` の criterion の意味が動く。
    const runs = {
      match: "/actions/runs?",
      body: {
        total_count: 2,
        workflow_runs: [
          {
            id: 8,
            name: "Require owner approval",
            head_sha: SHA,
            status: "completed",
            conclusion: "failure",
          },
          { id: 7, name: "CI", head_sha: SHA, status: "completed", conclusion: "success" },
        ],
      },
    };
    const gateJobs = {
      match: "/actions/runs/8/jobs",
      body: { jobs: [{ name: "approval", conclusion: "failure", html_url: "https://g/j/8" }] },
    };

    const ci = await provider([runs, gateJobs], ["Require owner approval"]).getLatestCiRun(SHA);

    expect(ci?.conclusion).toBe("failure");
    expect(ci?.headSha).toBe(SHA);
    // 数の側だけが除外を反映する。
    expect(ci?.failedJobCount).toBe(0);
  });
});

describe("一致しなかった除外名が読める", () => {
  it("どの run にも当たらない名前は runs=0 で残る", async () => {
    // 黙って捨てない。ただし「typo」と「今回は起動しなかった workflow」（path filter や
    // branch filter で走らないことがある）を観測の側から区別する手立ては無いので、
    // 弾かずに数を出して人間に読ませる。
    const runs = {
      match: "/actions/runs?",
      body: {
        total_count: 1,
        workflow_runs: [
          { id: 7, name: "CI", head_sha: SHA, status: "completed", conclusion: "success" },
        ],
      },
    };

    const ci = await provider([runs], ["Require ownr approval"]).getLatestCiRun(SHA);

    expect(ci?.excludedWorkflows).toEqual([{ name: "Require ownr approval", runs: 0, states: [] }]);
    expect(ci?.failedJobCount).toBe(0);
  });
});

describe("observe が除外を隠さない", () => {
  function snapshotOf(over: {
    failedJobCount: number | null;
    excludedWorkflows: { name: string; runs: number; states: string[] }[];
  }) {
    return {
      headSha: SHA,
      status: "completed" as const,
      conclusion: "success" as const,
      failedJobs: [],
      ...over,
    };
  }

  it("宣言が無ければ detail は PR #71 のまま", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () => snapshotOf({ failedJobCount: 0, excludedWorkflows: [] }),
        },
      }),
    );

    expect(byKey(result.facts, COUNT_KEY)?.evidence?.detail).toBe(DETAIL_WITHOUT_DECLARATION);
    expect(byKey(result.facts, EXCLUDED_KEY)).toBeUndefined();
  });

  it("除外したら数の detail にそれが出る", async () => {
    // **書式まで固定する。**「除外したことが人間の読む場所から読める」という主張が
    // 乗っているのはこの1行なので、含まれているかだけを見ると、名前が消えても
    // 数が消えても通ってしまう。一致しなかった名前も同じところに出す（読む側が
    // 2箇所を突き合わせずに済む）。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () =>
            snapshotOf({
              failedJobCount: 0,
              excludedWorkflows: [
                { name: "Require owner approval", runs: 1, states: ["waiting"] },
                { name: "Require ownr approval", runs: 0, states: [] },
              ],
            }),
        },
      }),
    );

    expect(byKey(result.facts, COUNT_KEY)?.evidence?.detail).toBe(
      "failed_job_count=0 (across all workflow runs for the head sha" +
        " / excluded: Require owner approval (1 run / waiting), Require ownr approval (no match))",
    );
  });

  it("同じ名前で複数の run を外したら、1本ずつの見え方が並ぶ", async () => {
    // 1つの workflow 名が run 複数本に当たることがある（再実行や
    // `on: pull_request_review` の gate）。まとめて1語にすると、赤い run を
    // 外したことが保留の run に紛れる。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () =>
            snapshotOf({
              failedJobCount: 0,
              excludedWorkflows: [
                { name: "Require owner approval", runs: 2, states: ["waiting", "failure"] },
              ],
            }),
        },
      }),
    );

    expect(byKey(result.facts, COUNT_KEY)?.evidence?.detail).toBe(
      "failed_job_count=0 (across all workflow runs for the head sha" +
        " / excluded: Require owner approval (2 run / waiting, failure))",
    );
  });

  it("除外そのものを Fact にする", async () => {
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () =>
            snapshotOf({
              failedJobCount: 0,
              excludedWorkflows: [{ name: "Require owner approval", runs: 1, states: ["waiting"] }],
            }),
        },
      }),
    );

    const fact = byKey(result.facts, EXCLUDED_KEY);
    expect(fact?.value).toEqual([{ name: "Require owner approval", runs: 1, states: ["waiting"] }]);
    expect(fact?.confidence).toBe("VERIFIED");
    expect(fact?.evidence?.source).toContain("getLatestCiRun");
  });

  it("数が確定していなくても、除外したことは Fact にする", async () => {
    // 数を出さない理由と、除外を宣言したという事実は別のもの。
    const result = await observe(
      { prNumber: 12, issueNumber: null },
      deps({
        code: {
          getLatestCiRun: async () => ({
            headSha: SHA,
            status: "in_progress" as const,
            conclusion: null,
            failedJobs: [],
            failedJobCount: null,
            excludedWorkflows: [{ name: "Require owner approval", runs: 1, states: ["waiting"] }],
          }),
        },
      }),
    );

    expect(byKey(result.facts, COUNT_KEY)).toBeUndefined();
    expect(byKey(result.facts, EXCLUDED_KEY)).toBeDefined();
  });
});

describe("進捗レポートでも除外が読める", () => {
  function verifyDeps(): VerifyDeps {
    const command: CommandRunnerPort = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const approval: ApprovalPort = { getApproval: async () => null };
    return { command, approval, now: () => NOW };
  }

  function factCriterion(key: string, equals: string | number): AcceptanceCriterion {
    return {
      id: "ac-1",
      description: `${key} を見る`,
      verification: { type: "fact", key, equals },
    } as AcceptanceCriterion;
  }

  function factOf(key: string, value: unknown, detail: string): Fact {
    return {
      key,
      value,
      observedAt: NOW.toISOString(),
      confidence: "VERIFIED",
      evidence: { source: "CodeProviderPort.getLatestCiRun(...)", detail },
    };
  }

  /** criteria の判定結果に付く detail。進捗コメントの detail 列がこれを出す */
  async function detailOf(criterion: AcceptanceCriterion, fact: Fact): Promise<string> {
    const result = await verify({ setup: [], criteria: [criterion], facts: [fact] }, verifyDeps());
    return (
      verifiedOnly(result.facts).find((f) => f.key === criterionFactKey("ac-1"))?.evidence.detail ??
      ""
    );
  }

  it("除外した上で緑になったことが detail から読める", async () => {
    // ここを落とすと「全部緑」と「除外した上で緑」が同じ行になる。
    // 進捗コメントが出すのは criteria の detail だけなので、観測が残した文脈が
    // ここまで届かないと、人間が読む場所からは除外が消える。
    const observed =
      "failed_job_count=0 (across all workflow runs for the head sha / excluded: Require owner approval (1 run / waiting))";
    const detail = await detailOf(factCriterion(COUNT_KEY, 0), factOf(COUNT_KEY, 0, observed));

    // **書式まで固定する。** ここは人間が読む場所の書式そのものなので、
    // 含まれているかだけを見ると、判定の側の値が消えても除外の側が消えても通る。
    expect(detail).toBe(`github.ci.failed_job_count=0 expected=0 / ${observed}`);
  });

  it("値を言い直しただけの detail は繋がない", async () => {
    // observe の detail は大半が `<キーの末尾>=<値>` の形をしている。
    // それを繋ぐと、同じ値が1行に2回並ぶだけになる。
    const detail = await detailOf(
      factCriterion("github.ci.conclusion", "success"),
      factOf("github.ci.conclusion", "success", "conclusion=success"),
    );

    expect(detail).toBe('github.ci.conclusion="success" expected="success"');
  });
});
