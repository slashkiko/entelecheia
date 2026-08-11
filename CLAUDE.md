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

cron から回すときは、この task を使わない。毎回ビルドが走るので、分が重なると
ビルド同士がぶつかる。回す前に `mise run build` を1回叩いてから、`ent run` を直に叩く。
並べ方は次の節の制約に従う。

## 同じディレクトリから ent を並列で回さない

`.goals/.state/goals.db` は `process.cwd()` の下にできるので、worktree ごとに別になる。
別の worktree で回している ent とはぶつからない。

ぶつかるのは**同じディレクトリから複数プロセスを立てたとき**になる。状態 DB は WAL で、
別プロセスが書いたり接続を閉じたりすると checkpoint が走り、`goals.db` の中身が変わる。
保護パスの関門は ACT の前後でこのファイルを sha256 で比べるので、先に ACT へ入って
いた側が `ESCALATE(protected_path_touched)` で止まる。触ったのは Actor ではなく、
もう1本の controller になる。

README.md が載せている並列のレシピと cron の書き方はどちらもこの形にあたるので、
いまは使えない。分けるなら worktree ごとにする。ただし lease も分かれるので、
別 worktree で同じ Goal を回すと両方が PR を立てる。

直すには関門の側に手を入れる必要があり、`PROTECTED_PATH_FLOOR` の中なので
ent 自身には回させられない。それまでは1本ずつ回す。
