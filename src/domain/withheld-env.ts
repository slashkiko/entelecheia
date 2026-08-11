/**
 * controller が持っている資格情報を、controller 以外に渡さないための除去リスト。
 *
 * 置き場所を domain にしてあるのは、読み手が2つあるため。Actor を起動する
 * `src/adapters/claude.ts` と、`setup` / `verification.run` を流す
 * `src/adapters/local.ts` の両方がここを見る。片方にだけ持たせると、
 * 「Agent にはトークンを渡さないが、Agent が書いたテストには渡る」という
 * 状態がまた生まれる。実際そうなっていた。
 *
 * 除去リストであって許可リストではない。`verification.run` は `mise run test`
 * のような実コマンドで、PATH / HOME / シェルの設定が無いと動かない。
 * 許可リストにすると「何を足せば動くか」を Goal ごとに調べることになり、
 * 面倒さに負けて丸ごと渡す運用に戻る。
 */

/**
 * Actor（Claude Code）に渡さないもの。
 *
 * SDK の `env` は「マージではなく置き換え」なので、`process.env` を広げてから落とす。
 * Bash を許している以上、`printenv` も `echo $GITHUB_TOKEN` も実行できる。
 * どちらも `secret_access` の拒否パターン（`gh secret` / `gh auth token`）に
 * 一致しないので、拒否リストでは塞げない。push と PR は controller だけが行う
 * 設計なので、Actor 側にトークンが要る場面がそもそも無い。
 */
export const WITHHELD_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/**
 * `setup` と `verification.run` に渡さないもの。
 *
 * VERIFY は criteria のコマンドを worktree で流す。worktree の中身は Actor が
 * 書いたもので、criteria が `mise run test` である以上、これは Actor の書いた
 * テストを controller の権限で実行することにあたる。ここに渡した環境変数は、
 * 保護パスを1つも踏まずに Actor の手に渡る。
 *
 * Actor 側より広く落とす。Claude の資格情報を足してあるのは、検証コマンドが
 * LLM を呼ぶ理由が無いため。どの Goal も constraints に「テストから実際の
 * GitHub と Claude API を叩かない」と書いている。
 */
export const VERIFY_WITHHELD_ENV = [
  ...WITHHELD_ENV,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * 落とすだけでは足りず、**上書きして無効化する**もの。
 *
 * `gh` はトークンの環境変数が無ければ `$HOME/.config/gh/hosts.yml` のログインに
 * 落ちる。除去リストは変数を消すことしかできず、`HOME` は渡すしかないので
 * （渡さないと `mise` も `pnpm` も動かない）、**Actor と検証コマンドの中の `gh` は
 * controller を動かしている人間の認証でそのまま通っていた。**
 *
 * それが効くのは、`type: human` の承認を PR コメントの定型文で行うため
 * （design.md §10-4）。`/ent approve` は PR の作成者が書いても承認として数えるので、
 * Agent が作成者名義でコメントを1件投稿できれば、自分で自分の criterion を通せる。
 *
 * 拒否リスト（`external_send`）だけでは塞げない。あれは glob なので
 * `gh api -X POST`（`--method POST` の別綴り）や `sh -c` 経由の間接呼び出しを
 * 1つ書き落とせば素通りする。**書ける形を数え上げる側ではなく、資格情報そのものを
 * 届かせない側で塞ぐ。** 設定の置き場を実在しないディレクトリへ向けると、`gh` は
 * 未認証として振る舞う。
 *
 * PR の作成もコメントの投稿も controller が行うので、Actor 側に認証済みの `gh` が
 * 要る場面は無い（`COMMON_TAIL` が Agent にもそう書いている）。読み取りに使いたく
 * なったら、それは controller 側の観測（`CodeProviderPort`）に足す話になる。
 */
export const NEUTRALIZED_ENV: Readonly<Record<string, string>> = {
  // ディレクトリではないので、gh は設定を1つも読めない。実在するパスにしてあるのは、
  // 「消し忘れた空文字」ではなく意図した無効化だと読めるようにするため。
  GH_CONFIG_DIR: "/dev/null",
};

/**
 * 除去リストに載っているものを落とした環境変数を作る。
 *
 * 値が `undefined` のものも落とす。`Record<string, string>` を返すのは、
 * child_process の `env` がそれを取るため。
 *
 * 落としたあとに `NEUTRALIZED_ENV` を重ねる。呼び出し側が渡した値より後に置くのは、
 * ホスト側に同じ変数が設定してあっても無効化が勝つようにするため。
 */
export function withheldEnv(
  source: Record<string, string | undefined>,
  withheld: readonly string[] = WITHHELD_ENV,
): Record<string, string> {
  const denied = new Set(withheld);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !denied.has(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...NEUTRALIZED_ENV };
}
