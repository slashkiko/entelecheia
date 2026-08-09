import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentContextPayload, main, parseCommand } from "../src/cli.js";
import { openStore } from "../src/store/index.js";

/**
 * 「もう追わない」と人間が宣言する口を固定する。**「終わった」と言わせる口は作らない。**
 *
 * ループの外で desired state が満たされることがある。実際に起きた。
 * `guard-the-declaration-not-the-state`（PR #29）と
 * `validate-what-crosses-the-boundary`（PR #31）は人間が手で PR をマージした。
 * コードは main に入り CI も緑になったが、`decide` が COMPLETE を返すティックは
 * 一度も回っていないので、Goal は ACTIVE のまま残った。
 *
 * 残ること自体は正しい。`nextStatus` に「PR が merged になったら COMPLETED」は
 * 無く、DB は最後に見た世界を記録している。問題は**そこから降りる手段が無い**
 * ことにあった。この状態で `ent run` を回すと Gap が残っているので guard は
 * COMPLETE にも WAIT にも倒さず、行動の選択が LLM に渡る。マージ済みの作業を
 * もう一度 ACT で作り直しに行き、予算を使う。
 *
 * 実際にどうしたかというと、人間が `sqlite3` で `goals.status` を直接書き換えた。
 * **関門が守っている当のファイルを人間が素手で開けるのが唯一の手段**という状態を、
 * CLI 側で解く。
 *
 * `ent complete` は作らない。design.md §3.1「完了判定は VERIFIED のみ」は
 * `decide` が LLM にすら COMPLETE を選ばせない根拠になっている。CLI に足すと
 * 赤い criteria を1コマンドで飛び越える経路が公式の口になる。
 */

const run = promisify(execFile);

const GOAL_YAML = `version: 1
goal:
  id: abandon-goal
  name: 降りられることを確かめる
  desired_state: |
    もう追わない、と人間が言える。
repository:
  provider: github
  owner: slashkiko
  name: entelecheia
  default_branch: main
setup: []
acceptance_criteria:
  - id: ac-1
    description: 何もしなくても通る検証
    verification:
      type: command
      run: exit 0
context:
  background: |
    降りる口の検証用。
  constraints: []
  references: []
policies:
  require_human_approval:
    - merge
  protected_paths:
    - src/controller/**
budget:
  max_actor_runs: 5
  max_reconciles: 10
  max_wall_clock: 1h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 3
`;

const REASON = "PR #31 が手でマージ済み。ループの外で desired state が成立した";

let repoRoot: string;
let cwd: string;
let stdout: string[];

function lastJson(): unknown {
  return JSON.parse(stdout.at(-1) ?? "null");
}

/** DB を直接読む。CLI の出力ではなく、実際に書かれたものを見る */
function readState(): {
  status: string;
  abandonReason: string | null;
  snapshotRows: number;
  verificationRows: number;
} {
  const store = openStore(join(repoRoot, ".goals", ".state", "goals.db"));
  try {
    const state = store.getState("abandon-goal");
    return {
      status: state?.status ?? "(none)",
      abandonReason: state?.abandonReason ?? null,
      snapshotRows: store.latestSnapshot("abandon-goal") === null ? 0 : 1,
      verificationRows: store.latestVerifications("abandon-goal").length,
    };
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-abandon-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# abandon\n");
  const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
  await run("git", [...identity, "add", "."], { cwd: repoRoot });
  await run("git", [...identity, "commit", "-m", "init"], { cwd: repoRoot });

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "abandon-goal.yaml"), GOAL_YAML);

  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("引数の解釈", () => {
  it("slug と --reason を受け取る", () => {
    expect(parseCommand(["abandon", "abandon-goal", "--reason", REASON])).toEqual({
      kind: "abandon",
      slug: "abandon-goal",
      reason: REASON,
    });
  });

  it("--reason を省略したら error", () => {
    // ここが sqlite3 を直接叩くのとの差になる。理由の無い ABANDONED は、
    // 後から読む人に「なぜ出荷済みの Goal が放棄されているのか」を伝えない。
    const command = parseCommand(["abandon", "abandon-goal"]);

    expect(command.kind).toBe("error");
  });

  it("--reason が空白だけなら error", () => {
    // 必須にしても、空文字で通れば書かれない。
    expect(parseCommand(["abandon", "abandon-goal", "--reason", "   "]).kind).toBe("error");
  });

  it("slug が無ければ error", () => {
    expect(parseCommand(["abandon", "--reason", REASON]).kind).toBe("error");
  });

  it("slug の形が不正なら error", () => {
    // slug はそのまま `.goals/<slug>.yaml` のパスになる。他のサブコマンドと
    // 同じ検査を通す。
    expect(parseCommand(["abandon", "../outside", "--reason", REASON]).kind).toBe("error");
  });

  it("引数が多ければ error", () => {
    expect(parseCommand(["abandon", "a-goal", "b-goal", "--reason", REASON]).kind).toBe("error");
  });

  it("--json を受け取る", () => {
    expect(parseCommand(["abandon", "abandon-goal", "--reason", REASON, "--json"])).toMatchObject({
      kind: "abandon",
      json: true,
    });
  });
});

