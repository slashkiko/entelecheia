/**
 * テストの中の git を、テストを回している人間の設定から切り離す。
 *
 * テストの多くは一時ディレクトリに repo を作り、`git init` から commit まで
 * 実際に流す。その git は global と system の設定をそのまま読むので、
 * **手元の設定がテストの前提を書き換える。** CI の runner には何も無いため、
 * 落ちるのはローカルだけになり、「CI は緑なのに手元が赤い」あるいはその逆で
 * 手元の検査そのものが信用されなくなる。実際に2種類とも踏んだ。
 *
 * - `core.hooksPath` を global に設定していると、作ったばかりの repo でも
 *   値が付く。「まだ差し替えられていない」を `unset` で表す確認が落ちる
 *   （`tests/out-of-sight.test.ts`）
 * - その hooks に commit の author を検査するものが入っていると、
 *   fixture の `t@example.com` が弾かれ、commit を流すテストが軒並み落ちる
 *
 * どちらも production の挙動は正しい。外から設定された hooksPath でも hook は
 * 走るし、commit の author 検査も人間の運用としては正しい。**直すのはテストの
 * 実行環境の側**になる。
 *
 * `/dev/null` を指すのは、空のファイルとして読ませて「設定が無い」に倒すため。
 * repo ローカルの設定（`git init` が書くもの、テストが `git config` で足すもの）は
 * これまでどおり効く。
 *
 * ここを1箇所にしてあるのは、一時 repo を作るテストが十数本あるため。
 * ファイルごとに書くと、新しく足したテストだけが人間の設定を読む。
 */

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
