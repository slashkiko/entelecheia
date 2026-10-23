import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceReportSchema } from "@entelecheia/core/factory/evidence-report.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CheckOptions, passed, runCheck } from "../src/check.js";
import { CheckUnavailable } from "../src/run-task.js";
import { FIXTURE, git, type SampleRepo, sampleRepo, withFakeMise } from "./repo-fixture.js";

const NOW = new Date("2000-01-02T03:04:05Z");
/** fixture の verify のタスク（mise.toml の run の行）。base を書き換えるテストが前後に足す */
const FIXTURE_VERIFY = (() => {
  const run = /^run = '(.*)'$/m.exec(readFileSync(join(FIXTURE, "mise.toml"), "utf8"))?.[1];
  if (run === undefined) throw new Error("known-bad/fixture/mise.toml has no verify task");
  return run;
})();

function options(repo: SampleRepo, overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    repoDir: repo.dir,
    repo: "example-owner/sample-shop",
    pr: 7,
    base: repo.base,
    head: repo.head,
    task: "verify",
    timeoutMs: 60_000,
    now: () => NOW,
    ...overrides,
  };
}

/** base の verify のタスクを書き換える。単引用符の中に置くので、`'` は使えない */
function baseVerify(run: string) {
  return (dir: string) => {
    writeFileSync(join(dir, "mise.toml"), `[tasks.verify]\nrun = '${run}'\n`);
  };
}

