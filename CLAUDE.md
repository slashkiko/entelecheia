# CLAUDE.md

**ent を使う手順はここに無い。** `.claude/skills/ent/SKILL.md` にある。
このファイルが受け持つのは、ent 自身のコードに手を入れるときの決まりだけになる。

## ent 自身を直す Goal を回すときは、mise の task を通す

```sh
mise run ent -- run <slug>         # dist/ を作り直してから1ティック回す
mise run ent -- list               # 引数は `--` の後ろに置く。サブコマンドはどれでもよい
```

`bin` が指すのは `dist/cli.js` で、`tsc` を通すまで HEAD の実装は1行も反映されない。
Actor が新しい行動を実装して commit しても、回している controller は古いままなので、
その行動は選択肢に出ない。「実装したのに動かない」の原因が実装ではなくビルドに
あるので、外からは区別が付かない。実際にこれで6ティック空転した。

task の実体は `node dist/cli.js` に `build` への依存を足しただけで、出力も終了コードも
変わらない。mise の進捗は stderr に出るので、stdout は JSON だけのまま `jq` に渡せる。

cron と並列で回すときは、この task を使わない。毎回ビルドが走るので、同時に何本も
立てるとビルド同士がぶつかる。回す前に `mise run build` を1回叩いてから、
README.md の並列のレシピどおり `ent run` を直に叩く。

## 同じディレクトリから ent を並列で回さない

`.goals/.state/goals.db` は `process.cwd()` の下にできるので、worktree ごとに別になる。
別の worktree で回している ent とはぶつからない。

ぶつかるのは**同じディレクトリから複数プロセスを立てたとき**になる。状態 DB は WAL で、
別プロセスが書いたり接続を閉じたりすると checkpoint が走り、`goals.db` の中身が変わる。
保護パスの関門は ACT の前後でこのファイルを sha256 で比べるので、先に ACT へ入って
いた側が `ESCALATE(protected_path_touched)` で止まる。触ったのは Actor ではなく、
もう1本の controller になる。

README.md が勧めている並列のレシピと cron の書き方はどちらもこの形にあたる。
直すには関門の側に手を入れる必要があり、`PROTECTED_PATH_FLOOR` の中なので
ent 自身には回させられない。それまでは1本ずつ回す。

## 変更を出すとき

`mise run verify`（typecheck / lint / build / test）と `mise run check`
（サプライチェーンと workflow）を通す。Goal に着手した直後は、仕様を先に書く
進め方なので `test` が落ちる。それは環境の不備ではない。
