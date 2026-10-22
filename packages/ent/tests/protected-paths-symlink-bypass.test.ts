import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findViolations } from "../src/domain/protected-paths.js";

/**
 * 本体リポジトリ側の表示用キーを、worktree を基点に解決してはいけない。
 *
 * `guardedDecision` は状態 DB の論理ダイジェストが動いたことを
 * `.goals/.state/goals.db` という **repoRoot 相対の文字列**で渡す。関門はそれを
 * worktree の root へ `resolve` して `realpathSync` に通していた。基点が違ううえ、
 * 解決の結果が **Agent が握っている FS の状態に依存する。**
 *
 * worktree の中に `.goals/.state/goals.db -> ../../package.json` を1つ置けば、
 * キーは `package.json` へ解決され、`.goals/**` に一致しなくなる。そのうえで本体側の
 * `goals.db` を直接書き換えても、違反は1件も出ない。`guard_base_sha` を worktree の
 * HEAD にすれば、以後どのティックでも差分が空になり、関門は恒久的に目を潰される。
 * 依存 Goal の status を `COMPLETED` にすれば `dependencyGate` も開く。
 *
 * symlink を置いたこと自体も見えない。`.goals/.state/` は gitignore 済みで
 * `changedPaths` に出ず、仮に出ても `origin: "worktree"` では `isRuntimeState` が
 * 落とす。つまり **仕掛けと実行の両方が同じ ACT の窓に収まり、どちらも観測されない。**
 *
 * 既存の `tests/protected-paths-state-dir.test.ts` は正しい振る舞いを固定していたが、
 * `ROOT` が実在しないパスなので `realpathSync` が必ず throw し、元の文字列に落ちて
 * 素通りしていた。**この穴が出荷されたのは、テストが FS を1度も触らなかったため。**
 * ここは実際にディレクトリを掘り、symlink を置いて確かめる。
 */

const PROTECTED = ["src/controller/**", ".goals/**", ".git/**"];
const STATE_DB_KEY = ".goals/.state/goals.db";

let root = "";

beforeEach(() => {
  // realpath を通しておく。macOS の /var は /private/var への symlink なので、
  // 揃えないと `origin: "worktree"` の解決で基点がずれる。
  root = realpathSync(mkdtempSync(join(tmpdir(), "ent-guard-symlink-")));
  // symlink の実体になる、保護パスに一致しないファイル。
  writeFileSync(join(root, "package.json"), "{}\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Agent が worktree の中に仕掛ける symlink */
function plantSymlink(key: string, target: string): void {
  const link = join(root, key);
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(target, link);
}

describe("worktree の symlink で、本体側の表示用キーの照合を外せない", () => {
  it("symlink が無ければ、これまでどおり違反になる", () => {
    expect(findViolations([STATE_DB_KEY], root, PROTECTED, "repo_root")).toEqual([
      { kind: "protected_path", path: STATE_DB_KEY, pattern: ".goals/**" },
    ]);
  });

  it("同じ名前の symlink を置かれても違反のまま", () => {
    // これが本体。以前はここが `[]` になり、状態 DB の改竄が素通りしていた。
    plantSymlink(STATE_DB_KEY, "../../package.json");

    expect(findViolations([STATE_DB_KEY], root, PROTECTED, "repo_root")).toEqual([
      { kind: "protected_path", path: STATE_DB_KEY, pattern: ".goals/**" },
    ]);
  });

  it("worktree の外を指す symlink でも違反のまま", () => {
    // 解決すれば `escaped_worktree` に化ける経路。kind が変わると、人間に届く
    // 説明が「保護パスを編集した」から「worktree の外を編集した」にすり替わる。
    plantSymlink(STATE_DB_KEY, "/etc/hosts");

    expect(findViolations([STATE_DB_KEY], root, PROTECTED, "repo_root")).toEqual([
      { kind: "protected_path", path: STATE_DB_KEY, pattern: ".goals/**" },
    ]);
  });

  it("`.git` が実ディレクトリでも hooks のキーは違反のまま", () => {
    // linked worktree の `.git` は gitdir を指すファイルなので `realpathSync` が
    // throw し、hooks のキーは偶然すり抜けていなかった。偶然に頼らない。
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync("../../package.json", join(root, ".git", "hooks", "pre-push"));

    expect(findViolations([".git/hooks/pre-push"], root, PROTECTED, "repo_root")).toEqual([
      { kind: "protected_path", path: ".git/hooks/pre-push", pattern: ".git/**" },
    ]);
  });

  it("ファイルですらない合成キーも違反のまま", () => {
    // `core.hooksPath` は `#` で設定項目を指すキーで、解決する対象が無い。
    expect(findViolations([".git/config#core.hooksPath"], root, PROTECTED, "repo_root")).toEqual([
      { kind: "protected_path", path: ".git/config#core.hooksPath", pattern: ".git/**" },
    ]);
  });

  it("保護パスに一致しない表示用キーは、これまでどおり違反にしない", () => {
    // 文字列で照合する側に倒しても、保護の範囲は広がらない。
    expect(findViolations(["dist/cli.js"], root, PROTECTED, "repo_root")).toEqual([]);
  });
});

describe("worktree 側の判定は、実在するディレクトリでも変わらない", () => {
  it("Agent が置いた実行時状態の一時ファイルで止まらない", () => {
    mkdirSync(join(root, ".goals", ".state", "tmp"), { recursive: true });
    writeFileSync(join(root, ".goals", ".state", "tmp", "read.ts"), "");

    expect(findViolations([join(root, ".goals/.state/tmp/read.ts")], root, PROTECTED)).toEqual([]);
  });

  it("worktree の中の symlink で保護パスを外すこともできない", () => {
    // `origin: "worktree"` 側は実パスに解決してから見る。ここは従来どおり。
    // root は realpath 済みにしてある（macOS の /var は /private/var への symlink で、
    // 揃えないと解決の前後で基点がずれる）。
    mkdirSync(join(root, "src", "controller"), { recursive: true });
    writeFileSync(join(root, "src", "controller", "index.ts"), "");
    symlinkSync(join(root, "src", "controller"), join(root, "shortcut"));

    const artifact = join(root, "shortcut/index.ts");

    expect(findViolations([artifact], root, PROTECTED)).toEqual([
      { kind: "protected_path", path: artifact, pattern: "src/controller/**" },
    ]);
  });
});
