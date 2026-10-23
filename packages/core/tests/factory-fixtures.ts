import type { AutoMergeInput } from "../src/factory/auto-merge.js";
import type { ChangedFile, ChangeSet } from "../src/factory/change.js";
import {
  composePolicy,
  type EffectivePolicy,
  type Policy,
  type Profile,
  policySchema,
  profileSchema,
} from "../src/factory/policy.js";

/**
 * factory の判断のテストが共有する入力。値はどれも作り物で、実在のリポジトリや ID を指さない。
 */

export const RENOVATE_APP_ID = 1001;
export const OWNER_ID = 2002;
export const NOW = "2000-01-31T00:00:00Z";
/** NOW から30日前。依存更新の例外の日数を満たす */
export const OLD_RELEASE = "2000-01-01T00:00:00Z";
/** NOW から1日前。依存更新の例外の日数を満たさない */
export const FRESH_RELEASE = "2000-01-30T00:00:00Z";

export function profile(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    version: 1,
    owner: { github_user_id: OWNER_ID },
    renovate: { app_id: RENOVATE_APP_ID },
    fleet: [{ repo: "example/app", since: "2000-02-01" }],
    max: {
      auto_merge: ["deps", "lint", "docs", "flaky", "refactor", "fix", "feat"],
      limits: { wip: 5, daily_starts: 10, max_diff_lines: 800 },
      discovery: ["failing_tests", "doctor", "lint_warnings", "todo", "roadmap", "ai_review"],
    },
    ...overrides,
  });
}

export function policy(overrides: Record<string, unknown> = {}): Policy {
  return policySchema.parse({
    version: 1,
    auto_merge: ["deps", "lint", "docs", "flaky", "refactor", "fix", "feat"],
    limits: { wip: 3, daily_starts: 5, max_diff_lines: 400 },
    discovery: { failing_tests: true, doctor: true, lint_warnings: true, todo: true },
    ...overrides,
  });
}

/** 合わせた結果。違反があればテストの組み方の誤りなので投げる */
export function effective(
  profileOverrides: Record<string, unknown> = {},
  policyOverrides: Record<string, unknown> = {},
): EffectivePolicy {
  const result = composePolicy(profile(profileOverrides), policy(policyOverrides));
  if (!result.ok) {
    throw new Error(`fixture policy is invalid: ${JSON.stringify(result.violations)}`);
  }
  return result.policy;
}

export function modified(path: string, added: string[] = [], removed: string[] = []): ChangedFile {
  return { path, status: "modified", patch: { added, removed } };
}

/** Actor が書いた変更。PR を作るのは governor の App なので、作者は Renovate ではない App になる */
export function actorChange(kind: ChangeSet["kind"], files: ChangedFile[]): ChangeSet {
  return { kind, author: { type: "app", appId: 3003 }, files };
}

/**
 * Renovate の依存更新。バージョンの行だけを動かし、公開から十分に日が経っている。lockfile に
 * 新しいパッケージは入らない（呼ぶ側がそう読めた）
 */
export function renovateChange(files: ChangedFile[], releasedAt = OLD_RELEASE): ChangeSet {
  return {
    kind: "deps",
    author: { type: "app", appId: RENOVATE_APP_ID },
    files,
    releases: [{ name: "zod", releasedAt }],
    addedPackages: [],
  };
}

/** NOW からちょうど `days` 日前に `offsetMs` ミリ秒を足した時刻 */
export function daysBeforeNow(days: number, offsetMs = 0): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000 + offsetMs).toISOString();
}

export const ZOD_BUMP = modified(
  "package.json",
  ['    "zod": "^4.4.4",'],
  ['    "zod": "^4.4.3",'],
);

export const LOCK_BUMP: ChangedFile = { path: "pnpm-lock.yaml", status: "modified" };

/** 自動マージに必要なものが全部揃った入力。各テストはここから1つだけ崩す */
export function autoMergeInput(overrides: Partial<AutoMergeInput> = {}): AutoMergeInput {
  return {
    policy: effective(),
    change: actorChange("docs", [modified("docs/guide.md", ["new"], ["old"])]),
    evidence: { level: "E4", typesChanged: false, snapshotsChanged: false },
    review: { completed: true, unresolvedImportant: 0, rounds: 1 },
    classifierNeedsHuman: false,
    repo: { phase: "normal", halted: false },
    now: NOW,
    ...overrides,
  };
}
