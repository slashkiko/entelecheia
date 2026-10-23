import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_ARTIFACT_NAME,
  EVIDENCE_FILE_NAME,
} from "@entelecheia/core/factory/evidence-report.js";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ROOT } from "./repo-fixture.js";

/**
 * 再利用ワークフロー（`.github/workflows/check.yml`）のシェルを、Actions の外で流す。
 * actionlint と zizmor は書き方を見るだけなので、event の関門・sha の関門・時間の上限・
 * 終了コードの読み分けが変わっても気づかない。
 *
 * Actions と同じく `bash -eo pipefail` で流し、`${{ }}` の値は env で渡す。
 */
interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}

const workflow = parse(readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8")) as {
  jobs: { check: { steps: Step[] } };
};

function script(name: string): string {
  const run = workflow.jobs.check.steps.find((step) => step.name === name)?.run;
  if (run === undefined) throw new Error(`check.yml has no step named ${name}`);
  return run;
}

const scratch = mkdtempSync(join(tmpdir(), "ent-check-workflow-"));

function runStep(name: string, env: Record<string, string>) {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script(name)],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

describe("check.yml のシェル", () => {
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("run の中に式を直に書かない（値は env で渡す）", () => {
    for (const step of workflow.jobs.check.steps) {
      expect(step.run ?? "").not.toContain("${{");
    }
  });

  it.each([
    ["pull_request", 0],
    ["pull_request_target", 2],
    ["push", 2],
  ])("event が %s なら %i で終わる", (event, status) => {
    expect(runStep("Require a pull_request event", { EVENT_NAME: event }).status).toBe(status);
  });

  it.each([
    ["a".repeat(40), 0],
    ["main", 2],
    ["a".repeat(39), 2],
    [`${"a".repeat(40)}\n`, 2],
  ])("entelecheia-sha が %j なら %i で終わる", (sha, status) => {
    expect(runStep("Require a pinned entelecheia", { ENTELECHEIA_SHA: sha }).status).toBe(status);
  });

  it.each([
    ["30", "90", 0],
    ["40", "90", 0],
    ["45", "90", 2],
    ["30", "60", 2],
  ])("timeout-minutes %s と job-timeout-minutes %s なら %i で終わる", (timeout, job, status) => {
    expect(runStep("Check the time limits", { TIMEOUT: timeout, JOB_TIMEOUT: job }).status).toBe(
      status,
    );
  });

  describe("ent-check の終了コードの読み分け", () => {
    /**
     * 偽の mise。`mise ... exec -- node cli.js ... --out <path>` を受け、FAKE_EVIDENCE が
     * あれば --out に書き、FAKE_STATUS で終わる。
     */
    function fakeMise(dir: string): string {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const mise = join(bin, "mise");
      writeFileSync(
        mise,
        [
          "#!/bin/sh",
          'out=""',
          'printf "%s\\n" "$@" > "$FAKE_ARGS"',
          'while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done',
          'if [ -n "$FAKE_EVIDENCE" ]; then printf %s "$FAKE_EVIDENCE" > "$out"; fi',
          'exit "$FAKE_STATUS"',
          "",
        ].join("\n"),
      );
      chmodSync(mise, 0o755);
      return bin;
    }

    function runEntCheck(status: number, evidence: string | null) {
      const dir = mkdtempSync(join(scratch, "run-"));
      const summary = join(dir, "summary.md");
      const args = join(dir, "args.txt");
      writeFileSync(summary, "");
      const result = runStep("Run ent-check", {
        PATH: `${fakeMise(dir)}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: dir,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_STATUS: String(status),
        FAKE_EVIDENCE: evidence ?? "",
        FAKE_ARGS: args,
        REPO: "example-owner/sample-shop",
        PR: "7",
        BASE: "b".repeat(40),
        HEAD: "c".repeat(40),
        TASK: "verify",
        TIMEOUT: "30",
        ENTELECHEIA_SHA: "e".repeat(40),
      });
      return {
        ...result,
        summary: readFileSync(summary, "utf8"),
        args: readFileSync(args, "utf8").split("\n"),
      };
    }

    it("ent-check に ENTELECHEIA_SHA を --checker-sha として渡す", () => {
      // governor は、evidence.json に残ったこの値を、run が呼んだ検査の sha と比べる。
      const { args } = runEntCheck(0, '{"level":"E1"}');

      expect(args[args.indexOf("--checker-sha") + 1]).toBe("e".repeat(40));
    });

    it("ENTELECHEIA_SHA は、呼ぶ側が渡した entelecheia-sha の入力から取る", () => {
      const step = workflow.jobs.check.steps.find((each) => each.name === "Run ent-check");

      expect(step?.env?.ENTELECHEIA_SHA).toBe(`\${{ inputs.entelecheia-sha }}`);
    });

    it("0 なら段階を注記し、evidence.json を job summary に載せる", () => {
      const run = runEntCheck(0, '{"level":"E1"}');

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("::notice title=ent-check::no rule failed; level E1");
      expect(run.summary).toContain('{"level":"E1"}');
    });

    it("1 で evidence.json があれば、不合格と言う", () => {
      const run = runEntCheck(1, '{"level":"E0"}');

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("::error title=ent-check::failed;");
      expect(run.summary).toContain('{"level":"E0"}');
    });

    it("1 でも evidence.json が無ければ、head の不合格とは言わない", () => {
      const run = runEntCheck(1, null);

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("without writing evidence.json");
      expect(run.summary).toContain("without writing evidence.json");
    });

    it("3 なら、検査できなかったことを注記と job summary に残す", () => {
      const run = runEntCheck(3, null);

      expect(run.status).toBe(3);
      expect(run.stdout).toContain("::error title=ent-check::could not check");
      expect(run.summary).toContain("could not check");
    });

    it("2 なら、2つの sha が揃っているかを見るように言う", () => {
      // entelecheia-sha が --checker-sha を持たない古い ent-check を指すと、知らない引数で 2 になる
      const run = runEntCheck(2, null);

      expect(run.status).toBe(2);
      expect(run.stdout).toContain("check that entelecheia-sha matches the sha in uses");
    });
  });

  describe("evidence.json を artifact に残すステップ", () => {
    const keep = workflow.jobs.check.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const run = script("Run ent-check");

    it("governor が探す名前で残す", () => {
      expect(keep?.with?.name).toBe(EVIDENCE_ARTIFACT_NAME);
    });

    it("ent-check が --out に書いたファイルを残す", () => {
      // 名前がずれると artifact が作られないまま緑になり、governor は「報告が無い」と読む。
      expect(run).toContain(`--out "$RUNNER_TEMP/${EVIDENCE_FILE_NAME}"`);
      expect(keep?.with?.path).toBe(`\${{ runner.temp }}/${EVIDENCE_FILE_NAME}`);
    });

    it("ent-check が不合格（1）で赤にしても残す", () => {
      // 既定の if（success()）では、前のステップが赤だと飛ばされる。
      expect(keep?.if).toBe(`\${{ !cancelled() }}`);
    });

    it("回し直したときは、前の attempt の artifact を上書きする", () => {
      // 上書きしないと同じ名前でぶつかり、回し直した attempt が赤になる
      expect(keep?.with?.overwrite).toBe(true);
    });

    it("ent-check を流した後に置く", () => {
      const steps = workflow.jobs.check.steps;

      expect(steps.indexOf(keep as Step)).toBeGreaterThan(
        steps.findIndex((step) => step.name === "Run ent-check"),
      );
    });
  });
});
