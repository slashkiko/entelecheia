import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readReports, runTask } from "../src/run-task.js";
import { withFakeMise } from "./repo-fixture.js";

// 権限を外したファイルは root では読めてしまうので、読めない報告は読み取りの失敗で作る。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) =>
      String(path).endsWith("unreadable.xml")
        ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
        : (actual.readFile as (...args: unknown[]) => Promise<unknown>)(
            path,
            ...rest,
          )) as typeof actual.readFile,
  };
});

describe("readReports", () => {
  const dirs: string[] = [];
  const reportDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ent-check-reports-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("JUnit のタグが無い .xml だけなら、報告は無い", async () => {
    // 数えると、中身の無い .xml を置くだけで「報告がある」になる。
    const dir = reportDir();
    writeFileSync(join(dir, "junit.xml"), "not a report");

    await expect(readReports(dir)).resolves.toBeNull();
  });

  it("JUnit の報告と並んでいれば、報告だけを読む", async () => {
    const dir = reportDir();
    writeFileSync(join(dir, "a.xml"), "not a report");
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "nested", "b.xml"),
      '<testsuites><testcase classname="c" name="one"/></testsuites>',
    );

    await expect(readReports(dir)).resolves.toEqual([{ name: "one", skipped: false }]);
  });

  it("読めない報告があっても投げず、読めた報告だけを返す", async () => {
    // 投げると検査全体が「検査できなかった」になり、head の不合格を head の側で取り消せる。
    const dir = reportDir();
    writeFileSync(join(dir, "unreadable.xml"), "<testsuites></testsuites>");
    writeFileSync(join(dir, "z.xml"), '<testsuites><testcase name="one"/></testsuites>');

    await expect(readReports(dir)).resolves.toEqual([{ name: "one", skipped: false }]);
  });

  it("空の報告は、0件の報告として読む", async () => {
    const dir = reportDir();
    writeFileSync(join(dir, "junit.xml"), "<testsuites></testsuites>");

    await expect(readReports(dir)).resolves.toEqual([]);
  });
});

describe("runTask", () => {
  let restore: () => void;
  const dirs: string[] = [];
  beforeAll(() => {
    restore = withFakeMise();
  });
  afterAll(() => {
    restore();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("道具を入れた時間は、タスクの時間の上限から引く", async () => {
    // 上限 1.5 秒のうち 1 秒を install が使うと、1 秒かかるタスクは残りの時間に収まらない。
    const dir = mkdtempSync(join(tmpdir(), "ent-check-task-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "mise.toml"),
      "# fake-mise: install takes 1000\n[tasks.verify]\nrun = 'sleep 1'\n",
    );

    await expect(
      runTask({ cwd: dir, task: "verify", reportDir: dir, timeoutMs: 1500 }),
    ).resolves.toEqual({ type: "timed_out" });
  });
});
