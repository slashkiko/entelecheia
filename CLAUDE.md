# CLAUDE.md

**ent を使う手順はここに無い。** `.claude/skills/ent/SKILL.md` にある。
このファイルが受け持つのは、ent 自身のコードに手を入れるときの決まりだけになる。

## ent 自身を直す Goal を回すときは、mise の task を通す

```sh
mise run ent -- run <slug>         # dist/ を作り直してから1ティック回す
mise run ent -- list               # 引数は `--` の後ろに置く。サブコマンドはどれでもよい
```

`bin` が指すのは `dist/cli.js` で、`tsc` を通すまで HEAD の実装は1行も反映されない。
Actor が新しい行動を実装し、controller がそれを commit しても、次のティックで動く
`dist/cli.js` は古いままなので、その行動は選択肢に出ない。「実装したのに動かない」の
原因が実装ではなくビルドにあるので、外からは区別が付かない。実際にこれで6ティック空転した。

task の実体は `node dist/cli.js` に `build` への依存を足しただけで、出力も終了コードも
変わらない。mise の進捗は stderr に出るので、stdout は JSON だけのまま `jq` に渡せる。

cron から回すときも、この task を通す。**先に `mise run build` を1回だけ実行して、あとは
`ent run` を直に叩く形にはしない。** その形だと、controller が commit した実装が次の
ティックの `dist/` に入らず、上と同じ空転が起きる。

**cron から回すときは、repo 単位の外部ロックを Goal が1本でも必ず取る。** cron 行を複数
並べると、毎回ビルドが走るぶん1ティックが長くなり、起動時刻が重なってビルド同士が
ぶつかる。前回のティックが次の起動時刻を越えることもある。どちらもロックで止まる。
取れなかった側はその周を起動せずに終わり、次の周で拾うので、ビルドも1本しか走らない。
cron 行の書き方は README の「複数の Goal を同時に回す」にある（ent 自身を直す Goal では、
後ろの `mise run ent -- run` の例を使う）。並べ方は次の節の制約に従う。

## 同じディレクトリから ent を並列で回すのは、まだ確かめていない

`.goals/.state/goals.db` は `process.cwd()` の下にできるので、worktree ごとに別になる。
別の worktree で回している ent とはぶつからない。

**同じディレクトリから複数プロセスを立てたときにぶつかっていた理由は、1つ塞いだ。**
状態 DB は WAL なので、別プロセスが書いたり接続を閉じたりすると checkpoint が走り、
`goals.db` の中身が変わる。保護パスの関門は ACT の前後でこのファイルを sha256 で
比べていたので、先に ACT へ入っていた側が `ESCALATE(protected_path_touched)` で
止まっていた。触ったのは Actor ではなく、もう1本の controller になる。

いまの関門は、この DB をファイルではなく**その Goal に属する行**の論理ダイジェストで
見る（`Store.guardDigest`、issue #62）。checkpoint では動かず、別の Goal の行が
いくら増えても動かない。

**ただし、実際に `ent run` を2本立てて回してはいない。** 確かめたのは
`tests/controller-state-db-writes.test.ts` の中で、同じ `goals.db` を共有する2本の
ティックを同時に流して、どちらも `protected_path_touched` にならないところまでになる。
テストの中の並列なので、プロセスを分けて初めて出るものは映らない。分かっている
残りは2つある。

- 初回の `git worktree add` は本体リポジトリの `.git/index.lock` を取る。同時に
  当たると片方が fatal で落ち、その Run は failed になる（関門ではなく ACT の失敗）
- SQLite の busy 競合。`busy_timeout` は 5 秒で、越えれば `database is locked` になる

この形にあたるのは、README（`README.md` / `README.ja.md`）が「複数の Goal を同時に回す」に
載せている並列のレシピ（`for slug … &`）になる。同じ節の cron の書き方は外部ロックで
重ならないようにしてあるので、ここには当たらない（ロックの規範は前の節に書いた）。

**同じディレクトリの並列は、確かめるまで避ける。** 分けるなら worktree ごとにするほうが
確実で、ただし lease も分かれるので、別 worktree で同じ Goal を回すと両方が PR を立てる。
