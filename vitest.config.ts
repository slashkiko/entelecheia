import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // package ごとの設定（include と setupFiles）は各 package の vitest.config.ts が持つ。
    // ルートから `vitest run` を叩くと、全 package のテストが1回で回る。
    projects: ["packages/*"],
  },
});
