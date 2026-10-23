import { afterEach, describe, expect, it } from "vitest";
import { checkEnv } from "../src/env.js";

// ent の VERIFY の除去リストに、検査が足した名前。core の側のテストでは見えない。
const ADDED = [
  "MISE_GITHUB_TOKEN",
  "GITHUB_API_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

describe("checkEnv", () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const name of ADDED) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it.each(ADDED)("%s を子へ渡さない", (name) => {
    process.env[name] = "dummy-value";

    expect(checkEnv()).not.toHaveProperty(name);
  });

  it("足した値は渡す", () => {
    expect(checkEnv({ ENT_CHECK_REPORT_DIR: "/tmp/reports" })).toMatchObject({
      ENT_CHECK_REPORT_DIR: "/tmp/reports",
    });
  });
});
