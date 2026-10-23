import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // core はビルドせずに src を直に読む。ルートの tsconfig.json の paths と同じ向け先にする。
    alias: [
      {
        find: /^@entelecheia\/core\/(.*)\.js$/,
        replacement: `${resolve(import.meta.dirname, "../core/src")}/$1.ts`,
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // テストの中の git を、回している人間の global / system 設定から切り離す。
    // 理由は ent の `tests/setup-git-env.ts` にある。
    setupFiles: ["tests/setup-git-env.ts"],
  },
});
