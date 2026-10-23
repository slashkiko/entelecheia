import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_RULE_FLOOR } from "@entelecheia/core/factory/approval-rules.js";
import { decideAutoMerge, type HumanMergeReason } from "@entelecheia/core/factory/auto-merge.js";
import type { ChangedFile, ChangeSet } from "@entelecheia/core/factory/change.js";
import type { EvidenceReport } from "@entelecheia/core/factory/evidence-report.js";
import { summarizeEvidence } from "@entelecheia/core/factory/evidence-report.js";
import { workKindSchema } from "@entelecheia/core/factory/kind.js";
import { composePolicy, policySchema, profileSchema } from "@entelecheia/core/factory/policy.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { passed, runCheck } from "../src/check.js";
import { git, ROOT, sampleRepo, withFakeMise } from "./repo-fixture.js";

/**
 * known-bad と known-good の見本を全部回す。
 *
 * known-bad は factory が落とすべき PR、known-good は落としてはいけない PR になる。
 * どちらも `known-bad/fixture/` の作り物のリポジトリに差分を当てて作り、検査
 * （`runCheck`）と、検査の結果を受けた自動マージの判定（`decideAutoMerge`）に通す。
 *
 * 見本は1件1ディレクトリで、`meta.yaml`（説明・種別・作った主体・期待する落ち方）と
 * `change.patch`（作り物の値で書いた差分）を置く（設計の「known-bad の書式」）。
 * `expect.stage` が `check` なら検査で落ちる（通る）こと、`governor` なら検査の結果を
 * 受けた判定で人に回る（自動マージになる）ことを確かめる。
 *
 * 判定は、ポリシーが全部の種別の自動マージを許し、レビューも済んだ状態で回す。
 * 一番緩い設定でも人に回ることが、下限がコードにある意味になる。
 */

const NOW = "2000-01-31T00:00:00Z";
const RENOVATE_APP_ID = 1001;
const OWNER_ID = 2002;
const ACTOR_USER_ID = 3003;

const verdictsFor = {
  "known-bad": ["fail", "needs-human"],
  "known-good": ["pass", "auto-merge"],
} as const;

const metaSchema = z.strictObject({
  description: z.string().min(1),
  kind: workKindSchema,
  author: z.enum(["actor", "renovate"]),
  /**
   * governor が GitHub とレジストリから読む値。見本では作り物の値を書く。
   * 書かないものは「読めなかった」として渡す
   */
  observed: z
    .strictObject({
      added_packages: z.array(z.string().min(1)).optional(),
      releases: z
        .array(
          z.strictObject({ name: z.string().min(1), released_days_ago: z.number().int().min(0) }),
        )
        .optional(),
    })
    .optional(),
  expect: z.discriminatedUnion("stage", [
    z.strictObject({
      stage: z.literal("check"),
      verdict: z.enum(["pass", "fail"]),
      rule_id: z.string().min(1).optional(),
    }),
    z.strictObject({
      stage: z.literal("governor"),
      verdict: z.enum(["auto-merge", "needs-human"]),
      rule_id: z.string().min(1).optional(),
    }),
  ]),
});
type Meta = z.infer<typeof metaSchema>;

interface Sample {
  group: keyof typeof verdictsFor;
  name: string;
  dir: string;
  meta: Meta;
}

function samples(): Sample[] {
  return (["known-bad", "known-good"] as const).flatMap((group) => {
    const root = join(ROOT, group);
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "meta.yaml")))
      .map((entry) => {
        const dir = join(root, entry.name);
        const meta = metaSchema.parse(parse(readFileSync(join(dir, "meta.yaml"), "utf8")));
        return { group, name: entry.name, dir, meta };
      });
  });
}

const SAMPLES = samples();

function applySample(sample: Sample) {
  return sampleRepo((dir) => {
    git(dir, ["apply", "--index", join(sample.dir, "change.patch")]);
  });
}

async function check(repo: { dir: string; base: string; head: string }) {
  return runCheck({
    repoDir: repo.dir,
    repo: "example-owner/sample-shop",
    pr: 1,
    base: repo.base,
    head: repo.head,
    task: "verify",
    timeoutMs: 60_000,
    checkerSha: null,
    now: () => new Date(NOW),
  });
}

