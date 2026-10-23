import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths } from "../src/git.js";
import { git } from "./repo-fixture.js";

describe("changedPaths", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** `files` を commit し、`change` を当ててもう1つ commit する */
  function twoCommits(files: Record<string, string>, change: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "ent-check-git-"));
    roots.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "from"]);
    const from = git(dir, ["rev-parse", "HEAD"]).trim();
    change(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "to"]);
    return { dir, from, to: git(dir, ["rev-parse", "HEAD"]).trim() };
  }

  const body = Array.from({ length: 20 }, (_, i) => `expect(add(${i}, 1)).toBe(${i + 1});`).join(
    "\n",
  );

  it("rename は古い側を previousPath に持つ1件にまとめる", async () => {
    const repo = twoCommits({ "tests/a.test.ts": body }, (dir) => {
      git(dir, ["mv", "tests/a.test.ts", "tests/b.test.ts"]);
    });

    await expect(changedPaths(repo.dir, repo.from, repo.to)).resolves.toEqual([
      { path: "tests/b.test.ts", previousPath: "tests/a.test.ts", deleted: false },
    ]);
  });

  it("消したファイルは deleted にし、足したファイルはそのまま並べる", async () => {
    const repo = twoCommits({ "tests/a.test.ts": body, "src/x.ts": "export {};\n" }, (dir) => {
      git(dir, ["rm", "-q", "src/x.ts"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "y.ts"), "export const y = 1;\n");
    });

    await expect(changedPaths(repo.dir, repo.from, repo.to)).resolves.toEqual([
      { path: "src/x.ts", deleted: true },
      { path: "src/y.ts", deleted: false },
    ]);
  });

  it("ファイルを写しても、写し元を消えたことにしない", async () => {
    // diff.renames=copies を設定したリポジトリでも、写した側は足したファイルとして並ぶ。
    const repo = twoCommits({ "tests/a.test.ts": body }, (dir) => {
      writeFileSync(join(dir, "tests", "b.test.ts"), body);
      writeFileSync(join(dir, "tests", "a.test.ts"), `${body}\n// touched\n`);
    });
    git(repo.dir, ["config", "diff.renames", "copies"]);
    const changes = await changedPaths(repo.dir, repo.from, repo.to);

    expect(changes).toContainEqual({ path: "tests/a.test.ts", deleted: false });
    expect(changes.find((change) => change.path === "tests/b.test.ts")).toEqual({
      path: "tests/b.test.ts",
      deleted: false,
    });
  });
});