describe("runCheck", () => {
  let restore: () => void;
  const repos: SampleRepo[] = [];
  const track = (repo: SampleRepo) => {
    repos.push(repo);
    return repo;
  };
  beforeAll(() => {
    restore = withFakeMise();
  });
  afterAll(() => {
    restore();
    for (const repo of repos) repo.cleanup();
  });

  it("変更の無い head は合格で、evidence.json の形を満たす", async () => {
    const repo = track(sampleRepo(() => undefined));
    const report = await runCheck(options(repo));

    expect(evidenceReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      repo: "example-owner/sample-shop",
      pr: 7,
      head_sha: repo.head,
      base_sha: repo.base,
      check_definition_sha: repo.base,
      level: "E1",
      tests: { before: 7, after: 7, new_skips: 0 },
      generated_at: NOW.toISOString(),
    });
    expect(passed(report)).toBe(true);
  });

  it("head だけにある検査の定義は消してから回す", async () => {
    // head が足した定義が残ると、base の定義より強く効く設定（mise.local.toml など）を
    // 持ち込める。消えていなければ base の verify が落ちる。
    const repo = track(
      sampleRepo(
        (dir) => writeFileSync(join(dir, "verify", "head-only.txt"), "added by the head\n"),
        baseVerify(`test ! -e verify/head-only.txt && ${FIXTURE_VERIFY}`),
      ),
    );

    const report = await runCheck(options(repo));
    expect(report.results.find((result) => result.rule_id === "verify")?.status).toBe("pass");
    // 定義に触れたこと自体は名指しする。head の定義は測っていないので、段階は上がらない。
    expect(
      report.results.find((result) => result.rule_id === "check-definitions-changed"),
    ).toMatchObject({ status: "skip", location: "verify/head-only.txt" });
    expect(passed(report)).toBe(true);
    expect(report.level).toBe("E0");
  });

  it("verify のタスクに資格情報を渡さない", async () => {
    const repo = track(
      sampleRepo(() => undefined, baseVerify(`test -z "$GITHUB_TOKEN" && ${FIXTURE_VERIFY}`)),
    );
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "dummy-token-for-test";
    try {
      expect(passed(await runCheck(options(repo)))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });

  it("テストの報告を書かないリポジトリは、合格でも E1 に届かない", async () => {
    const repo = track(sampleRepo(() => undefined, baseVerify("true")));
    const report = await runCheck(options(repo));

    expect(passed(report)).toBe(true);
    expect(report.level).toBe("E0");
    expect(report.tests).toEqual({ before: null, after: null, new_skips: null });
  });

  it("時間切れの head は不合格にする", async () => {
    const repo = track(
      sampleRepo((dir) =>
        writeFileSync(
          join(dir, "test", "slow.test.mjs"),
          'import { test } from "node:test";\ntest("slow", () => new Promise((done) => setTimeout(done, 60_000)));\n',
        ),
      ),
    );
    // 時間の制限は分岐点にも当たる。遅い環境で分岐点まで時間切れにならないよう、余裕を取る。
    const report = await runCheck(options(repo, { timeoutMs: 10_000 }));

    expect(report.results.find((result) => result.rule_id === "verify")).toMatchObject({
      status: "fail",
    });
    expect(passed(report)).toBe(false);
  }, 60_000);

  it("PR の分岐点を基準にする。後から base に入ったテストで件数を減ったと読まない", async () => {
    const repo = track(sampleRepo(() => undefined));
    // head を切った後で、base にテストを1本足す
    git(repo.dir, ["checkout", "-q", "-b", "later", repo.base]);
    writeFileSync(
      join(repo.dir, "test", "later.test.mjs"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("later", () => assert.ok(1 + 1 === 2));\n',
    );
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-qm", "later"]);
    const later = git(repo.dir, ["rev-parse", "HEAD"]).trim();

    const report = await runCheck(options(repo, { base: later }));

    expect(report.tests).toEqual({ before: 7, after: 7, new_skips: 0 });
    expect(report.base_sha).toBe(later);
    expect(passed(report)).toBe(true);
  });

  it("base の先頭の検査の定義を差し込む。分岐点の後で base に足した正解表も流す", async () => {
    const repo = track(sampleRepo(() => undefined));
    git(repo.dir, ["checkout", "-q", "-b", "later", repo.base]);
    writeFileSync(
      join(repo.dir, "verify", "later.test.mjs"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("later answer", () => assert.equal(1 + 1, 2));\n',
    );
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-qm", "later"]);
    const later = git(repo.dir, ["rev-parse", "HEAD"]).trim();

    const report = await runCheck(options(repo, { base: later }));

    // 分岐点にも head にも無いファイルだが、定義なので両方で流れる。
    expect(report.tests).toEqual({ before: 8, after: 8, new_skips: 0 });
    expect(report.check_definition_sha).toBe(later);
    expect(passed(report)).toBe(true);
  });

  it("base に遅れた PR は、head の不合格ではなく測れなかったにする", async () => {
    // 分岐点の後で、base に正解表のテストとその実装を一緒に足す。base の定義を差し込むと、
    // 分岐点にも head にも実装が無いので、どちらでも落ちる。
    const repo = track(sampleRepo(() => undefined));
    git(repo.dir, ["checkout", "-q", "-b", "later", repo.base]);
    writeFileSync(join(repo.dir, "src", "tax.mjs"), "export const tax = (price) => price * 2;\n");
    writeFileSync(
      join(repo.dir, "verify", "tax.test.mjs"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { tax } from "../src/tax.mjs";\ntest("tax", () => assert.equal(tax(1), 2));\n',
    );
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-qm", "later"]);
    const later = git(repo.dir, ["rev-parse", "HEAD"]).trim();

    const report = await runCheck(options(repo, { base: later }));

    expect(report.results.find((result) => result.rule_id === "verify")?.status).toBe("skip");
    expect(passed(report)).toBe(true);
    expect(report.level).toBe("E0");
  });

  it("テストのファイルを動かしただけなら、弱めたと読まない", async () => {
    const repo = track(
      sampleRepo((dir) => git(dir, ["mv", "test/price.test.mjs", "test/pricing.test.mjs"])),
    );
    const report = await runCheck(options(repo));

    expect(report.results.find((result) => result.rule_id === "test-weakened")?.status).toBe(
      "pass",
    );
  });

  it("テストのファイルを動かして、同時にアサーションを消したら拾う", async () => {
    // 動かす前の中身は、分岐点の古いパスから読む。新しいパスから読むと、分岐点には
    // 無いので数は0になり、減ったと読めない。
    const repo = track(
      sampleRepo((dir) => {
        git(dir, ["mv", "test/price.test.mjs", "test/pricing.test.mjs"]);
        const moved = join(dir, "test", "pricing.test.mjs");
        writeFileSync(
          moved,
          readFileSync(moved, "utf8").replace(
            "  assert.throws(() => discounted(1000, 1), RangeError);\n",
            "",
          ),
        );
      }),
    );
    const report = await runCheck(options(repo));

    expect(report.results.find((result) => result.rule_id === "test-weakened")).toMatchObject({
      status: "fail",
      location: "test/pricing.test.mjs",
    });
  });

  it("base の定義で道具が入らなければ、検査できなかったと言う", async () => {
    const repo = track(
      sampleRepo(
        () => undefined,
        (dir) => {
          const toml = join(dir, "mise.toml");
          writeFileSync(toml, `# fake-mise: install fails\n${readFileSync(toml, "utf8")}`);
        },
      ),
    );

    await expect(runCheck(options(repo))).rejects.toThrow(/mise install failed/);
  });

  it("分岐点で時間切れなら、head の不合格ではなく検査できなかったと言う", async () => {
    const repo = track(sampleRepo(() => undefined, baseVerify("sleep 30")));

    await expect(runCheck(options(repo, { timeoutMs: 1_000 }))).rejects.toThrow(
      /did not finish on the merge base/,
    );
  }, 30_000);

  it("head のコードが元のリポジトリの .git を書き換えても、検査はその後で git を叩かない", async () => {
    // head は同じユーザーで動くので、切り出しの alternates から元の .git を辿れる。
    // core.fsmonitor は git が index を読むたびに呼ぶコマンドで、ここに置かれると
    // 検査の後の git が head の決めたコマンドを流す。
    const marker = join(mkdtempSync(join(tmpdir(), "ent-check-marker-")), "ran");
    const repo = track(
      sampleRepo((dir) =>
        writeFileSync(
          join(dir, "test", "tamper.test.mjs"),
          [
            'import { execFileSync } from "node:child_process";',
            'import { readFileSync } from "node:fs";',
            'import { test } from "node:test";',
            'test("tamper", () => {',
            '  const objects = readFileSync(".git/objects/info/alternates", "utf8").trim();',
            '  const origin = objects.replace(/\\/objects$/, "");',
            `  execFileSync("git", ["--git-dir", origin, "config", "core.fsmonitor", "touch ${marker}"]);`,
            "});",
            "",
          ].join("\n"),
        ),
      ),
    );
    await runCheck(options(repo));

    expect(existsSync(marker)).toBe(false);
    // 書き換え自体は起きている。検査がそれを踏まなかったことを確かめている。
    expect(git(repo.dir, ["config", "--get", "core.fsmonitor"]).trim()).toBe(`touch ${marker}`);
  });

  it("head のコードが元のリポジトリの .git を壊しても、検査は報告を出す", async () => {
    // 検査の後で元のリポジトリの git を叩いていれば、どの呼び出しもここで落ちる。
    const repo = track(
      sampleRepo((dir) =>
        writeFileSync(
          join(dir, "test", "corrupt.test.mjs"),
          [
            'import { appendFileSync, readFileSync } from "node:fs";',
            'import { test } from "node:test";',
            'test("corrupt", () => {',
            '  const objects = readFileSync(".git/objects/info/alternates", "utf8").trim();',
            '  appendFileSync(objects.replace(/\\/objects$/, "/config"), "\\n[broken\\n");',
            "});",
            "",
          ].join("\n"),
        ),
      ),
    );
    const report = await runCheck(options(repo));

    expect(report.results.find((result) => result.rule_id === "verify")?.status).toBe("pass");
    expect(() => git(repo.dir, ["status"])).toThrow();
  });

  it("head の .gitattributes で、書き戻す定義の中身を変えさせない", async () => {
    // 変えられると base の mise.toml が読めない形で書き戻され、「検査できなかった」になる。
    const repo = track(sampleRepo(() => undefined));
    // `git add -A` だと、この属性で mise.toml を読み直して add が落ちる。足すのは1つだけにする
    writeFileSync(join(repo.dir, ".gitattributes"), "mise.toml working-tree-encoding=UTF-16LE\n");
    git(repo.dir, ["add", ".gitattributes"]);
    git(repo.dir, ["commit", "-qm", "attributes"]);
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    const report = await runCheck(options({ ...repo, head }));

    expect(report.results.find((result) => result.rule_id === "verify")?.status).toBe("pass");
  });

  it("元のリポジトリに切り出しの記録を残さない", async () => {
    const repo = track(sampleRepo(() => undefined));
    await runCheck(options(repo));

    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
  });

  it("報告の置き場に .xml の名前のディレクトリを置かれても、検査できなかったにしない", async () => {
    // 投げると「検査できなかった」になり、head の不合格を head の側で取り消せる。
    const repo = track(
      sampleRepo((dir) => {
        writeFileSync(
          join(dir, "test", "decoy.test.mjs"),
          [
            'import { mkdirSync } from "node:fs";',
            'import { test } from "node:test";',
            'test("decoy", () => {',
            "  mkdirSync(`${process.env.ENT_CHECK_REPORT_DIR}/decoy.xml`, { recursive: true });",
            "});",
            "",
          ].join("\n"),
        );
        // 実装も壊す。これが落ちることを確かめる
        const price = join(dir, "src", "price.mjs");
        writeFileSync(
          price,
          readFileSync(price, "utf8").replace("Math.round(price * (1 - rate))", "price"),
        );
      }),
    );
    const report = await runCheck(options(repo));

    expect(report.results.find((result) => result.rule_id === "verify")?.status).toBe("fail");
  });

  it("commit が無ければ、検査できなかったと言う", async () => {
    const repo = track(sampleRepo(() => undefined));

    await expect(runCheck(options(repo, { head: "0".repeat(40) }))).rejects.toBeInstanceOf(
      CheckUnavailable,
    );
  });

  it("mise が無ければ、不合格ではなく検査できなかったと言う", async () => {
    const repo = track(sampleRepo(() => undefined));
    // git だけを置いた PATH。mise-action を通した CI でも本物の mise を拾わない。
    const bin = mkdtempSync(join(tmpdir(), "ent-check-bin-"));
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(gitPath, join(bin, "git"));
    const original = process.env.PATH;
    process.env.PATH = bin;
    try {
      await expect(runCheck(options(repo))).rejects.toBeInstanceOf(CheckUnavailable);
    } finally {
      process.env.PATH = original;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
