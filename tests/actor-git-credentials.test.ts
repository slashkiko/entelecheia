import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandRunner } from "../src/adapters/local.js";
import { NEUTRALIZED_ENV, WITHHELD_ENV, withheldEnv } from "../src/domain/withheld-env.js";

/**
 * git 自身の資格情報の経路を、Actor と検証コマンドから塞いだことを固定する。
 *
 * `gh` は `GH_CONFIG_DIR=/dev/null` で未認証にしてあったが、**git は塞がって
 * いなかった。** Actor に渡すのと同じ環境（トークンの環境変数は落とし、
 * `GH_CONFIG_DIR` は無効化済み）のまま、private リポジトリに対する
 * `git ls-remote https://github.com/...` が非対話で通り、`git credential fill` に
 * `protocol=https` / `host=github.com` を流すとトークンそのものが stdout に出た。
 * 出どころは system の gitconfig の `credential.helper = osxkeychain` で、
 * **system の設定なので repo 設定でもユーザー設定でも消せない。**
 *
 * 取れれば PR コメントを投稿でき、`/ent approve` の定型文を Actor が自分で
 * 書ける（design.md §10-4）。`gh` を塞いだ理由がそのまま当てはまる。
 *
 * ここでは system の gitconfig を触れないので、**同じ優先順位の関係を local 設定で
 * 再現する。** `GIT_CONFIG_COUNT` の組は system / global / local のどれよりも後に
 * 読まれるので、local に置いた helper を打ち消せるなら system も打ち消せる。
 * system 側の実測（private repo への `ls-remote` が塞がること）はテストから
 * ネットワークを叩かない約束があるので、ここには入れていない。
 *
 * 本物のサブプロセスを立てる。`env` を渡しているつもりで渡せていない、という
 * 壊れ方はモックでは捕まえられない（`tests/verify-env.test.ts` と同じ理由）。
 */

const run = promisify(execFile);
const SECRET = "sentinel-token-must-not-leak";

let repo: string;

/** 問い合わせに固定のトークンを返す helper を置き、local 設定から指す */
async function installLocalHelper(path: string): Promise<void> {
  const helper = join(path, "fake-credential-helper.sh");
  writeFileSync(helper, `#!/bin/sh\necho username=someone\necho password=${SECRET}\n`);
  chmodSync(helper, 0o755);
  // local 設定に置く。ent はここを消せない立場（system 設定を消せないのと同じ）に
  // 自分を置いたうえで、環境変数だけで打ち消せることを見る。
  await run("git", ["-C", path, "config", "credential.helper", `!${helper}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ent-git-cred-"));
  await run("git", ["init", "-b", "main", repo]);
  await installLocalHelper(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const FILL_INPUT = "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill";

describe("Actor と検証コマンドに渡す git の資格情報", () => {
  it("この repo の設定なら、素の環境では helper がトークンを出す（再現）", async () => {
    // 直したことを確かめる側だけを書くと、helper の設定を書き損ねた日に
    // 「塞げている」ではなく「そもそも出ていない」で緑になる。
    const { stdout } = await run("sh", ["-c", `${FILL_INPUT} 2>/dev/null || true`], { cwd: repo });

    expect(stdout).toContain(SECRET);
  });

  it("検証コマンドの中では credential helper が無効化されている", async () => {
    const runner = commandRunner(repo);

    const result = await runner.run(`${FILL_INPUT} 2>&1 || true`);

    expect(result.stdout).not.toContain(SECRET);
  });

  it("helper のリストは空値で reset される。ホスト側の設定より後に効く", async () => {
    // `GIT_CONFIG_COUNT` の組は system / global / local より後に読まれ、
    // `credential.helper` の空値は helper のリストを reset する。
    // 最後に空値が来ていることを、git 自身の解決結果で見る。
    const runner = commandRunner(repo);

    const result = await runner.run("git config --get-all credential.helper || true");

    // 末尾の改行だけを落として、最後の値が空であることを見る。trim() で畳むと
    // その空値ごと消えてしまい、何を見ているのか分からなくなる。
    const values = result.stdout.replace(/\n$/, "").split("\n");
    expect(values).toContain("");
    expect(values.at(-1)).toBe("");
  });

  it("helper が無いときに端末や askpass へ聞きに行かせない", async () => {
    // reset しただけだと、git は端末や askpass に資格情報を尋ねる。
    // ent を対話で回している間だけ、人間が Actor の代わりに答えてしまう。
    expect(NEUTRALIZED_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(NEUTRALIZED_ENV.GIT_ASKPASS).toBe("/usr/bin/false");
  });

  it("ssh の経路も塞ぐ。SSH_AUTH_SOCK を落とすだけでは足りない", () => {
    // 実測では、`SSH_AUTH_SOCK` を消しても `~/.ssh` の鍵で
    // `git ls-remote git@github.com:...` が通った。`HOME` は渡すしかないので
    // （落とすと mise も pnpm も動かない）、ssh を起動する側を潰す。
    expect(WITHHELD_ENV).toContain("SSH_AUTH_SOCK");
    expect(NEUTRALIZED_ENV.GIT_SSH_COMMAND).toBe("/usr/bin/false");
  });

  it("無効化はホスト側の指定より後に置かれる", () => {
    const env = withheldEnv({
      HOME: "/home/x",
      GIT_CONFIG_COUNT: "3",
      GIT_ASKPASS: "/usr/bin/ssh-askpass",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    expect(env.HOME).toBe("/home/x");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
