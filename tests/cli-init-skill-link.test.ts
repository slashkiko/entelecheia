import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

/**
 * `ent init` が、ent の手順書を Claude Code の skill として引けるようにする。
 *
 * ent は自分の置き場所と対象リポジトリを分けて扱う（`repoRoot = process.cwd()`）。
 * その使い方をしたとき、対象リポジトリで作業しているエージェントは ent の手順書
 * （`.claude/skills/ent/SKILL.md`）を読めない。project scope の skill は ent 本体の
 * リポジトリにあり、対象リポジトリからは見えないため。
 *
 * 同じ skill でも、controller がレビュー役に読ませる `ent-review` は問題にならない。
 * plugin のパスを `import.meta.url` から引いているので、対象リポジトリがどこであっても
 * ent 本体の側で解決される（`src/adapters/claude.ts` の `REVIEW_PLUGIN_DIR`）。
 * **controller が起動する Agent には配布口があり、人間の側のエージェントが読む
 * 手順書にだけ同等の口が無い。**
 *
 * ## なぜ symlink で、なぜ user scope なのか
 *
 * 埋め方は skill のシンボリックリンクにする。**Claude Code は `AGENTS.md` を読まない**
 * ので、そこに在り処を書いてもエージェントには届かない。skill はディレクトリの
 * シンボリックリンクを辿って `SKILL.md` を読む仕様なので、そちらに乗る。
 *
 * 張る先は user scope（`~/.claude/skills/ent`）にする。ent 本体はマシンに1つ入る
 * （`pnpm link --global`）ので、skill の登録も1回で済む形が釣り合う。対象リポジトリの
 * 中に張ると、向け先が ent 本体の絶対パスなのでマシン固有になり、commit すれば
 * 他の人の手元で壊れる。`ent init` を叩いていないリポジトリでも読めるようになる。
 *
 * ## ここで固定するもの
 *
 * `main(["init"])` の終了コードと、`$HOME` 以下と repoRoot のファイルの状態、
 * `--json` の `entries`。**実装の分け方は決めない。**
 *
 * `$HOME` は `beforeEach` で一時ディレクトリに差し替える。`os.homedir()` は `HOME` を
 * 見るので、これで実際の `~/.claude/skills/` を触らずに確かめられる。
 */

const run = promisify(execFile);
const IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

/** ent 本体の skill ディレクトリ。symlink の向け先そのもの */
const SKILL_DIR = fileURLToPath(new URL("../.claude/skills/ent", import.meta.url));

let repoRoot: string;
let home: string;
let cwd: string;
let realHome: string | undefined;
let stdout: string[];

/** user scope の skill の置き場 */
function linkPath(): string {
  return join(home, ".claude", "skills", "ent");
}

/** `--json` の entries から、末尾が `.claude/skills/ent` の1件を引く */
function skillEntry(): { path: string; action: string } | undefined {
  const report = JSON.parse(stdout.at(-1) ?? "{}") as {
    entries?: { path: string; action: string }[];
  };
  return report.entries?.find((entry) => entry.path.endsWith(join(".claude", "skills", "ent")));
}

