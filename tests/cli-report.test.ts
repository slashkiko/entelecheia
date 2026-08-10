import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentContextPayload, main, parseCommand, reportSink } from "../src/cli.js";

/**
 * criteria の pass 状況を、PR ではなく手元に出す口（`ent run <slug> --report`）。
 *
 * 進捗の宛先は PR コメント1つに固定されていた。試走のたびにレビュー中の PR が
 * 伸びる、公開リポジトリで手元の検証結果を出したくない、そもそも GITHUB_TOKEN が
 * 無い、といった場面で「回すが投稿はしない」を選べない。`--dry-run` は投稿しないが、
 * ACT も永続化もしないので「回す」の側を満たさない。
 *
 * 宛先を変えるだけにする。観測・判断・push・PR の作成には触れない。
 *
 * `run` の stdout は JSON 専用（gist 4.3）なので、`stdout` を指定したときも
 * 素の Markdown は流さない。JSON の `report.body` に入れて、そのまま `jq -r` で
 * 取り出せる形にする。ここを崩すと `ent run | jq` が壊れる。
 */

const run = promisify(execFile);

const GOAL_YAML = `version: 1
goal:
  id: report-goal
  name: 進捗の宛先を選べる
  desired_state: |
    criteria の pass 状況を PR に投稿せずに読める。
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
    宛先の検証用。
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

let repoRoot: string;
let cwd: string;
let stdout: string[];

function lastJson(): Record<string, unknown> {
  return JSON.parse(stdout.at(-1) ?? "null") as Record<string, unknown>;
}

beforeEach(async () => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-report-"));
  process.chdir(repoRoot);

  await run("git", ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# report\n");
  const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
  await run("git", [...identity, "add", "."], { cwd: repoRoot });
  await run("git", [...identity, "commit", "-m", "init"], { cwd: repoRoot });

  mkdirSync(join(repoRoot, ".goals"), { recursive: true });
  writeFileSync(join(repoRoot, ".goals", "report-goal.yaml"), GOAL_YAML);

  // トークンが無い環境で使えることが、この口の要点の1つになる。
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
  it("--report stdout を受け取る", () => {
    expect(parseCommand(["run", "report-goal", "--report", "stdout"])).toEqual({
      kind: "run",
      slug: "report-goal",
      report: { kind: "stdout" },
    });
  });

  it("--report <path> はファイルとして読む", () => {
    expect(parseCommand(["run", "report-goal", "--report", "./out/progress.md"])).toEqual({
      kind: "run",
      slug: "report-goal",
      report: { kind: "file", path: "./out/progress.md" },
    });
  });

  it("--report が空なら error", () => {
    // 空文字を「指定しなかった」と同じに畳むと、投稿しないつもりの1回が PR に出る。
    expect(parseCommand(["run", "report-goal", "--report", "  "]).kind).toBe("error");
  });

  it("--report を付けなければ report は入らない", () => {
    // 既存の呼び出しが読んでいる形（`{ kind: "run", slug }`）を変えない。
    expect(parseCommand(["run", "report-goal"])).toEqual({ kind: "run", slug: "report-goal" });
  });

  it("--dry-run と一緒には使えない", () => {
    // dry-run は publish を通らないので、黙って受け取ると「指定したのに
    // 何も出ない」になる。知らないオプションと同じく、その場で断る。
    const command = parseCommand(["run", "report-goal", "--dry-run", "--report", "out.md"]);

    expect(command.kind).toBe("error");
    expect(command.kind === "error" ? command.message : "").toContain("--dry-run");
  });

  it("run 以外は受け取らない", () => {
    // 進捗を書くのは run のティックだけ。他に付けても効かないので黙って捨てない。
    expect(parseCommand(["get", "report-goal", "--report", "stdout"]).kind).toBe("error");
    expect(parseCommand(["list", "--report", "stdout"]).kind).toBe("error");
  });

  it("agent-context に載る", () => {
    // エージェントは --help ではなくこちらを読む（gist 3.2 Layer 2）。
    const flags = agentContextPayload().commands.find((c) => c.name === "run")?.flags ?? [];

    expect(flags.map((flag) => flag.name)).toContain("--report");
  });
});

describe("宛先そのもの", () => {
  it("ファイルには追記する", async () => {
    // ティックごとの進捗は積み上がるもので、PR コメントも積む。上書きにすると、
    // cron から回したときに最後の1ティックしか残らない。
    const path = join(repoRoot, "progress.md");
    const record = { body: null as string | null, error: null as string | null };
    const sink = reportSink({ kind: "file", path }, record);

    await sink.write("1ティック目");
    await sink.write("2ティック目");

    const written = readFileSync(path, "utf8");
    expect(written).toContain("1ティック目");
    expect(written).toContain("2ティック目");
  });

  it("書けなければ throw して、理由を控える", async () => {
    const record = { body: null as string | null, error: null as string | null };
    const sink = reportSink(
      { kind: "file", path: join(repoRoot, "no-such-dir", "out.md") },
      record,
    );

    await expect(sink.write("本文")).rejects.toThrow();
    expect(record.error).not.toBeNull();
  });

  it("stdout の宛先はファイルを作らず、本文を控えるだけ", async () => {
    const record = { body: null as string | null, error: null as string | null };
    const sink = reportSink({ kind: "stdout" }, record);

    await sink.write("本文");

    expect(record.body).toBe("本文");
    expect(sink.destination).toBe("stdout");
  });
});

describe("ティックを回して出す", () => {
  it("--report stdout なら JSON の report.body に criteria の表が入る", async () => {
    await main(["start", "report-goal"]);

    expect(await main(["run", "report-goal", "--report", "stdout"])).toBe(0);

    const payload = lastJson();
    // stdout は JSON 専用のまま。素の Markdown を混ぜると jq に渡せなくなる。
    expect(payload.ran).toBe(true);
    const report = payload.report as { destination: string; written: boolean; body: string };
    expect(report.destination).toBe("stdout");
    expect(report.written).toBe(true);
    expect(report.body).toContain("ac-1");
    expect(report.body).toContain("passed");
    expect(report.body).toContain("|---|");
  });

  it("--report <path> ならファイルに出て、JSON には本文を混ぜない", async () => {
    const path = join(repoRoot, "progress.md");
    await main(["start", "report-goal"]);

    expect(await main(["run", "report-goal", "--report", path])).toBe(0);

    expect(readFileSync(path, "utf8")).toContain("ac-1");
    const report = lastJson().report as { destination: string; path: string; body?: string };
    expect(report.destination).toBe("file");
    expect(report.path).toBe(path);
    // ファイルに出したものを JSON にも積むと、同じ本文が2箇所に出る。
    expect(report.body).toBeUndefined();
  });

  it("--report を付けなければ JSON の形を変えない", async () => {
    await main(["start", "report-goal"]);
    await main(["run", "report-goal"]);

    expect(lastJson().report).toBeUndefined();
  });

  it("トークンが無くても出る", async () => {
    // PR も作れないしコメントもできない環境。この口を使う動機の中心にあたる。
    await main(["start", "report-goal"]);
    await main(["run", "report-goal", "--report", "stdout"]);

    const report = lastJson().report as { written: boolean };
    expect(report.written).toBe(true);
  });

  it("書けなかったら終了コードは変えず、書けなかったことを出す", async () => {
    // 通知の失敗でティック全体を落とさない（design.md §9）。ただし黙らない。
    const path = join(repoRoot, "no-such-dir", "progress.md");
    await main(["start", "report-goal"]);

    expect(await main(["run", "report-goal", "--report", path])).toBe(0);

    expect(existsSync(path)).toBe(false);
    const report = lastJson().report as { written: boolean; error: string | null };
    expect(report.written).toBe(false);
    expect(report.error).not.toBeNull();
  });

  it("回らなかったティックでは書かない", async () => {
    // 終端の Goal は publish を通らない。何も起きていないのに進捗が出ると、
    // ファイルを読む側が「回った」と読む。
    const path = join(repoRoot, "progress.md");
    await main(["start", "report-goal"]);
    await main(["run", "report-goal"]);

    expect(await main(["run", "report-goal", "--report", path])).toBe(0);

    expect(lastJson().ran).toBe(false);
    expect(existsSync(path)).toBe(false);
    const report = lastJson().report as { written: boolean };
    expect(report.written).toBe(false);
  });
});
