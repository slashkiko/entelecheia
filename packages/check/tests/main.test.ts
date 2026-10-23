import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceReportSchema } from "@entelecheia/core/factory/evidence-report.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { type SampleRepo, sampleRepo, withFakeMise } from "./repo-fixture.js";

/**
 * `ent-check` の終了コード・stdout・`--out` の契約。ワークフローはこれだけを見て
 * ジョブの色と job summary を決める。
 */
describe("ent-check の終了コード", () => {
  let restore: () => void;
  const repos: SampleRepo[] = [];
  const out = mkdtempSync(join(tmpdir(), "ent-check-out-"));
  let stdout: string[];
  beforeAll(() => {
    restore = withFakeMise();
  });
  afterAll(() => {
    restore();
    for (const repo of repos) repo.cleanup();
    rmSync(out, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture() {
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  }

  function args(repo: SampleRepo, file: string, head = repo.head): string[] {
    return [
      "--repo",
      "example-owner/sample-shop",
      "--dir",
      repo.dir,
      "--base",
      repo.base,
      "--head",
      head,
      "--out",
      join(out, file),
    ];
  }

  it("落ちた規則が無ければ 0。stdout と --out に同じ evidence.json を書く", async () => {
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();

    await expect(main(args(repo, "pass.json"))).resolves.toBe(0);
    const written = readFileSync(join(out, "pass.json"), "utf8");
    expect(stdout.join("")).toBe(written);
    expect(evidenceReportSchema.parse(JSON.parse(written)).head_sha).toBe(repo.head);
  });

  it("規則が落ちれば 1", async () => {
    const repo = sampleRepo((dir) => {
      const price = join(dir, "src", "price.mjs");
      writeFileSync(
        price,
        readFileSync(price, "utf8").replace("Math.round(price * (1 - rate))", "price"),
      );
    });
    repos.push(repo);
    capture();

    await expect(main(args(repo, "fail.json"))).resolves.toBe(1);
    expect(existsSync(join(out, "fail.json"))).toBe(true);
  });

  it("引数の誤りは 2", async () => {
    capture();

    await expect(main(["--repo", "example-owner/sample-shop"])).resolves.toBe(2);
  });

  it("検査できなければ 3 で、evidence.json を書かない", async () => {
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();

    await expect(main(args(repo, "unavailable.json", "0".repeat(40)))).resolves.toBe(3);
    expect(existsSync(join(out, "unavailable.json"))).toBe(false);
    expect(stdout.join("")).toBe("");
  });

  it("--out に書けなければ 3。判断は stdout に残す", async () => {
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();

    await expect(main(args(repo, join("missing", "evidence.json")))).resolves.toBe(3);
    expect(evidenceReportSchema.parse(JSON.parse(stdout.join(""))).head_sha).toBe(repo.head);
  });

  it("--dir がリポジトリの下のディレクトリでも、最上位で検査する", async () => {
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();
    const argv = args(repo, "subdir.json");
    argv[argv.indexOf("--dir") + 1] = join(repo.dir, "src");

    await expect(main(argv)).resolves.toBe(0);
  });
});
