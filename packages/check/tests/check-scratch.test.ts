import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/check.js";
import { type SampleRepo, sampleRepo, withFakeMise } from "./repo-fixture.js";

/**
 * 切り出しを消せないときの扱い。head のコードは権限を外したディレクトリを残せるが、
 * root では権限を外しても消せてしまうので、消せない状態は `rm` の失敗で作る。
 * 権限を戻す（`chmod`）までは、切り出しの置き場の `rm` が EACCES で落ちる。
 */
const state = vi.hoisted(() => ({ scratchParent: "", locked: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const isScratch = (path: string) =>
    state.scratchParent !== "" && dirname(path) === state.scratchParent;
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const dir = await actual.mkdtemp(...args);
      if (isScratch(dir)) state.locked.add(dir);
      return dir;
    },
    chmod: async (path: string, mode: number) => {
      state.locked.delete(String(path));
      return actual.chmod(path, mode);
    },
    rm: async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
      if (state.locked.has(String(path))) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actual.rm(path, options);
    },
  };
});

describe("切り出しの後始末", () => {
  let restore: () => void;
  let repo: SampleRepo;
  const originalTmpdir = process.env.TMPDIR;
  const scratchParent = mkdtempSync(join(tmpdir(), "ent-check-scratch-"));
  beforeAll(() => {
    restore = withFakeMise();
    repo = sampleRepo(() => undefined);
    // 検査の切り出しだけをこの置き場に作らせ、消えたかを数える
    process.env.TMPDIR = scratchParent;
    state.scratchParent = scratchParent;
  });
  afterAll(() => {
    restore();
    process.env.TMPDIR = originalTmpdir;
    state.scratchParent = "";
    repo.cleanup();
    rmSync(scratchParent, { recursive: true, force: true });
  });

  it("消せない切り出しを残されても、報告を返し、権限を戻して消す", async () => {
    const report = await runCheck({
      repoDir: repo.dir,
      repo: "example-owner/sample-shop",
      pr: null,
      base: repo.base,
      head: repo.head,
      task: "verify",
      timeoutMs: 60_000,
      now: () => new Date("2000-01-31T00:00:00Z"),
    });

    expect(report.head_sha).toBe(repo.head);
    expect(readdirSync(scratchParent)).toEqual([]);
  });
});
