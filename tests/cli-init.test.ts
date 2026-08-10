import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentContextPayload, main, parseCommand } from "../src/cli.js";
import { loadGoalFile } from "../src/domain/goal-loader.js";

/**
 * `ent init`。この repo の外のリポジトリで ent を回し始められるようにする。
 *
 * `ent` は既に、いまいるディレクトリを対象リポジトリとして扱う
 * （`repoRoot = process.cwd()`）。本体の置き場所と対象リポジトリは分かれていて、
 * 別のリポジトリのルートで叩けばそこの `.goals/` を読んで回る。配管は繋がっている。
 *
 * 繋がっていないのは、そこへ辿り着くまでの道になる。`.goals/` が無い状態で
 * `ent doctor` を叩くと `goals: failed`（detail は「.goals/ を読めなかった」）が
 * 出るだけで、**壊れているのか、まだ始めていないのかが読み分けられない。**
 * `.goals/.state/` を gitignore に足し忘れれば、状態 DB と worktree と Agent の
 * 生ログが対象リポジトリの git に載る。どちらも人間が README を読むまで分からない。
 *
 * ここで固定するのは外から見える振る舞いだけにする。`main([...])` の終了コードと
 * ファイルの状態、`parseCommand` の解釈。**どう分けて実装するかは決めない。**
 *
 * 冪等性を1つの `it` にまとめない。「2度目が 0 で返る」と「2度目が既存の
 * Goal YAML を壊さない」と「gitignore の行が二重にならない」は別の壊れ方で、
 * まとめると1つ落ちた時点で残りが観測されなくなる。
 */

const run = promisify(execFile);
const IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

let repoRoot: string;
let cwd: string;
let stdout: string[];

/** `.goals/` にある Goal YAML のファイル名 */
function goalFiles(): string[] {
  const dir = join(repoRoot, ".goals");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
}

/** `.gitignore` の行のうち、`.goals/.state/` を指すもの */
function ignoreLines(): string[] {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === ".goals/.state/" || line === ".goals/.state");
}

async function makeGitRepo(dir: string): Promise<void> {
  await run("git", ["init", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# target\n");
  await run("git", [...IDENTITY, "add", "."], { cwd: dir });
  await run("git", [...IDENTITY, "commit", "-m", "init"], { cwd: dir });
}

beforeEach(() => {
  cwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "ent-init-"));
  process.chdir(repoRoot);

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
  it("init は slug を取らない", () => {
    expect(parseCommand(["init"])).toEqual({ kind: "init" });
  });

  it("余分な引数は error", () => {
    expect(parseCommand(["init", "sample-goal"]).kind).toBe("error");
  });

  it("知らないオプションは error", () => {
    expect(parseCommand(["init", "--force"]).kind).toBe("error");
  });

  it("--json を受け取る", () => {
    // 出力の指定は --json ひとつにする。--format=json は増やさない。
    expect(parseCommand(["init", "--json"])).toMatchObject({ kind: "init", json: true });
  });

  it("既存のサブコマンドを壊さない", () => {
    expect(parseCommand(["list"])).toEqual({ kind: "list" });
    expect(parseCommand(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseCommand(["get", "sample-goal"])).toEqual({ kind: "show", slug: "sample-goal" });
  });
});

describe("agent-context", () => {
  it("init が載る", () => {
    // エージェントが「何が叩けるか」を散文から推測しないで済むようにする。
    // README と SKILL.md への掲載は tests/docs-contract.test.ts が見る。
    const names = agentContextPayload().commands.map((command) => command.name);

    expect(names).toContain("init");
  });
});

describe("何も無いリポジトリで叩く", () => {
  beforeEach(async () => {
    await makeGitRepo(repoRoot);
  });

  it("終了コード 0 で返る", async () => {
    expect(await main(["init"])).toBe(0);
  });

  it(".goals/ を作る", async () => {
    await main(["init"]);

    expect(existsSync(join(repoRoot, ".goals"))).toBe(true);
  });

  it(".gitignore に .goals/.state/ を足す", async () => {
    // 足し忘れると、状態 DB と worktree と Agent の生ログが対象リポジトリの
    // git に載る。gitignore 済みであることは controller の前提になっている。
    await main(["init"]);

    expect(ignoreLines()).toHaveLength(1);
  });

  it("Goal YAML の雛形を1本置く", async () => {
    await main(["init"]);

    expect(goalFiles()).toHaveLength(1);
  });

  it("雛形はスキーマとして妥当で、ファイル名と goal.id が一致する", async () => {
    // 読んで埋められる形にする。`desired_state` と criteria は人間が書くものだが、
    // スキーマから外れたものを置くと、埋める前に何が悪いのかを調べることになる。
    // loadGoalFile はファイル名の slug と goal.id の突き合わせまで見る。
    await main(["init"]);

    const file = goalFiles()[0] ?? "";
    expect(() => loadGoalFile(join(repoRoot, ".goals", file))).not.toThrow();
  });

  it("--json を付ければ JSON を出す", async () => {
    await main(["init", "--json"]);

    expect(() => JSON.parse(stdout.at(-1) ?? "")).not.toThrow();
  });

  it("既にある .gitignore の内容を消さない", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\ndist/\n");

    await main(["init"]);

    const body = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(body).toContain("node_modules/");
    expect(body).toContain("dist/");
  });
});

describe("2度目に叩く", () => {
  beforeEach(async () => {
    await makeGitRepo(repoRoot);
    await main(["init"]);
  });

  it("終了コード 0 で返る", async () => {
    expect(await main(["init"])).toBe(0);
  });

  it("既にある Goal YAML を上書きしない", async () => {
    // 人間が埋めた宣言部を、2度目の init が白紙に戻すと取り返しがつかない。
    const file = goalFiles()[0] ?? "";
    const path = join(repoRoot, ".goals", file);
    const edited = `${readFileSync(path, "utf8")}\n# 人間が書き足した行\n`;
    writeFileSync(path, edited);

    await main(["init"]);

    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("Goal YAML を増やさない", async () => {
    await main(["init"]);

    expect(goalFiles()).toHaveLength(1);
  });

  it("gitignore の行を二重に足さない", async () => {
    await main(["init"]);

    expect(ignoreLines()).toHaveLength(1);
  });
});

describe("git リポジトリでない場所で叩く", () => {
  it("終了コード 1 で断る", async () => {
    // `.goals/.state/` の gitignore が意味を持たないし、controller は worktree を
    // 作れない。argv は妥当なので 2 ではない。打ち直しても通らない。
    expect(await main(["init"])).toBe(1);
  });

  it("何も作らない", async () => {
    await main(["init"]);

    expect(existsSync(join(repoRoot, ".goals"))).toBe(false);
    expect(existsSync(join(repoRoot, ".gitignore"))).toBe(false);
  });
});

describe("既に Goal があるリポジトリで叩く", () => {
  it("既存の Goal YAML を消さない", async () => {
    // この repo のルートで叩かれても壊れないこと。
    await makeGitRepo(repoRoot);
    mkdirSync(join(repoRoot, ".goals"), { recursive: true });
    writeFileSync(join(repoRoot, ".goals", "existing-goal.yaml"), "version: 1\n");

    await main(["init"]);

    expect(goalFiles()).toContain("existing-goal.yaml");
  });
});