describe("終端へ落とす", () => {
  it("ACTIVE の Goal を ABANDONED にして、理由を残す", async () => {
    await main(["start", "abandon-goal"]);

    expect(await main(["abandon", "abandon-goal", "--reason", REASON])).toBe(0);

    const state = readState();
    expect(state.status).toBe("ABANDONED");
    expect(state.abandonReason).toBe(REASON);
  });

  it("--json なら理由まで機械可読で出す", async () => {
    await main(["start", "abandon-goal"]);
    await main(["abandon", "abandon-goal", "--reason", REASON, "--json"]);

    expect(lastJson()).toEqual({
      id: "abandon-goal",
      status: "ABANDONED",
      reason: REASON,
    });
  });

  it("ent get から理由が読める", async () => {
    // 「どこかに書いた」では足りない。人間とエージェントが読む経路に出す。
    await main(["start", "abandon-goal"]);
    await main(["abandon", "abandon-goal", "--reason", REASON]);

    expect(await main(["get", "abandon-goal"])).toBe(0);
    expect(lastJson()).toMatchObject({
      state: { status: "ABANDONED", abandonReason: REASON },
    });
  });

  it("ABANDONED になった Goal は run が拾わない", async () => {
    // 終端に落とす目的そのもの。ここが通らないなら、予算を使う経路は塞げていない。
    await main(["start", "abandon-goal"]);
    await main(["abandon", "abandon-goal", "--reason", REASON]);

    expect(await main(["run", "abandon-goal"])).toBe(0);
    expect(lastJson()).toMatchObject({ ran: false, status: "ABANDONED" });
  });
});

describe("観測の履歴は書き換えない", () => {
  it("snapshot と verifications をそのまま残す", async () => {
    // ここは「最後のティックが何を見たか」の記録になる。書き換えるのは観測の捏造で、
    // criteria が false のまま残るのは正しい。その時点では実際に落ちていた。
    await main(["start", "abandon-goal"]);
    await main(["run", "abandon-goal"]);
    const before = readState();

    await main(["abandon", "abandon-goal", "--reason", REASON]);

    const after = readState();
    expect(after.snapshotRows).toBe(before.snapshotRows);
    expect(after.verificationRows).toBe(before.verificationRows);
  });
});

describe("落とせない場合は何も書かない", () => {
  it("既に終端なら終了コード 1 で、status を塗り替えない", async () => {
    // design.md §4.4「終端の Goal を ACTIVE に戻さない」。終端から別の終端へ
    // 移すのも同じ違反で、COMPLETED を ABANDONED で塗り替えられるなら記録が残らない。
    await main(["start", "abandon-goal"]);
    await main(["run", "abandon-goal"]);
    expect(readState().status).toBe("COMPLETED");

    expect(await main(["abandon", "abandon-goal", "--reason", REASON])).toBe(1);

    const state = readState();
    expect(state.status).toBe("COMPLETED");
    expect(state.abandonReason).toBeNull();
  });

  it("二度目の abandon も弾く", async () => {
    await main(["start", "abandon-goal"]);
    await main(["abandon", "abandon-goal", "--reason", REASON]);

    expect(await main(["abandon", "abandon-goal", "--reason", "別の理由"])).toBe(1);
    // 最初の理由が残る。上書きされると、なぜ降りたのかが読めなくなる。
    expect(readState().abandonReason).toBe(REASON);
  });

  it("lease を持っている Goal は落とさない", async () => {
    // 別のプロセスがそのティックを回している。横から終端へ落とすと、
    // 走っている controller が終端の Goal に書き戻す。
    await main(["start", "abandon-goal"]);

    const store = openStore(join(repoRoot, ".goals", ".state", "goals.db"));
    const now = new Date();
    store.acquireLease("abandon-goal", "worker-a", new Date(now.getTime() + 300_000), now);
    store.close();

    expect(await main(["abandon", "abandon-goal", "--reason", REASON])).toBe(1);

    const state = readState();
    expect(state.status).toBe("ACTIVE");
    expect(state.abandonReason).toBeNull();
  });

  it("登録されていない Goal は落とさない", async () => {
    // start を挟んでいない。DB に行が無いものを終端にすると、
    // 「回したことのない Goal が放棄済み」という読めない記録ができる。
    expect(await main(["abandon", "abandon-goal", "--reason", REASON])).toBe(1);
  });
});

describe("完了を名乗らせる口は作らない", () => {
  it("ent complete は無い", () => {
    // §3.1「完了判定は VERIFIED のみ」を1コマンドで飛び越えさせない。
    expect(parseCommand(["complete", "abandon-goal"]).kind).toBe("error");
    expect(agentContextPayload().commands.map((command) => command.name)).not.toContain("complete");
  });

  it("abandon が COMPLETED を書ける口を持たない", () => {
    // --status のような、状態を選べる形にしない。書ける終端は ABANDONED だけ。
    expect(parseCommand(["abandon", "abandon-goal", "--status", "COMPLETED"]).kind).toBe("error");
  });
});

describe("CLI の構造に載る", () => {
  it("agent-context が abandon を出す", () => {
    const abandon = agentContextPayload().commands.find((command) => command.name === "abandon");

    expect(abandon).toBeDefined();
    expect(abandon?.args.map((arg) => arg.name)).toEqual(["slug"]);
    expect(abandon?.flags.map((flag) => flag.name)).toContain("--reason");
  });

  it("--reason は必須だと読める", () => {
    const reason = agentContextPayload()
      .commands.find((command) => command.name === "abandon")
      ?.flags.find((flag) => flag.name === "--reason");

    expect(reason?.summary).toContain("必須");
  });
});
