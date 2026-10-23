import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_ARTIFACT_NAME,
  EVIDENCE_ATTESTATION_FILE_NAME,
  EVIDENCE_AUDIENCE_PREFIX,
  EVIDENCE_FILE_NAME,
} from "@entelecheia/core/factory/evidence-report.js";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { OBSERVATIONS_ARTIFACT_NAME, OBSERVATIONS_FILE_NAME } from "../src/observations.js";
import { ROOT } from "./repo-fixture.js";

/**
 * 再利用ワークフロー（`.github/workflows/check.yml`）のシェルを、Actions の外で流す。
 * actionlint と zizmor は書き方を見るだけなので、event の関門・sha の関門・時間の上限・
 * 終了コードの読み分けが変わっても気づかない。
 *
 * ワークフローの `defaults.run.shell: bash` と同じく `bash --noprofile --norc -eo pipefail` で
 * 流し、`${{ }}` の値は env で渡す。
 */
interface Step {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean | number>;
}

interface Job {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

const workflow = parse(readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8")) as {
  defaults?: { run?: { shell?: string } };
  jobs: { observe: Job; evidence: Job };
};
const { observe, evidence } = workflow.jobs;

function stepOf(job: Job, name: string): Step {
  const step = job.steps.find((each) => each.name === name);
  if (step === undefined) throw new Error(`check.yml has no step named ${name}`);
  return step;
}

function script(job: Job, name: string): string {
  const run = stepOf(job, name).run;
  if (run === undefined) throw new Error(`the step ${name} has no run`);
  return run;
}

const scratch = mkdtempSync(join(tmpdir(), "ent-check-workflow-"));

function runStep(job: Job, name: string, env: Record<string, string>) {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script(job, name)],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

/** 偽のコマンドを置いたディレクトリを返す。`body` はシェルの本文 */
function fakeCommand(dir: string, name: string, body: string[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(path, 0o755);
  return bin;
}

/**
 * 偽の mise。`mise ... exec -- node cli.js ... --out <path>` を受け、FAKE_OUTPUT があれば
 * --out に書き、FAKE_STATUS で終わる。
 */
function fakeMise(dir: string): string {
  return fakeCommand(dir, "mise", [
    'out=""',
    'printf "%s\\n" "$@" > "$FAKE_ARGS"',
    'while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done',
    'if [ -n "$FAKE_OUTPUT" ]; then printf %s "$FAKE_OUTPUT" > "$out"; fi',
    'exit "$FAKE_STATUS"',
  ]);
}

/** 偽の curl。呼ばれた引数を FAKE_CURL_ARGS に残し、`{"value": FAKE_TOKEN}` を返す */
function fakeCurl(dir: string): string {
  return fakeCommand(dir, "curl", [
    'printf "%s\\n" "$@" > "$FAKE_CURL_ARGS"',
    'printf \'{"value":"%s"}\' "$FAKE_TOKEN"',
  ]);
}

/** 署名の無い、中身だけを確かめるための JWT。ワークフローは署名を見ない */
function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`;
}

describe("check.yml のジョブの形", () => {
  it("ステップを、ここで流すのと同じ bash で流す", () => {
    // shell を書かないと pipefail が付かず、ここで通ったパイプが Actions では違う動きをする
    expect(workflow.defaults?.run?.shell).toBe("bash");
    for (const step of [...observe.steps, ...evidence.steps]) {
      expect(step).not.toHaveProperty("shell");
    }
  });

  it("run の中に式を直に書かない（値は env で渡す）", () => {
    for (const step of [...observe.steps, ...evidence.steps]) {
      expect(step.run ?? "").not.toContain("${{");
    }
  });

  it("OIDC トークンを取れるのは evidence のジョブだけ", () => {
    // head のコードを流す observe がトークンを取れると、偽った報告に GitHub の署名を付けられる
    expect(observe.permissions).toEqual({ contents: "read" });
    expect(evidence.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("evidence のジョブは head のコードを流さない", () => {
    // ent-check を --observe で呼ぶと verify を流す。evidence は観測を読むだけにする
    for (const step of evidence.steps) {
      expect(step.run ?? "").not.toMatch(/--observe\b(?!ations)/);
    }
    expect(script(evidence, "Run ent-check")).toContain("--observations");
  });

  it("evidence は observe の後に、observe が落ちても流す", () => {
    // 飛ばしたジョブは成功として数えられ、必須のチェックを満たす
    expect(evidence.needs).toBe("observe");
    expect(evidence.if).toBe(`\${{ !cancelled() }}`);
  });

  it("どちらのジョブも Actions のキャッシュを戻さず、mise 本体を sha256 で確かめる", () => {
    // head のコードはキャッシュを書ける。evidence が戻すと、head が置いた mise を流すことになる
    for (const job of [observe, evidence]) {
      const mise = job.steps.find((step) => step.uses?.startsWith("jdx/mise-action@"));
      expect(mise?.with).toMatchObject({ cache: false, install: false, github_token: "" });
      expect(mise?.with?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const job of [observe, evidence]) {
      for (const step of job.steps) {
        expect(step.uses ?? "").not.toMatch(/^actions\/cache[@/]/);
      }
    }
  });

  it("ent-check を用意するステップは、2つのジョブで同じ", () => {
    // 片方だけを直すと、もう片方に古い設定が残る
    const setup = (job: Job) =>
      job.steps.filter(
        (step) =>
          step.with?.repository === "slashkiko/entelecheia" ||
          step.uses?.startsWith("jdx/mise-action@") === true ||
          step.name === "Build ent-check",
      );

    expect(setup(observe)).toHaveLength(3);
    expect(setup(evidence)).toEqual(setup(observe));
  });

  it("呼ばれた sha を確かめてから entelecheia を取り出す", () => {
    const resolve = evidence.steps.indexOf(stepOf(evidence, "Resolve the checker"));
    const checkout = evidence.steps.findIndex(
      (step) =>
        step.uses?.startsWith("actions/checkout@") === true &&
        step.with?.repository === "slashkiko/entelecheia",
    );

    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(resolve);
  });
});

describe("check.yml のシェル", () => {
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ["pull_request", 0],
    ["pull_request_target", 2],
    ["push", 2],
  ])("event が %s なら %i で終わる", (event, status) => {
    expect(runStep(observe, "Require a pull_request event", { EVENT_NAME: event }).status).toBe(
      status,
    );
  });

  it.each([
    ["a".repeat(40), 0],
    ["main", 2],
    ["a".repeat(39), 2],
    [`${"a".repeat(40)}\n`, 2],
  ])("entelecheia-sha が %j なら %i で終わる", (sha, status) => {
    expect(runStep(observe, "Require a pinned entelecheia", { ENTELECHEIA_SHA: sha }).status).toBe(
      status,
    );
  });

  it.each([
    ["30", "90", 0],
    ["40", "90", 0],
    ["45", "90", 2],
    ["30", "60", 2],
  ])("timeout-minutes %s と job-timeout-minutes %s なら %i で終わる", (timeout, job, status) => {
    expect(
      runStep(observe, "Check the time limits", { TIMEOUT: timeout, JOB_TIMEOUT: job }).status,
    ).toBe(status);
  });

  it.each([
    ["success", 0],
    ["failure", 3],
    ["cancelled", 3],
  ])("observe が %s なら、evidence は %i で終わる", (result, status) => {
    expect(runStep(evidence, "Require the observations", { OBSERVED: result }).status).toBe(status);
  });

  describe("呼ばれた sha の確かめ", () => {
    function resolve(
      called: string,
      entelecheia: string,
      url = "https://token.example.test/?v=1",
      extra: Record<string, unknown> = {},
    ) {
      const dir = mkdtempSync(join(scratch, "resolve-"));
      const curlArgs = join(dir, "curl.txt");
      const result = runStep(evidence, "Resolve the checker", {
        PATH: `${fakeCurl(dir)}:${process.env.PATH ?? ""}`,
        ACTIONS_ID_TOKEN_REQUEST_URL: url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "dummy-request-token",
        FAKE_TOKEN: unsignedToken({ job_workflow_sha: called, aud: "ent-check", ...extra }),
        FAKE_CURL_ARGS: curlArgs,
        ENTELECHEIA_SHA: entelecheia,
      });
      return { ...result, curlArgs: url === "" ? "" : readFileSync(curlArgs, "utf8") };
    }

    it("トークンの job_workflow_sha が entelecheia-sha と同じなら通す", () => {
      const { status, curlArgs } = resolve("e".repeat(40), "e".repeat(40));

      expect(status).toBe(0);
      expect(curlArgs).toContain("https://token.example.test/?v=1&audience=ent-check");
    });

    it.each([
      [0, 2],
      [1, 3],
      [2, 0],
    ])(
      "base64url の中身を、= で埋めずに読む（足す文字 %i、長さを 4 で割った余り %i）",
      (length, rest) => {
        // 実際のトークンは欄の長さがまちまちで、= の要る長さにもなる。`?>` は base64url で - と _ になる
        const extra = { note: `${"?>".repeat(3)}${"x".repeat(length)}` };
        const payload = unsignedToken({
          job_workflow_sha: "e".repeat(40),
          aud: "ent-check",
          ...extra,
        }).split(".")[1] as string;
        expect(payload.length % 4).toBe(rest);
        expect(payload).toMatch(/-/);
        expect(payload).toMatch(/_/);

        expect(resolve("e".repeat(40), "e".repeat(40), undefined, extra).status).toBe(0);
      },
    );

    it("違えば、uses と entelecheia-sha を揃えるよう言って 2 で終わる", () => {
      const { status, stdout } = resolve("e".repeat(40), "f".repeat(40));

      expect(status).toBe(2);
      expect(stdout).toContain(`must match the sha in uses (${"e".repeat(40)})`);
    });

    it("トークンを取れなければ、id-token: write を渡すよう言う", () => {
      const { status, stdout } = resolve("e".repeat(40), "e".repeat(40), "");

      expect(status).toBe(2);
      expect(stdout).toContain("grant id-token: write");
    });
  });

  describe("evidence.json に結びつけたトークン", () => {
    function attest(evidenceJson: string | null) {
      const dir = mkdtempSync(join(scratch, "attest-"));
      mkdirSync(join(dir, "evidence"));
      if (evidenceJson !== null) {
        writeFileSync(join(dir, "evidence", EVIDENCE_FILE_NAME), evidenceJson);
      }
      const curlArgs = join(dir, "curl.txt");
      const result = runStep(evidence, "Attest evidence.json", {
        PATH: `${fakeCurl(dir)}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: dir,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example.test/?v=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "dummy-request-token",
        FAKE_TOKEN: "dummy.jwt.value",
        FAKE_CURL_ARGS: curlArgs,
      });
      const jwt = join(dir, "evidence", EVIDENCE_ATTESTATION_FILE_NAME);
      return {
        ...result,
        curlArgs: existsSync(curlArgs) ? readFileSync(curlArgs, "utf8") : null,
        jwt: existsSync(jwt) ? readFileSync(jwt, "utf8") : null,
      };
    }

    it("evidence.json の sha256 を audience にしたトークンを、横に書く", () => {
      const body = '{"level":"E1"}';
      const digest = createHash("sha256").update(body).digest("hex");
      const { status, curlArgs, jwt } = attest(body);

      expect(status).toBe(0);
      expect(curlArgs).toContain(`&audience=${EVIDENCE_AUDIENCE_PREFIX}${digest}`);
      expect(jwt?.trim()).toBe("dummy.jwt.value");
    });

    it("evidence.json が無ければ、トークンを取らずに終わる", () => {
      const { status, curlArgs, jwt } = attest(null);

      expect(status).toBe(0);
      expect(curlArgs).toBeNull();
      expect(jwt).toBeNull();
    });
  });

  describe("観測の終了コードの読み分け", () => {
    function observeHead(status: number) {
      const dir = mkdtempSync(join(scratch, "observe-"));
      const summary = join(dir, "summary.md");
      const args = join(dir, "args.txt");
      writeFileSync(summary, "");
      const result = runStep(observe, "Observe the head", {
        PATH: `${fakeMise(dir)}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: dir,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_STATUS: String(status),
        FAKE_OUTPUT: "{}",
        FAKE_ARGS: args,
        BASE: "b".repeat(40),
        HEAD: "c".repeat(40),
        TASK: "verify",
        TIMEOUT: "30",
      });
      return {
        ...result,
        summary: readFileSync(summary, "utf8"),
        args: readFileSync(args, "utf8").split("\n"),
      };
    }

    it("ent-check を --observe で呼び、観測を残す場所に書かせる", () => {
      const { args, status } = observeHead(0);

      expect(status).toBe(0);
      expect(args).toContain("--observe");
      expect(args[args.indexOf("--out") + 1]).toMatch(new RegExp(`/${OBSERVATIONS_FILE_NAME}$`));
    });

    it("3 なら、検査できなかったことを注記と job summary に残す", () => {
      const run = observeHead(3);

      expect(run.status).toBe(3);
      expect(run.stdout).toContain("::error title=ent-check::could not check");
      expect(run.summary).toContain("could not check");
    });

    it("2 なら、2つの sha が揃っているかを見るように言う", () => {
      const run = observeHead(2);

      expect(run.status).toBe(2);
      expect(run.stdout).toContain("check that entelecheia-sha matches the sha in uses");
    });
  });

  describe("ent-check の終了コードの読み分け", () => {
    function runEntCheck(status: number, output: string | null) {
      const dir = mkdtempSync(join(scratch, "run-"));
      const summary = join(dir, "summary.md");
      const args = join(dir, "args.txt");
      writeFileSync(summary, "");
      const result = runStep(evidence, "Run ent-check", {
        PATH: `${fakeMise(dir)}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: dir,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_STATUS: String(status),
        FAKE_OUTPUT: output ?? "",
        FAKE_ARGS: args,
        REPO: "example-owner/sample-shop",
        PR: "7",
        BASE: "b".repeat(40),
        HEAD: "c".repeat(40),
        ENTELECHEIA_SHA: "e".repeat(40),
      });
      return {
        ...result,
        dir,
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
      expect(stepOf(evidence, "Run ent-check").env?.ENTELECHEIA_SHA).toBe(
        `\${{ inputs.entelecheia-sha }}`,
      );
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

    it.each([2, 3, 137])("%i で途中の evidence.json が残っていれば消す", (status) => {
      // 消さないと、後のステップが書きかけのファイルにトークンを付けて残す
      const run = runEntCheck(status, '{"level":');

      expect(run.status).toBe(status);
      expect(existsSync(join(run.dir, "evidence", EVIDENCE_FILE_NAME))).toBe(false);
      expect(run.summary).not.toContain('{"level":');
    });

    it("2 なら、2つの sha が揃っているかを見るように言う", () => {
      // entelecheia-sha が --observations を持たない古い ent-check を指すと、知らない引数で 2 になる
      const run = runEntCheck(2, null);

      expect(run.status).toBe(2);
      expect(run.stdout).toContain("check that entelecheia-sha matches the sha in uses");
    });
  });

  describe("artifact に残すステップ", () => {
    const uploads = (job: Job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const [keepObservations] = uploads(observe);
    const [keepEvidence] = uploads(evidence);
    const download = evidence.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );

    it("観測は observe が残し、evidence が同じ名前で取り出して読む", () => {
      expect(keepObservations?.with?.name).toBe(OBSERVATIONS_ARTIFACT_NAME);
      expect(keepObservations?.with?.path).toBe(`\${{ runner.temp }}/${OBSERVATIONS_FILE_NAME}`);
      expect(download?.with?.name).toBe(OBSERVATIONS_ARTIFACT_NAME);
      expect(script(evidence, "Run ent-check")).toContain(
        `--observations "$RUNNER_TEMP/observations/${OBSERVATIONS_FILE_NAME}"`,
      );
      expect(download?.with?.path).toBe(`\${{ runner.temp }}/observations`);
    });

    it("evidence.json は governor が探す名前で残す", () => {
      expect(uploads(observe)).toHaveLength(1);
      expect(keepEvidence?.with?.name).toBe(EVIDENCE_ARTIFACT_NAME);
    });

    it("evidence.json とトークンを同じ置き場に書き、その置き場を残す", () => {
      // 名前がずれると artifact が作られないまま緑になり、governor は「報告が無い」と読む。
      expect(script(evidence, "Run ent-check")).toContain(
        `evidence="$RUNNER_TEMP/evidence/${EVIDENCE_FILE_NAME}"`,
      );
      expect(script(evidence, "Attest evidence.json")).toContain(
        `"$RUNNER_TEMP/evidence/${EVIDENCE_ATTESTATION_FILE_NAME}"`,
      );
      expect(keepEvidence?.with?.path).toBe(`\${{ runner.temp }}/evidence/`);
    });

    it("ent-check が不合格（1）で赤にしてもトークンを取って残す。取れなければ残さない", () => {
      // 既定の if（success()）では、前のステップが赤だと飛ばされる。トークンの無い
      // evidence.json を残すと、governor は壊れた artifact として人に回す
      expect(stepOf(evidence, "Attest evidence.json").if).toBe(`\${{ !cancelled() }}`);
      expect(keepEvidence?.if).toBe(`\${{ !cancelled() && steps.attest.outcome == 'success' }}`);
      expect(stepOf(evidence, "Attest evidence.json").id).toBe("attest");
    });

    it("回し直したときは、前の attempt の artifact を上書きする", () => {
      // 上書きしないと同じ名前でぶつかり、回し直した attempt が赤になる
      expect(keepObservations?.with?.overwrite).toBe(true);
      expect(keepEvidence?.with?.overwrite).toBe(true);
    });

    it("ent-check を流した後に置く", () => {
      expect(observe.steps.indexOf(keepObservations as Step)).toBeGreaterThan(
        observe.steps.indexOf(stepOf(observe, "Observe the head")),
      );
      expect(evidence.steps.indexOf(keepEvidence as Step)).toBeGreaterThan(
        evidence.steps.indexOf(stepOf(evidence, "Attest evidence.json")),
      );
    });
  });
});
