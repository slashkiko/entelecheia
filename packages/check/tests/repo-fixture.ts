import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * テストが使う一時リポジトリ。known-bad の作り物のリポジトリ（`known-bad/fixture/`）を
 * base として commit し、見本の差分を head として commit する。
 */

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURE = join(ROOT, "known-bad", "fixture");
/** テスト用の偽の mise の置き場。PATH の先頭に置く */
export const FAKE_BIN = fileURLToPath(new URL("./fakes/bin", import.meta.url));

export function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

export interface SampleRepo {
  dir: string;
  base: string;
  head: string;
  cleanup: () => void;
}

/** fixture を base にし、`change` を当てて head にする。`prepare` は base を commit する前に当てる */
export function sampleRepo(
  change: (dir: string) => void,
  prepare: (dir: string) => void = () => undefined,
): SampleRepo {
  const root = mkdtempSync(join(tmpdir(), "ent-check-test-"));
  const dir = join(root, "repo");
  cpSync(FIXTURE, dir, { recursive: true });
  prepare(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  change(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "head", "--allow-empty"]);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  return { dir, base, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 偽の mise を PATH の先頭に置く。戻り値で元に戻す */
export function withFakeMise(): () => void {
  const original = process.env.PATH;
  process.env.PATH = `${FAKE_BIN}:${original ?? ""}`;
  return () => {
    process.env.PATH = original;
  };
}
