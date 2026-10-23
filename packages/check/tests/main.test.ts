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
import { evidenceReportSchema } from "@entelecheia/core/factory/evidence-report.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { MAX_OBSERVATIONS_BYTES, observationsSchema } from "../src/observations.js";
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

  it("--checker-sha を evidence.json の checker_sha に残す", async () => {
    // governor はこの値を、run が呼んだ検査の sha と比べる。落とすと、どの報告も受け取られない
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();
    const checker = "e".repeat(40);

    await main([...args(repo, "checker.json"), "--checker-sha", checker]);
    const written = JSON.parse(readFileSync(join(out, "checker.json"), "utf8"));
    expect(evidenceReportSchema.parse(written).checker_sha).toBe(checker);
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

  it("--out は書き終えてから名前を付ける。名前を付けられなければ書きかけを残さない", async () => {
    // ワークフローは --out のファイルがあれば ent-check の判断として扱い、トークンを付ける
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();
    mkdirSync(join(out, "taken"));

    await expect(main(args(repo, "taken"))).resolves.toBe(3);
    expect(readdirSync(out).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("流している間だけ SIGINT と SIGTERM を受ける", async () => {
    // 受けないと、取り消されたときに verify の子と切り出しが残る（cleanup.ts）
    const repo = sampleRepo(() => undefined);
    repos.push(repo);
    capture();
    const before = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
    const on = vi.spyOn(process, "on");

    await main(args(repo, "signals.json"));
    expect(on.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(["SIGINT", "SIGTERM"]),
    );
    expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  describe("観測と判定を分けて流す", () => {
    function commits(repo: SampleRepo): string[] {
      return ["--dir", repo.dir, "--base", repo.base, "--head", repo.head];
    }

    async function observeTo(repo: SampleRepo, file: string): Promise<number> {
      return main(["--observe", ...commits(repo), "--out", join(out, file)]);
    }

    function judgeArgs(repo: SampleRepo, observations: string, file: string): string[] {
      return [
        "--observations",
        join(out, observations),
        "--repo",
        "example-owner/sample-shop",
        ...commits(repo),
        "--out",
        join(out, file),
      ];
    }

    function withoutTime(json: string) {
      const { generated_at: _time, ...rest } = evidenceReportSchema.parse(JSON.parse(json));
      return rest;
    }

    it("--observe で書いた観測から、1つのプロセスで流したときと同じ報告を作る", async () => {
      const repo = sampleRepo(() => undefined);
      repos.push(repo);
      capture();

      await expect(observeTo(repo, "observed.json")).resolves.toBe(0);
      const observed = observationsSchema.parse(
        JSON.parse(readFileSync(join(out, "observed.json"), "utf8")),
      );
      expect(observed).toMatchObject({ base_sha: repo.base, head_sha: repo.head });

      await expect(main(judgeArgs(repo, "observed.json", "judged.json"))).resolves.toBe(0);
      await expect(main(args(repo, "whole.json"))).resolves.toBe(0);
      expect(withoutTime(readFileSync(join(out, "judged.json"), "utf8"))).toEqual(
        withoutTime(readFileSync(join(out, "whole.json"), "utf8")),
      );
    });

    it("--observe は、head の verify が落ちても 0 で終わる。判定は観測を読む側が出す", async () => {
      const repo = sampleRepo((dir) => {
        const price = join(dir, "src", "price.mjs");
        writeFileSync(
          price,
          readFileSync(price, "utf8").replace("Math.round(price * (1 - rate))", "price"),
        );
      });
      repos.push(repo);
      capture();

      await expect(observeTo(repo, "observed-fail.json")).resolves.toBe(0);
      await expect(main(judgeArgs(repo, "observed-fail.json", "judged-fail.json"))).resolves.toBe(
        1,
      );
    });

    it("別の commit を流した観測は、検査できなかった（3）にする", async () => {
      // head のジョブは観測を差し替えられる。別の PR の観測を持ち込んでも受け取らない
      const repo = sampleRepo(() => undefined);
      const other = sampleRepo((dir) => writeFileSync(join(dir, "note.txt"), "other\n"));
      repos.push(repo, other);
      capture();

      await expect(observeTo(other, "other.json")).resolves.toBe(0);
      await expect(main(judgeArgs(repo, "other.json", "mismatch.json"))).resolves.toBe(3);
      expect(existsSync(join(out, "mismatch.json"))).toBe(false);
    });

    it.each(["base_sha", "head_sha", "fork_sha"])(
      "観測の %s が自分で解いた sha と違えば、検査できなかった（3）にする",
      async (key) => {
        const repo = sampleRepo(() => undefined);
        repos.push(repo);
        capture();
        const stderr = vi.mocked(process.stderr.write);
        await expect(observeTo(repo, `sha-${key}.json`)).resolves.toBe(0);
        const observed = JSON.parse(readFileSync(join(out, `sha-${key}.json`), "utf8"));
        writeFileSync(
          join(out, `sha-${key}.json`),
          JSON.stringify({ ...observed, [key]: "0".repeat(40) }),
        );

        await expect(main(judgeArgs(repo, `sha-${key}.json`, `sha-${key}-out.json`))).resolves.toBe(
          3,
        );
        expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
          `the observations are for ${key} ${"0".repeat(40)}`,
        );
      },
    );

    it("分岐点が時間切れの観測は、検査できなかった（3）にする", async () => {
      // --observe はこの観測を書かない。あれば head の側が作ったもの
      const repo = sampleRepo(() => undefined);
      repos.push(repo);
      capture();
      const stderr = vi.mocked(process.stderr.write);
      await expect(observeTo(repo, "timed-out.json")).resolves.toBe(0);
      const observed = JSON.parse(readFileSync(join(out, "timed-out.json"), "utf8"));
      writeFileSync(
        join(out, "timed-out.json"),
        JSON.stringify({ ...observed, baseline: { outcome: { type: "timed_out" }, tests: null } }),
      );

      await expect(main(judgeArgs(repo, "timed-out.json", "timed-out-out.json"))).resolves.toBe(3);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "did not finish on the merge base",
      );
    });

    it.each([
      ["JSON でない", "{", "is not JSON"],
      ["形が違う", JSON.stringify({ schema: "ent.observations/v1" }), "is not observations"],
      // 読み込む前に止める。head のジョブは巨大なファイルを置ける
      ["上限を超える", " ".repeat(MAX_OBSERVATIONS_BYTES + 1), "larger than"],
    ])("観測が%sなら、検査できなかった（3）にする", async (_label, body, message) => {
      const repo = sampleRepo(() => undefined);
      repos.push(repo);
      capture();
      const stderr = vi.mocked(process.stderr.write);
      writeFileSync(join(out, "broken.json"), body);

      await expect(main(judgeArgs(repo, "broken.json", "broken-out.json"))).resolves.toBe(3);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(message);
    });

    it("観測のファイルが無ければ、検査できなかった（3）にする", async () => {
      const repo = sampleRepo(() => undefined);
      repos.push(repo);
      capture();

      await expect(main(judgeArgs(repo, "absent.json", "absent-out.json"))).resolves.toBe(3);
    });
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
