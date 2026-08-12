import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorPort, WorktreePort } from "../src/act/index.js";
import { type ControllerDeps, tick } from "../src/controller/index.js";
import type { Goal } from "../src/domain/goal.js";
import type { ProgressSink } from "../src/publish/index.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * controller が `ReviewPort` を publish まで運んでいることを、ティック越しに固定する。
 *
 * **固定しているのは配線であって、型ではない。** `publish` の側の仕様
 * （節の位置・加工しないこと・読めなかったときの文面）は
 * `tests/publish-review-body.test.ts` が持つ。あちらは `publish()` を直に呼ぶので、
 * controller が `review` を渡しているかどうかは1つも見ていない。
 *
 * 渡っているのは `ControllerDeps extends ReconcileDeps → ObserveDeps` の継承から
 * 構造的に混ざっているだけで、`PublishDeps.review` は任意になる。つまり
 * `ObserveDeps.review` の名前が変われば、型エラーも出ないまま節だけが黙って消える
 * 経路が空いていた。ここが埋めるのはその穴になる。
 *
 * **`ObserveDeps.review` が任意になる方は、これでも捕まらない。** 下の deps は
 * `review` を自分で書いて渡すので、宣言が任意に変わっても素通りする。捕まるのは
 * 「controller から publish へ渡らなくなった」側だけになる。
 */

const NOW = new Date("2026-08-12T05:00:00.000Z");

const GOAL: Goal = {
  version: 1,
  goal: {
    id: "review-body-goal",
    name: "レビュー本文を運ぶ",
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

const REVIEW_BODY = [
  "## 気になったところ",
  "",
  "| 箇所 | 指摘 |",
  "| --- | --- |",
  "| src/publish | 宛先で本文が変わる |",
  "",
  "```ts",
  "const body = commentBody(target, now, null);",
  "```",
  "",
  `reviewed_sha: ${"b".repeat(40)}`,
  "verdict: approved",
].join("\n");

let store: Store;
/** `--report` の宛先に書かれた本文。ティックごとに1件積まれる */
let written: string[];

function sink(): ProgressSink {
  return {
    destination: "stdout",
    write: async (body: string): Promise<void> => {
      written.push(body);
    },
  };
}

/**
 * ティックを回すのに要る依存。`tests/controller.test.ts` の harness を、
 * この検査に要るところだけ残して写したものになる。
 */
function deps(options: {
  review?: ControllerDeps["review"];
  report?: ProgressSink;
}): ControllerDeps {
  const worktree: WorktreePort = {
    ensure: async (name) => ({ path: `/tmp/entelecheia/${name}`, branch: `entelecheia/${name}` }),
    commit: async () => true,
    changedPaths: async () => [],
    repoDirtyState: async () => new Map(),
  };

  const actor: ActorPort = {
    kind: "claude-code",
    run: async () => ({ exitCode: 0, logRef: "log.txt", tokens: 10, artifacts: [] }),
  };

  return {
    store,
    worktree,
    actor,
    owner: "worker-a",
    leaseSeconds: 300,
    review: options.review ?? { latest: async () => null },
    code: {
      getPullRequest: async () => null,
      getLatestCiRun: async () => null,
      getIssue: async () => null,
    },
    local: {
      snapshot: async () => ({ branch: "main", headSha: "a".repeat(40), dirty: false }),
    },
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    approval: { getApproval: async () => null },
    writer: {
      findPullRequest: async () => null,
      createPullRequest: async () => 1,
      addComment: async () => {},
    },
    branch: { push: async (name) => ({ branch: `entelecheia/${name}`, pushed: false }) },
    llm: { chooseAction: async () => ({ type: "ACT", intent: "テストを直す" }) },
    report: options.report,
    now: () => NOW,
  };
}

beforeEach(() => {
  store = openStore(":memory:");
  store.upsertGoal(GOAL);
  store.setStatus("review-body-goal", "ACTIVE", null);
  written = [];
});

afterEach(() => {
  store.close();
});

describe("controller から publish へのレビュー本文の受け渡し", () => {
  it("`--report` を指定したティックの本文に、レビュー役の本文が節として入る", async () => {
    const result = await tick(
      GOAL,
      deps({
        review: { latest: async () => ({ runId: "run-42", finalMessage: REVIEW_BODY }) },
        report: sink(),
      }),
    );

    expect(result.ran).toBe(true);
    expect(written).toHaveLength(1);
    const body = written[0] ?? "";

    // 節が出ていること。ここが落ちるなら、controller が review を渡していない。
    expect(body).toContain("## レビュー役の本文");
    expect(body).toContain("run-42");
    // 本文はそのまま。表もコードブロックも改行も残る。
    expect(body).toContain(REVIEW_BODY);
    // criteria の表は動かさない。節はその後ろに来る。
    expect(body.indexOf("ac-1")).toBeLessThan(body.indexOf("## レビュー役の本文"));
  });

  it("レビュー役の Run が無ければ節を出さない", async () => {
    // Port が null を返す側。「節が常に付く」を検査と取り違えないよう、
    // 出ないティックも同じ経路で見ておく。
    const result = await tick(GOAL, deps({ report: sink() }));

    expect(result.ran).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0] ?? "").not.toContain("## レビュー役の本文");
  });

  it("`--report` を付けないティックでは、レビュー役の Run を読みに行かない", async () => {
    // 使わない本文のために毎ティック生ログを開かない、という publish の性質を
    // controller 越しにも見る。開けば失敗する口が1つ増えるだけになる。
    let reads = 0;
    const result = await tick(
      GOAL,
      deps({
        review: {
          latest: async () => {
            reads += 1;
            return { runId: "run-42", finalMessage: REVIEW_BODY };
          },
        },
      }),
    );

    expect(result.ran).toBe(true);
    // OBSERVE は読む。publish が2回目を読まないので、1回で止まる。
    expect(reads).toBe(1);
  });
});
