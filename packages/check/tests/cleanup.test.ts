import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observe } from "../src/check.js";
import { exitOnInterrupt, trackGroup, trackScratch } from "../src/cleanup.js";
import { runTask } from "../src/run-task.js";
import { sampleRepo, withFakeMise } from "./repo-fixture.js";

/**
 * 止められたときの後始末。Actions がジョブを取り消すと SIGINT か SIGTERM が届く。
 * 既定のまま終わると、verify の子のグループは動き続け、切り出しも残る。
 */
describe("止められたときの後始末", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.restoreAllMocks();
  });

  function prepare() {
    // verify の子と同じく、別のプロセスグループに立てる
    const child = spawn("sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
    const scratch = mkdtempSync(join(tmpdir(), "ent-check-cleanup-"));
    mkdirSync(join(scratch, "head"));
    writeFileSync(join(scratch, "head", "left-by-the-head.txt"), "x\n");
    stops.push(trackGroup(child.pid as number), trackScratch(scratch));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stops.push(exitOnInterrupt());
    return { child, scratch, exit };
  }

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "%s を受けたら、子のグループを止め、切り出しを消して %i で終わる",
    async (signal, code) => {
      const { child, scratch, exit } = prepare();
      const exited = once(child, "exit");

      process.emit(signal, signal);

      expect(exit).toHaveBeenCalledWith(code);
      expect(existsSync(scratch)).toBe(false);
      expect(await exited).toEqual([null, "SIGKILL"]);
    },
  );

  it("verify を流している間に止められたら、その子のグループも止める", async () => {
    const restore = withFakeMise();
    stops.push(restore);
    const dir = mkdtempSync(join(tmpdir(), "ent-check-cleanup-task-"));
    stops.push(() => rmSync(dir, { recursive: true, force: true }));
    const started = join(dir, "started");
    writeFileSync(join(dir, "mise.toml"), `[tasks.verify]\nrun = 'touch started; sleep 30'\n`);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stops.push(exitOnInterrupt());

    const task = runTask({ cwd: dir, task: "verify", reportDir: dir, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    process.emit("SIGTERM", "SIGTERM");

    // 止めなければ sleep 30 が終わるまで返らない
    await expect(task).resolves.toMatchObject({ type: "exited" });
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("観測している間に止められたら、切り出しをその場で消す", async () => {
    stops.push(withFakeMise());
    // 分岐点の verify だけが待つ。head の側はすぐ終わり、テストを長くしない
    const repo = sampleRepo(
      () => undefined,
      (dir) =>
        writeFileSync(
          join(dir, "mise.toml"),
          `[tasks.verify]\nrun = 'touch "$ENT_CHECK_REPORT_DIR/started"; case "$ENT_CHECK_REPORT_DIR" in */baseline) sleep 30 ;; esac'\n`,
        ),
    );
    stops.push(repo.cleanup);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stops.push(exitOnInterrupt());

    const task = observe({
      repoDir: repo.dir,
      base: repo.base,
      head: repo.head,
      task: "verify",
      timeoutMs: 60_000,
    });
    let scratch = "";
    await vi.waitFor(
      () => {
        const found = readdirSync(tmpdir())
          .map((name) => join(tmpdir(), name))
          .find((dir) => existsSync(join(dir, "reports", "baseline", "started")));
        expect(found).toBeDefined();
        scratch = found as string;
      },
      { timeout: 10_000 },
    );
    process.emit("SIGTERM", "SIGTERM");

    // observe の finally を待たずに消えている。本物の process.exit なら finally は流れない
    expect(existsSync(scratch)).toBe(false);
    expect(exit).toHaveBeenCalledWith(143);
    await task.catch(() => undefined);
  });

  it("やめた後はシグナルを受けない", () => {
    const before = process.listenerCount("SIGTERM");
    const stop = exitOnInterrupt();

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
