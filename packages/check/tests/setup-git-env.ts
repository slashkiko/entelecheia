/**
 * テストの中の git を、テストを回している人間の設定から切り離す。
 *
 * 一時ディレクトリに repo を作って commit まで流すテストは、global と system の
 * 設定をそのまま読む。手元の hooks や author の検査が、テストの前提を書き換える。
 * 理由の詳細は ent の `tests/setup-git-env.ts` にある。package をまたいで import は
 * できないので、同じ2行をここにも置く。
 */

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