/** 差分を governor が読む形にする。patch は行だけを持ち、先頭の `+` / `-` を落とす */
function changeSetOf(sample: Sample, repo: { dir: string; base: string; head: string }): ChangeSet {
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" });
  const fields = run(["diff", "--name-status", "-z", "-M", repo.base, repo.head])
    .split("\0")
    .filter((field) => field.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    const isRename = status.startsWith("R");
    const path = (isRename ? fields[i + 2] : fields[i + 1]) ?? "";
    const previousPath = isRename ? (fields[i + 1] ?? "") : undefined;
    i += isRename ? 3 : 2;
    const lines = run([
      "diff",
      "-U0",
      "-M",
      repo.base,
      repo.head,
      "--",
      path,
      ...(previousPath ? [previousPath] : []),
    ])
      .split("\n")
      .filter((line) => !line.startsWith("+++") && !line.startsWith("---"));
    const patch = {
      added: lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)),
      removed: lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1)),
    };
    if (previousPath !== undefined) {
      files.push({ path, previousPath, status: "renamed", patch });
    } else {
      const kind = status.startsWith("A")
        ? "added"
        : status.startsWith("D")
          ? "removed"
          : "modified";
      files.push({ path, status: kind, patch });
    }
  }
  const observed = sample.meta.observed;
  const day = 24 * 60 * 60 * 1000;
  return {
    kind: sample.meta.kind,
    author:
      sample.meta.author === "renovate"
        ? { type: "app", appId: RENOVATE_APP_ID }
        : { type: "user", userId: ACTOR_USER_ID },
    files,
    ...(observed?.added_packages === undefined ? {} : { addedPackages: observed.added_packages }),
    ...(observed?.releases === undefined
      ? {}
      : {
          releases: observed.releases.map((release) => ({
            name: release.name,
            releasedAt: new Date(Date.parse(NOW) - release.released_days_ago * day).toISOString(),
          })),
        }),
  };
}

/** 一番緩い設定。全部の種別の自動マージを許す */
function permissivePolicy() {
  const everyKind = ["deps", "lint", "docs", "flaky", "refactor", "fix", "feat"];
  const result = composePolicy(
    profileSchema.parse({
      version: 1,
      owner: { github_user_id: OWNER_ID },
      renovate: { app_id: RENOVATE_APP_ID },
      max: {
        auto_merge: everyKind,
        limits: { wip: 5, daily_starts: 10, max_diff_lines: 800 },
      },
    }),
    policySchema.parse({
      version: 1,
      auto_merge: everyKind,
      limits: { wip: 3, daily_starts: 5, max_diff_lines: 400 },
    }),
  );
  if (!result.ok) {
    throw new Error(`fixture policy is invalid: ${JSON.stringify(result.violations)}`);
  }
  return result.policy;
}

/** 人に回す理由の鍵。承認ルールは下限の id、それ以外は理由の code */
function reasonIds(reasons: readonly HumanMergeReason[]): string[] {
  return reasons.map((reason) => {
    if (reason.code !== "approval_rule") return reason.code;
    return APPROVAL_RULE_FLOOR.find((rule) => rule.reason === reason.reason)?.id ?? reason.code;
  });
}

function failedRules(report: EvidenceReport): string[] {
  return report.results
    .filter((result) => result.status === "fail")
    .map((result) => result.rule_id);
}

describe("known-bad と known-good の見本", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = withFakeMise();
  });
  afterAll(() => restore());

  it("見本がそろっている", () => {
    // ディレクトリを読み違えて0件になると、下の it.each が何も回さずに緑になる。
    expect(SAMPLES.filter((sample) => sample.group === "known-bad").length).toBeGreaterThan(5);
    expect(SAMPLES.filter((sample) => sample.group === "known-good").length).toBeGreaterThan(2);
  });

  it.each(SAMPLES.map((sample) => [`${sample.group}/${sample.name}`, sample] as const))(
    "%s",
    async (_label, sample) => {
      const { expect: expected } = sample.meta;
      expect(verdictsFor[sample.group]).toContain(expected.verdict);
      if (sample.group === "known-bad") {
        // 落ち方を名指ししない known-bad は、別の理由で落ちても緑になる。
        expect(expected.rule_id).toBeDefined();
      }

      const repo = applySample(sample);
      try {
        const report = await check(repo);
        if (expected.stage === "check") {
          if (expected.verdict === "fail") {
            expect(failedRules(report)).toContain(expected.rule_id);
          } else {
            expect(failedRules(report)).toEqual([]);
            expect(report.level).toBe("E1");
          }
          return;
        }

        // 判定は、検査の結果がどうであれ回す。検査で落ちても governor の側で人に回ること、
        // つまり下限が検査の結果に頼らずに効くことを確かめる。known-good は検査も通ること。
        if (sample.group === "known-good") {
          expect(passed(report), JSON.stringify(report.results)).toBe(true);
        }
        const decision = decideAutoMerge({
          policy: permissivePolicy(),
          change: changeSetOf(sample, repo),
          evidence: summarizeEvidence(report),
          review: { completed: true, unresolvedImportant: 0, rounds: 1 },
          classifierNeedsHuman: false,
          repo: { phase: "normal", halted: false },
          now: NOW,
        });
        if (expected.verdict === "needs-human") {
          expect(decision.decision).toBe("human_merge");
          expect(reasonIds(decision.reasons)).toContain(expected.rule_id);
        } else {
          expect(decision).toEqual({ decision: "auto_merge", reasons: [] });
        }
      } finally {
        repo.cleanup();
      }
    },
  );
});
