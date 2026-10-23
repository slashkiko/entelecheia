import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isCheckDefinition } from "./definitions.js";
import { checkEnv } from "./env.js";

/**
 * 検査が使う git の操作。git は argv 配列で叩き、シェルを通さない。
 *
 * ブランチ名やパスは head の側、つまり Actor が決められる値になる。シェルに渡すと、
 * `;` や `$()` を含む名前1つで検査のプロセスにコマンドを流し込める（ent の
 * `adapters/local.ts` が同じ理由で argv にしている）。
 *
 * **検査するリポジトリの `.git` は、head のコードを流した後には触らない。** head のコードは
 * 同じユーザーで動くので、`.git` の設定（`core.fsmonitor` など、git が呼ぶコマンド）や
 * `refs/replace` を書き換えられる。差分を読むのは verify を流す前に済ませ、verify は
 * clone で流す。clone は元の object を alternates で読むだけで、設定・参照・hooks は
 * 持たない。replace の参照はどの git の呼び出しでも読まない。
 */

const runFile = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export async function git(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await runFile("git", [...args], {
    cwd,
    env: checkEnv({ GIT_NO_REPLACE_OBJECTS: "1", ...env }),
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * `dir` を含む作業ツリーの最上位。git のリポジトリでなければ null。
 * clone と `ls-tree` はリポジトリの最上位でしか正しく動かないので、下のディレクトリから
 * 呼ばれても最上位に揃える。
 */
export async function workTreeRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

/** rev を commit の完全な sha にする。無ければ null */
export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  // `-` で始まる値を option と読ませない。`--end-of-options` の後ろはすべて引数になる。
  try {
    const sha = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${rev}^{commit}`,
    ]);
    return sha.trim();
  } catch {
    return null;
  }
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repo, ["merge-base", a, b])).trim();
  } catch {
    return null;
  }
}

/** commit に入っているファイルのパス（ディレクトリは入らない） */
export async function filesAt(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ["ls-tree", "-r", "-z", "--name-only", sha]);
  return out.split("\0").filter((path) => path.length > 0);
}

/** commit の中のファイルの中身。無ければ null */
export async function fileAt(repo: string, sha: string, path: string): Promise<string | null> {
  try {
    return await git(repo, ["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}

export interface ChangedPath {
  path: string;
  /** rename の古い側。rename でなければ無い */
  previousPath?: string;
  deleted: boolean;
}

/** `from` から `to` までに変わったファイル。rename は1つにまとめる */
export async function changedPaths(repo: string, from: string, to: string): Promise<ChangedPath[]> {
  // `-l0` は rename の検出に上限を置かない。上限を越えると rename が削除と追加に割れ、
  // テストのファイルを動かしただけで「アサーションが減った」と読める。
  const out = await git(repo, ["diff", "--name-status", "-z", "-M", "-l0", from, to]);
  const fields = out.split("\0").filter((field) => field.length > 0);
  const changes: ChangedPath[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = fields[i + 1] ?? "";
      const path = fields[i + 2] ?? "";
      // copy は古い側を残したまま新しい側を足すので、rename と違って古い側は消えない。
      changes.push(
        status.startsWith("R") ? { path, previousPath, deleted: false } : { path, deleted: false },
      );
      i += 3;
    } else {
      changes.push({ path: fields[i + 1] ?? "", deleted: status.startsWith("D") });
      i += 2;
    }
  }
  return changes;
}

/**
 * `sha` を `dir` に切り出す。worktree ではなく clone にするのは、worktree は元のリポジトリの
 * `.git`（設定・参照・hooks）を共有するため。`--shared` なので object は複製しない。
 * 消すときは `dir` を消すだけでよく、元のリポジトリに記録が残らない。
 */
export async function cloneAt(repo: string, dir: string, sha: string): Promise<void> {
  await git(repo, ["clone", "--quiet", "--shared", "--no-checkout", "--", repo, dir]);
  await git(dir, ["checkout", "--quiet", "--detach", sha]);
}

export interface Overlay {
  /** base から書き戻した検査の定義 */
  restored: string[];
  /** base に無いので消した検査の定義 */
  removed: string[];
}

/**
 * 切り出した `dir` の検査の定義を、`definitionSha` のものに揃える。
 *
 * base にある定義は base の中身で書き戻し、base に無い定義は消す。消さないと、
 * head が足した `mise.local.toml` や入れ子の `vitest.config.ts` のような、base の定義より
 * 強く効く設定が残る。
 */
export async function overlayDefinitions(
  repo: string,
  dir: string,
  ownSha: string,
  definitionSha: string,
  scratch: string,
): Promise<Overlay> {
  const [own, definitions] = await Promise.all([
    filesAt(repo, ownSha).then((paths) => paths.filter(isCheckDefinition)),
    filesAt(repo, definitionSha).then((paths) => paths.filter(isCheckDefinition)),
  ]);
  const kept = new Set(definitions);
  const removed = own.filter((path) => !kept.has(path));
  for (const path of removed) {
    await rm(join(dir, path), { force: true, recursive: true });
  }
  if (definitions.length > 0) {
    // 書き戻すときの変換を止める。head の .gitattributes は差し替えの対象ではないので、
    // `mise.toml working-tree-encoding=UTF-16LE` のような行を置かれると、base の定義が
    // 読めない形で書き戻され、道具が入らずに「検査できなかった」になる。
    // `info/attributes` は .gitattributes より優先される。
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    await writeFile(
      join(dir, ".git", "info", "attributes"),
      "* -text -filter -ident !eol !working-tree-encoding\n",
    );
    // パスは head が決めた名前を含みうるので、引数ではなくファイルで渡し、
    // glob や `:(magic)` として読ませない。
    const pathspec = join(scratch, "definitions.pathspec");
    await writeFile(pathspec, `${definitions.join("\0")}\0`);
    await git(
      dir,
      ["checkout", definitionSha, `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"],
      { GIT_LITERAL_PATHSPECS: "1" },
    );
  }
  return { restored: definitions, removed };
}
