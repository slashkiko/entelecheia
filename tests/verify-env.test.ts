import { describe, expect, it } from "vitest";
import { commandRunner } from "../src/adapters/local.js";
import {
  CLAUDE_ACTOR_WITHHELD_ENV,
  CODEX_ACTOR_WITHHELD_ENV,
  NEUTRALIZED_ENV,
  VERIFY_WITHHELD_ENV,
  withheldEnv,
} from "../src/domain/withheld-env.js";

/**
 * VERIFY が流すコマンドに、controller の資格情報を渡さないことを固定する。
 *
 * `verification.run` は Goal ごとに `mise run test` を指す。criteria がそれである
 * 以上、ここで走るのは Actor が worktree に書いたテストとソースにあたる。
 * 既定のまま `process.env` を継承すると、claude.ts が Actor 本体に対して
 * トークンを落としているのが無意味になる。Actor は自分では受け取れない
 * `GITHUB_TOKEN` を、VERIFY に実行させるコードを書くことで読める。
 *
 * `tests/**` は guard-the-controller.yaml の判断で保護対象外なので、この経路には
 * 保護パスを1つも踏まずに乗れる。しかも関門はティックの末尾、VERIFY は先頭なので
 * 関門は常に1ティック遅れる。ここで落とすしかない。
 *
 * 実際にサブプロセスを起動して `printenv` で見る。env オプションを渡している
 * つもりで渡せていない、という壊れ方をモックでは捕まえられない。
 */

const SECRET = "sentinel-value-must-not-leak";

describe("VERIFY に渡す環境変数", () => {
  it("GITHUB_TOKEN が検証コマンドに渡らない", async () => {
    process.env.GITHUB_TOKEN = SECRET;
    try {
      const runner = commandRunner(process.cwd());
      const result = await runner.run("printenv GITHUB_TOKEN || true");

      expect(result.stdout).not.toContain(SECRET);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("Claude の資格情報も検証コマンドに渡らない", async () => {
    // 検証コマンドが LLM を呼ぶ理由は無い。どの Goal も constraints に
    // 「テストから実際の GitHub と Claude API を叩かない」と書いてある。
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      const runner = commandRunner(process.cwd());
      const result = await runner.run("printenv ANTHROPIC_API_KEY || true");

      expect(result.stdout).not.toContain(SECRET);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("Codex の資格情報も検証コマンドに渡らない", async () => {
    process.env.CODEX_API_KEY = SECRET;
    try {
      const runner = commandRunner(process.cwd());
      const result = await runner.run("printenv CODEX_API_KEY || true");

      expect(result.stdout).not.toContain(SECRET);
    } finally {
      delete process.env.CODEX_API_KEY;
    }
  });

  it("落とさないものは渡る", async () => {
    // 全部落とすと `mise run test` が動かない。PATH が通っていることを見る。
    const runner = commandRunner(process.cwd());
    const result = await runner.run("printenv PATH");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("VERIFY 側の除去リストは Actor 側を包含する", () => {
    // 片方にだけ足す変更を落とす。VERIFY の方が広く落とす側。
    for (const key of [...CLAUDE_ACTOR_WITHHELD_ENV, ...CODEX_ACTOR_WITHHELD_ENV]) {
      expect(VERIFY_WITHHELD_ENV).toContain(key);
    }
  });

  it("withheldEnv は値が undefined のキーも落とす", () => {
    const env = withheldEnv({ KEEP: "a", DROP: undefined, GITHUB_TOKEN: "t" });

    expect(env).toEqual({ KEEP: "a", ...NEUTRALIZED_ENV });
  });

  it("gh の設定ディレクトリを無効化する。ホスト側の指定より後に置く", () => {
    // 除去リストは変数を消すことしかできない。`HOME` は落とせない（mise も pnpm も
    // 動かなくなる）ので、`gh` は `$HOME/.config/gh/hosts.yml` のログインに落ちて
    // controller を動かしている人間の認証で通ってしまう。設定の置き場ごと
    // 実在しないディレクトリへ向けて、未認証にする（design.md §10-4）。
    const env = withheldEnv({ HOME: "/home/x", GH_CONFIG_DIR: "/home/x/.config/gh" });

    expect(env.HOME).toBe("/home/x");
    expect(env.GH_CONFIG_DIR).toBe(NEUTRALIZED_ENV.GH_CONFIG_DIR);
    expect(env.GH_CONFIG_DIR).not.toBe("/home/x/.config/gh");
  });

  it("検証コマンドの中でも gh の設定ディレクトリが無効化されている", async () => {
    // Actor 本体だけ塞いでも、Actor が書いたテストが VERIFY で走る経路に
    // 認証済みの gh が残っていれば同じところへ届く。実際にサブプロセスを立てて見る。
    process.env.GH_CONFIG_DIR = "/home/x/.config/gh";
    try {
      const runner = commandRunner(process.cwd());
      const result = await runner.run("printenv GH_CONFIG_DIR || true");

      expect(result.stdout.trim()).toBe(NEUTRALIZED_ENV.GH_CONFIG_DIR);
    } finally {
      delete process.env.GH_CONFIG_DIR;
    }
  });
});