async function makeGitRepo(dir: string): Promise<void> {
  await run("git", ["init", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# target\n");
  await run("git", [...IDENTITY, "add", "."], { cwd: dir });
  await run("git", [...IDENTITY, "commit", "-m", "init"], { cwd: dir });
}

beforeEach(async () => {
  cwd = process.cwd();
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "ent-home-"));
  process.env.HOME = home;

  repoRoot = mkdtempSync(join(tmpdir(), "ent-init-link-"));
  process.chdir(repoRoot);
  await makeGitRepo(repoRoot);

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
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("skill をまだ張っていないとき", () => {
  it("~/.claude/skills/ent を作る", async () => {
    // 置き場が無ければ作る。`~/.claude/skills/` ごと無いのが初回になる。
    await main(["init"]);

    expect(existsSync(linkPath())).toBe(true);
  });

  it("実体をコピーせず、シンボリックリンクにする", async () => {
    // 写すと、ent 本体を更新しても対象側が古いままになる。正本は1箇所に保つ。
    await main(["init"]);

    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  it("ent 本体の skill ディレクトリを指す", async () => {
    await main(["init"]);

    expect(realpathSync(linkPath())).toBe(realpathSync(SKILL_DIR));
  });

  it("辿った先から SKILL.md を読める", async () => {
    // Claude Code が skill として引くのはこの1ファイルになる。
    await main(["init"]);

    expect(readFileSync(join(linkPath(), "SKILL.md"), "utf8")).toContain("ent");
  });

  it("--json の entries に created で載る", async () => {
    // repoRoot の外に作るものなので、出力に出ないと人間は気づけない。
    await main(["init", "--json"]);

    expect(skillEntry()?.action).toBe("created");
  });

  it("終了コード 0 のままになる", async () => {
    expect(await main(["init"])).toBe(0);
  });

  it("対象リポジトリにファイルを増やさない", async () => {
    // 張るのは user scope だけになる。対象リポジトリに置くと、向け先が
    // マシン固有の絶対パスなので、commit すれば他の人の手元で壊れる。
    await main(["init"]);

    expect(existsSync(join(repoRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(repoRoot, ".claude"))).toBe(false);
  });
});

describe("2度目に叩く", () => {
  beforeEach(async () => {
    await main(["init"]);
  });

  it("終了コード 0 で返る", async () => {
    expect(await main(["init"])).toBe(0);
  });

  it("張り直さない", async () => {
    const before = readlinkSync(linkPath());

    await main(["init"]);

    expect(readlinkSync(linkPath())).toBe(before);
  });

  it("--json の entries に kept と出す", async () => {
    await main(["init", "--json"]);

    expect(skillEntry()?.action).toBe("kept");
  });
});

describe("同じ名前が既に埋まっているとき", () => {
  function makeSkillsDir(): string {
    const dir = join(home, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("別の場所を指す symlink なら、終了コード 1 で断る", async () => {
    // 人間が自分で張ったものを黙って差し替えない。**どちらが正かを決めるのは
    // ent ではない。**
    const other = mkdtempSync(join(tmpdir(), "ent-other-skill-"));
    symlinkSync(other, join(makeSkillsDir(), "ent"));

    try {
      expect(await main(["init"])).toBe(1);
      expect(realpathSync(linkPath())).toBe(realpathSync(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("実体のディレクトリなら、中身を消さずに 1 で断る", async () => {
    const dir = join(makeSkillsDir(), "ent");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "人間が書いた skill\n");

    expect(await main(["init"])).toBe(1);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("人間が書いた skill\n");
  });

  it("断ったときは対象リポジトリにも何も作らない", async () => {
    // 作ってから気づかせない。`.goals/` だけ残ると、次に叩いた人は中途半端な
    // 状態から何を直せばよいのか分からない。
    mkdirSync(join(makeSkillsDir(), "ent"));

    await main(["init"]);

    expect(existsSync(join(repoRoot, ".goals"))).toBe(false);
  });
});

describe("既存の init の振る舞いを変えない", () => {
  it(".goals/ と雛形と gitignore の行は今までどおり置く", async () => {
    await main(["init"]);

    const goals = readdirSync(join(repoRoot, ".goals")).filter((name) => name.endsWith(".yaml"));
    expect(goals).toHaveLength(1);
    expect(readFileSync(join(repoRoot, ".gitignore"), "utf8")).toContain(".goals/.state");
  });

  it("git リポジトリでなければ、skill も張らずに 1 で断る", async () => {
    // 断る条件は今までどおり。**断ったのに $HOME だけ書き換わる、を作らない。**
    const bare = mkdtempSync(join(tmpdir(), "ent-not-a-repo-"));
    process.chdir(bare);

    try {
      expect(await main(["init"])).toBe(1);
      expect(existsSync(resolve(home, ".claude", "skills", "ent"))).toBe(false);
    } finally {
      process.chdir(repoRoot);
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
