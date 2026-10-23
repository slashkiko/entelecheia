import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // テストの中の git を、回している人間の global / system 設定から切り離す。
    // 理由は `tests/setup-git-env.ts` にある。
    setupFiles: ["tests/setup-git-env.ts"],
  },
});
