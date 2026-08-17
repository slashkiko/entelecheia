# entelecheia

> Declare the end state; the controller converges to it.

**人間はプロジェクトの完了状態（Desired State）を宣言し、controller がそこへ収束させる。**
controller は現在状態を観測し、ギャップが埋まるまでティックを回す。埋め方を決める段で
Claude Code または Codex を起動する。CLI 名は `ent` になる。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に対して実現しようとする状態そのものを指す言葉にあたる。

*[English](README.md) | 日本語*

この README は、設計の要点・現在地・使い方を扱う。設計の全体像・判断の根拠・Phase 計画は
[`docs/design.ja.md`](docs/design.ja.md) にある（英語は
[`docs/design.md`](docs/design.md)）。このリポジトリで作業を始めるときは、まずそれを読む。
以降の本文で `design.md §7` のように書いているのは、日本語版 `design.ja.md` の同じ節を指す。
節番号は両方で揃えてある。

> [!NOTE]
> **本文中の issue と PR の番号は、移行前のリポジトリを指す。** 履歴を書き換えてここへ移して
> あるので、このリポジトリの issue と PR は0件になる。`issue #58` や `PR #34` のように書いて
> あるものはここでは解決せず、issue が立ち始めれば1から採番されるので、同じ番号がいずれ
> 無関係なものに割り当たる。リンクではなく、移行前の記録に付いた符号として読む。

## 設計の要点

**MVP は完了している。** design.md §9 の完了条件9項目はすべて確認した。ただし §9 が問うのは
「controller が最後まで回るか」だけで、「Agent が制御ループを書き換えられないか」はそこに
入っていない。そこで完了後にレビューを1周かけ、自己ホストの安全装置とテストの穴を埋めた。

設計の中核は、**完了判定と暴走の停止条件を LLM に決めさせない**ことにある。LLM に委ねるのは
Gap の埋め方だけになる。以下、1ティックの流れと用語、設計原則と実装状況、guard と LLM の境界、
保護パスの関門、push と PR 作成を人間の手に残す口、Agent に渡さない資格情報、
Goal の状態の置き場所を順に説明する。

### 1ティックの流れと用語

controller は OBSERVE / ASSESS / DECIDE / ACT / VERIFY を回す。PR は controller が自分で立て、
進捗をコメントに積む。そのうえで人間の承認を検知し、COMPLETED まで進む。

**Actor** と呼ぶのは、controller が起動する実行主体の抽象になる。Actor の実装は Claude Code と
Codex CLI の2つがある。その走っている実体を指すときは **Agent** と書く。

### 設計原則と実装状況

下の表は設計原則と実装状況を並べる。「実装」列が示すのは、MVP 完了後のレビューを反映した
現時点の状態になる。

| 原則 | 内容 | 実装 |
|---|---|---|
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない | 済 |
| 確かめられなかったことを黙って落とさない | 「対象が無い」と「対象を確かめられなかった」を区別し、後者は `unobserved` / `unverified` に理由付きで残す | 済 |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria を検証手段（コマンド / Fact 参照 / 人間の承認）に落とせない Goal は ACTIVE にしない | 済 |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない | 済 |
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria。Actor 実装は起動時にphaseごとの既定を人間が選び、ティックごとの上書き・Goal内のActor role・実装手順はcontrollerが決める | 一部（Goalをまたぐ分解は順序の宣言（`goal.depends_on`）まで。分割の判断は人間が持つ（design.md §10-12）） |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる | 済 |
| 隔離は場所だけでは足りない | worktree でファイルを分けるだけでなく、Agent の出力を controller のシェルに流さない・Agent が書いたものを controller の権限で実行しない | 一部（シェルに流さない側は design.md §7 で対応済み、controller の権限で実行しない側は §10-9 が未決） |

### guard と LLM の境界

完了判定と暴走の停止条件は LLM に決めさせない。LLM が選べるのは `ACT` / `VERIFY` / `WAIT` /
`REPLAN` の4つだけになる。`COMPLETE` と `ESCALATE` は純ロジック（guard）が決める。この境界は
`src/decide/` にある。

### 保護パスの関門

自己ホストの安全装置として、`policies.protected_paths` に書いたパスを Agent が編集したら、
controller が ACT の外側で検知して止める。Agent 側の拒否ルールとは別に、controller 自身の
関門を持つ。検知の材料は Agent の自己申告ではなく、git が観測した変更になる。そのため Bash
経由の書き込みも見える。worktree の中だけでなく、その外に出た書き込みも本体リポジトリ側の
git で見る。ただし見えるのはリポジトリの中の変更だけで、範囲と残る穴は design.md §10-6 に
書いてある。

守るのは、制御ループ本体（`src/controller/**`）と Goal の宣言部（`.goals/**`）に加えて、
**関門そのもの（Agent の拒否リストを決めるファイルを含む）と検証系**になる。選び方の基準は
design.md §7 にある。

### push と PR 作成を人間の手に残す

`policies.require_human_approval` が止めるのは Agent の操作で、controller 自身の push と
PR 作成には効かない。そちらを止めるのは `policies.publish` になる。

```yaml
policies:
  publish:
    push_branch: auto
    # チームで使うリポジトリではこう書く。PR の作成はレビュアーへの
    # 通知を伴い、取り消しても通知は戻らない。
    open_pull_request: manual
```

書かなければ、これまでどおり push も PR 作成も自動で進む。`policies` は repo スコープなので、
通常は `.goals/config.yaml` に置く。Goal 側が `publish` を書けばキー単位で上書きする。
`manual` にした段は controller が行わず、そのティックは `WAITING_HUMAN` で止まる。止めた段と、人間が何をすれば進むのかは
`ent get <slug>` の `decision` に出る。

止めたことは `ent run` の出力にも構造で出る。宣言で止めたティックにだけ `publishHold` が
載る。**PR の作成（`open_pull_request`）を止めたときにかぎり**、ティックを叩いている
エージェントが `publishHold` を読んで代わりに PR を立てられる。push を止めた段はブランチが
remote に無いので代行できない。キーの内訳と代行の手順は `.claude/skills/ent/SKILL.md` に
ある。宣言を書いていない Goal ではこのキーは出ないので、いま回している `jq` は1つも変わらない。

2つの段は解け方が違う。`open_pull_request` を止めた場合は、人間が PR を立てれば次のティックが
それを見つけて先へ進む（宣言はそのままでよい）。`push_branch` はそうならない。押さないと決めた
口（`BranchPort.push`）が remote を知る唯一の経路なので、人間が手で押しても controller は
それを観測できない。宣言を `auto` に戻すまで毎ティック止まり続ける。**そのうち予算切れで
`BLOCKED` に落ちて気づく、ということも起きない。** 止めた理由が `budget_exhausted` を
上書きするので、状態は `WAITING_HUMAN` のままになる。

**どちらの段も、止めたことが PR に出るとは限らない。** PR コメントに出るのは、既に PR がある
Goal を途中から `manual` にした場合だけになる。最初から `manual` を書いた Goal では PR が
作られないので、`ent get` と `ent list` を読む以外に気づく経路が無い。宣言で止める運用に
するなら、そこを定期的に読む形を先に用意する。名前を `require_human_approval` と分けた
理由は design.md §7 にある。

### Agent に渡さない資格情報

controller が持つ資格情報（`GITHUB_TOKEN` / `GH_TOKEN` と、`gh auth token` から読んだ token）は
Agent に渡さない。Claude CodeにはOpenAI/Codexの資格情報を、Codexには
Anthropic/Claude Codeの資格情報を渡さず、選んだprovider自身の認証だけを残す。

遮断は環境変数を落とすだけでは足りない。**Agent と検証コマンドの中の `gh` も未認証にする**
（`GH_CONFIG_DIR` を実在しないディレクトリへ向ける）。`HOME` は渡すしかないので、落とすだけでは
ホストのログインが残るからになる。シェルを通す経路も絞る。git は argv 配列で叩き、シェルを
通すのは Goal YAML の `setup` と `verification.run`（およびその下に敷いた
`.goals/config.yaml` の `setup`）だけにする。

`type: human` の承認は、リポジトリに書き込み権限がある人のものだけを数える。レビュー承認は
PR の作成者を除くが、**コメントの定型文は作成者も数える**。1人で回すリポジトリではそこが
唯一の承認経路になるので、Agent がその経路に届かないことが承認の前提になる（design.md §10-4）。

### Goal の状態の置き場所

Goal の状態（ACTIVE / COMPLETED など）は `.goals/.state/goals.db` が持つ。`.goals/*.yaml` は
宣言部だけを持ち、実行時状態は書かない。なお、行動の `COMPLETE` と Goal の状態 `COMPLETED` は
別のものになる。前者が選ばれた結果として、後者になる。

## 現在地とロードマップ

**Phase 3 完了。MVP 完了。** Phase 0 から Phase 3 まで、Goal は合わせて11本になる。以下、
「Phase 3 の内訳」「実際に回すまで、配管は繋がっていると見なせない」「commit は controller が
打つ」「全件が緑でも壊れていることがある」「設計の中核ほど検証コマンドに落ちない」
「Phase ごとの担当範囲」を順に示す。

Goal YAML のスキーマは `src/domain/goal.ts`、repo スコープの側は `src/domain/goal-config.ts`、
観測キーのレジストリは `src/domain/fact-keys.ts` にある。

### Phase 3 の内訳

Phase 3 は自己ホストで、5本に割った。1本目で1ティックの記録が読めるようになり、
2本目で PR の作成・通知・承認の検知が入り、3本目で待機と暴走の制御が入り、
4本目で自己ホストの安全装置が入った。**5本目は controller に実装させた。**

人間がやったのは Goal YAML と Acceptance Criteria を書き、`ent start` してから
`ent run` を繰り返しただけになる。controller は Actor を worktree で走らせ、PR を立て、
進捗をコメントに積み、承認待ちで止まった（`COMPLETED` への遷移そのものは別の Goal で
確認済み。design.md §9）。

### 実際に回すまで、配管は繋がっていると見なせない

Phase 3 とその直後に見つかった断線は、どれもテストでは通っていた。断線は4つある。

1. `git branch --format` の引用符不足で、worktree の作成が Phase 2 からずっと失敗していた
2. VERIFY が worktree ではなく、controller 自身のリポジトリでコマンドを流していた
3. PR がある間、push しなくなっていた（それを仕様として固定したテストが緑のままだった）
4. **Actor が実装を書き切ったまま commit していなかった**

4つ目は壊れ方が違う。push も VERIFY も DECIDE も契約どおりに動いていて、誰も誤った動きを
していない。push は commit 済みの差分しか送らないのに、VERIFY は worktree の作業ツリーを見る。
そのため criteria は全部通るのに remote には何も出ず、controller は承認待ちで止まった。人間が
待っているのは実装が載った PR なので、その待ちは永久に終わらない。**「Actor が commit する」
という前提を、どこも要求していなかった。**

### commit は controller が打つ

**「Actor が commit する」という前提は、いまは置いていない。** 機械側の criteria
（`command` 型）が**全部**通ったティックで、
controller が Actor の書いたものを commit する。Actor に commit を求めても従ったことは
確かめられず、実測でも同じ設定の Actor が commit するティックとしないティックの両方が出た
（design.md §10-11）。保護パスの関門が止めたティックでは commit しない。違反した変更を
履歴に載せないためになる。

**commit したティックでは未 commit の関門を見ない。** `local.dirty` は commit より前の観測なので、
読むと自分が片付けた汚れで自分を止めることになる。受け皿として残るのは、何も commit されなかった
ティックになる（gitignore されたファイルだけが汚れている、commit そのものが失敗した）。書き残しを
解消しない `COMPLETE` / `WAIT` / `VERIFY` のティックに未 commit の変更が残っていれば、
`ESCALATE(uncommitted_changes)` で人間を呼ぶ。読むのは**今ティックの観測が worktree を見て作った**
`local.dirty` だけになる。観測に失敗したティックや worktree がまだ無いティックでは止まらない。

突き合わせる先は、役割が増えた（design.md §4.2）あとも**実装役のブランチ**に固定してある。
検証コマンドと `local.*` を観測する先がそちらで、レビュー役も同じ作業ツリーを読む。止めた理由と
次の一手は、`ent get` と PR のコメントの両方に出す。

### 全件が緑でも壊れていることがある

MVP 完了後のレビューでも、同じ形の穴が残っていた。Port を注入するテストは
`src/adapters/local.ts`（実際の git とシェル）と `src/cli.ts` の `main()` を1行も通らず、
その2つにはテストが1本も無かった。**壊しても全件が緑のまま通る変更が5件あった**（LLM に
`COMPLETE` を許す、Agent の拒否リストを空にする、ダイジェストの正規化から `sort` を消す、
承認 Port の失敗を「検証済み不合格」にする、lease の解放を `finally` から外す）。

いまは実際の git と実際の SQLite に対して回す統合テストがあり、上の5件はそれぞれ1本のテストで
固定してある。統合テストは書いたその場で1件バグを見つけた（`git status --porcelain` の出力を
trim してパスが1文字欠ける。統合テストと同じ変更で入れた誤りで、それ以前のコードには無い）。

**ただし ACT を通る経路は、いまの自動テストでは覆えていない。** `main()` の統合テストが通すのは
guard が `COMPLETE` を選ぶ経路で、Actor も GitHub も呼ばない。上に挙げた断線はどれも実際に外部
（git / GitHub / Actor）を叩く側にあったので、そこは変わらず「実際に `ent run` を回す」でしか
確かめられない。

### 設計の中核ほど検証コマンドに落ちない

Phase 1 と Phase 2 の1本目は、どちらも6本の Acceptance Criteria のうちコマンドで検証する4本を
通しただけでは COMPLETED にならなかった。Phase 1 で残ったのは、CI の結果（`type: fact`）と、
Port の抽象が1実装に癒着していないかの確認（`type: human`）になる。Phase 2 の1本目で残ったのは、
CI の結果と、guard と LLM の境界が妥当かの確認（`type: human`）になる。

### Phase ごとの担当範囲

下の表は、controller が回す範囲を累積で示す。各行はそのフェーズを**完了した時点**の
累積範囲になる。数えているのは controller が回す段階であって、コードの有無ではない。
起動の主体は「controller が回す範囲」の列には数えていない。

1ティックの内側に人間の判断が入らなくなるのは、Phase 2 を完了した時点からになる。起動そのものは
cron が担う。常駐プロセスは作らない（design.md §3.6）。

| Phase | controller が回す範囲（累積） | 人間が担う |
|---|---|---|
| 0 | なし | OBSERVE / ASSESS / DECIDE / ACT / VERIFY のすべて |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT と、全段階の起動 |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | Goal を書く、承認する |
| 3 | Phase 2 と同じ範囲を、このリポジトリ自身に対して回す（自己ホスト） | Goal を書く、承認する |

Phase 3 を完了した時点で、ティックの起動にも人間の判断は要らなくなる。人間に残るのは Goal を
書くことと、PR に `/ent approve <criterion-id>` と書くこと（あるいは GitHub のレビューで
Approve を押すこと）の2つになる。

## 入れる

**読み手が2種類いる。** ent を「使うだけ」の人と、ent 自身を直す人になる。
必要なものが違うので、入口も分ける。

### 使う側のセットアップ

**ent の実行に mise も pnpm も tsc も要らない。** `src/` に mise への参照は1つも無く、
`ent doctor` が見るものにも入っていない。残るのは Node 24 以上と
[gh](https://cli.github.com/) と Actor（Claude Code / Codex）のログインの3つになる。

ビルド済みの `dist/cli.js` を持つ checkout が1つあれば、そこから PATH に `ent` を張れる。

```sh
cd /path/to/entelecheia
pnpm link --global    # package.json の bin（dist/cli.js）を global の bin に張る
```

`dist/cli.js` には shebang があるので、張った symlink をそのまま叩ける。
`"private": true` のままで効く（npm への公開とは別の話になる）。剥がすときは
`pnpm uninstall --global entelecheia` を叩く。

**張る先は checkout の中の `dist/cli.js` で、コピーではない。** ent 本体を作り直せば
`ent` が指す実体も入れ替わる。逆に、`dist/` がまだ無い checkout に張ると symlink の先に
何も無い状態になるので、その checkout では下の「作る側のセットアップ」を1度だけ通す。

起動する Node は shebang の `/usr/bin/env node` が選ぶ。mise や nvm を効かせた shell から
叩くと対象リポジトリ側の Node が使われるので、24 未満だと `node:sqlite` の import で落ちる。
どの Node で動いているかは `ent doctor` の `node` が出す。symlink を経由せず、Node の絶対
パスを固定して `dist/cli.js` を直に呼ぶ形でもよい（「ent を動かす」の節にその例がある）。

### 作る側のセットアップ

ent 自身を直すなら、[mise](https://mise.jdx.dev/) と [gh](https://cli.github.com/) が
入っていること。Node と pnpm のバージョンは `mise.toml` で固定してあるので、個別に
入れる必要はない。

```sh
mise trust        # clone 直後の1回だけ。これが無いと次の行が trust エラーで止まる
mise install --locked
pnpm install --frozen-lockfile
mise run build    # dist/cli.js を作る。使う側に渡すのはこの成果物になる
```

**1行目の `mise trust` は環境の不備ではなく手順の一部になる。** mise は信頼していない
`mise.toml` を読まないので、飛ばすと `mise install --locked` が
`Config files ... are not trusted.` で止まる。

## 検証

```sh
mise run verify   # typecheck / lint / build / test をまとめて実行
mise run check    # サプライチェーンと workflow のチェック（baseline 由来）
```

`verify` に `build` が入っているのは、型が通ることと `dist/cli.js` が出来ることが
別だからになる。`tsconfig.json` は `noEmit` で `tests/**` を含む。`bin` の実体を作るのは
`tsconfig.build.json` の側になる。

**Goal に着手した直後は `typecheck` と `test` が落ちる。** Acceptance Criteria を先に書く
進め方に由来する想定内の状態であって、環境の不備ではない。落ちる件数まで含めて、その Goal の
`desired_state` が着手時点の実測として宣言する。main の CI（`.github/workflows/verify.yml`）も、
そのあいだは赤いままになる。

落ちるのが仕様テストだけなら、`lint` と `build` と `check` は通る（`build` は `tests/**` を
見ないため）。どの Goal に着手しているかは `ent list` で読む。**この README には
書かない。** 書くと、着手のたびに直す場所が1つ増え、直し忘れると「落ちる」と言い続ける。

## ent を動かす

**`ent` は起動のたびに1ティックだけ回して終了する。** 前半はこのリポジトリで1本回すための
手順を扱う。コマンドの一覧に続けて、「共通のオプション」「provider・model・effort を選ぶ」
「Codex を使うとき」「関門の基準になる commit」「起動の仕方と、ent 自身を直すときの例外」の
順になる。後半は運用にあたる。「この repo の外のリポジトリで使う」「恒久的に落ちる workflow を
数から外す」「リポジトリごとに1度だけ宣言する」「進捗を PR に投稿しない」「PR を draft で立てる」
「粗いタスクを複数の Goal に割る」「複数の Goal を同時に回す」の7つが続く。

```sh
mise run build                     # dist/cli.js を作る
ENT_NODE="$(mise which node)"       # Node 24以上の絶対パスを先に固定する
alias ent="$ENT_NODE $(pwd)/dist/cli.js"

ent init                           # いまのリポジトリを回せる状態にする（冪等）
ent plan --desire "…"              # 散文のゴールをサブ Goal の宣言に分解する
ent plan --desire "…" --dry-run    # 検証まで済ませて、書かずに出す
ent start <slug>                   # Goal を登録して ACTIVE にする
ent run <slug>                     # 1ティック回して終了する
ent run <slug> --pr <n>            # 観測対象の PR を指定する（controller が立てた分は自動）
ent run <slug> --issue <n>         # 観測対象の Issue を指定する
ent run <slug> --dry-run           # 書かずに、次のティックの中身だけを見る
ent run <slug> --report stdout     # 進捗を PR に投稿せず、手元に出す
ent get <slug>                     # 宣言部と実行時状態をまとめて表示する
ent abandon <slug> --reason "…"    # もう追わないと宣言して終端にする（理由は必須）
ent list                           # 登録済みの Goal を一覧する
ent doctor                         # 回す前の前提が揃っているかを読み取り専用で調べる
ent agent-context                  # CLI の構造を機械可読な JSON で出す
```

### 共通のオプション

`--json` は出力を JSON にする（`run` / `get` / `list` は既定で JSON。`start` と `abandon` と
`init` は `--json` を付けたときだけ JSON になる）。`doctor` と `agent-context` は常に JSON で、
`--json` は受け取らない。`--limit <n>` は `get` / `list` の件数を絞る。既定でも上限で切り、
切れたときだけ絞り込み方が stderr に出る。エージェント向けの手順は
`.claude/skills/ent/SKILL.md` に置いてある。

### provider・model・effort を選ぶ

provider・model・effort は `DECIDE`、`PLAN`、`IMPLEMENT`、`REVIEW`、`INVESTIGATE` ごとに
選べる（`PLAN` だけはティックの外で動くが、選び方は同じ）。
`ENT_<PHASE>_ACTOR` / `ENT_<PHASE>_MODEL` / `ENT_<PHASE>_EFFORT` がphase固有の指定で、
無ければ共通の `ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT` へ落ちる。providerの未指定時は、
既存の挙動を保つため `claude-code` になる。

effortの有効値はproviderごとに異なる。Claude Codeは`low / medium / high / xhigh / max`、
Codexは`none / minimal / low / medium / high / xhigh`を受け付ける。

```sh
ENT_ACTOR=codex ent doctor
ENT_ACTOR=codex ent run <slug>

# DECIDEだけCodex、実装はClaude Code、レビューは別モデル
ENT_DECIDE_ACTOR=codex \
ENT_IMPLEMENT_ACTOR=claude-code \
ENT_REVIEW_MODEL=<model> \
ent run <slug>
```

環境変数が決めるのは**既定**になる。ティックごとの上書きは DECIDE が持っていて、
`ACT` に `agent` を添えて返せば、その1回だけ別の provider・model・effort で走る。

```json
{"type":"ACT","intent":"fix the failing test","agent":{"actor":"codex","effort":"high"}}
```

`actor` は必須で、`model` と `effort` は任意になる。省いた分は名指しした provider の
既定で走り、そのphaseの環境変数からは引き継がない。**名指しできるのは環境変数で
既に選ばれている provider だけ**で、その外を指した出力と、provider に無い effort を
書いた出力は起動前に弾く。ACT の予算は減らない。

添えなかった ACT はこれまでどおり環境変数の選択で走る。名指しされた provider は
Run に残るので `ent get` から読める。model と effort は Run の列に無く、
Decision の rationale（`ACT(implement on codex/high: ...)`）に出る。

**DECIDE 自身の provider はこの経路では選べない。** `agent` を返す時点で DECIDE は
もう走っており、自分を起動し直すことはできない。decide phase は環境変数だけになる。

### Codex を使うとき

Codexを含むphaseが1つでもあれば、先に `codex login status` でログインを確かめる。
`ent doctor` は選択結果にClaude CodeとCodexが混ざる場合、両方のログイン前提を出す。

Codex Adapter は公式の非対話モード `codex exec --json` を使う。実装役は
`workspace-write`、レビュー役と調査役は `read-only` に固定し、ユーザーの
`config.toml` と execpolicy rules は読み込まない。Codexの非対話CLIにはClaude Agent
SDKと同じcommand単位のallow/deny設定が無い。そのため禁止操作はsandbox、プロンプト、
資格情報の除去、ティック末尾のgit関門を重ねて止める。完全に同じ権限制御ではないので、
Codexは自動選択せず明示的なopt-inにしてある。

失敗の扱いも分けてある。CodexのJSONLに最終メッセージがあっても、その後に`turn.failed`または
`error`が来た実行は失敗として扱う。stdoutに加えてstderrもRunの生ログへ残す。Actorが使用量上限で
止まった場合は、失敗分類とトークンをRunへ保存したうえで、guardが当該ACTを`WAIT(usage_limit)`へ
差し替える。その結果、Goalは`WAITING_EXTERNAL(usage_limit)`へ遷移する。

Codexには公式のTypeScript SDKもあるが、いまは使っていない。現行SDKはCodex CLIをJSONLで起動する
ラッパーで、このAdapterが隔離契約に使う `--ephemeral`、`--ignore-user-config`、`--ignore-rules` を
公開オプションから渡せないからになる。そのため、現時点では `codex exec` を直接起動する。

### 関門の基準になる commit

`ent start` は、そのとき叩いたディレクトリの HEAD を**関門の基準**として記録する。
Actor の worktree はその commit から切られ、関門が worktree の差分を取る
相手も同じ commit になる（worktree の外に出た書き込みの検知は別の経路で、
本体リポジトリ側の ACT 前後の差を見る）。**Goal の宣言と仕様は、`ent start` より前に
commit しておく。** そうすれば人間が書いた分は基準の側に入り、worktree の差分には
Actor が書いた分だけが並ぶ。

記録するのは、Run が1件も無い Goal に `ent start` を打ったときだけになる。走行中の
Goal に打ち直しても基準は動かない。worktree は最初の基準から切られたまま残るので、
基準だけを動かすと「切った元」と「比べる相手」がずれるからになる。

基準にした commit は、回している間 amend も rebase もしない。分岐点が消えると
差分を取れなくなり、`ESCALATE(guard_unavailable)` で止まる。PR の宛先は
`default_branch` のままになる。HEAD を読めなかった場合とこの記録より前に start した
Goal は、従来どおり `default_branch` を基準にする（そのときは人間が書いた分も
Actor の編集として並ぶ）。

### 起動の仕方と、ent 自身を直すときの例外

`package.json` の `bin` に `ent` を登録してあるが、npm へ公開していない。
PATH に通すだけなら `pnpm link --global` で足りる（「入れる」の節）。
ここから先はNode 24以上の絶対パスを使うaliasか、同じNodeで`dist/cli.js`を呼ぶ形で書く。
起動するNodeを自分で決められるので、mise や nvm が効く shell でも取り違えが起きない
（ent 自身を直す Goal だけは下の task を通す）。

常駐しない。`run` はどのティックも有限時間で終了し、待ちは Goal の状態として残る。
ただし `goal.depends_on` の依存待ちだけは lease を取らないので状態に残らず、
`ent run` の `skipped` にしか出ない（design.md §10-12）。
継続して回すなら cron から `run` を叩く。

**ent 自身を直す Goal を回すときは `mise run ent -- run <slug>` を使う。**
`tsc` を通すまで HEAD の実装は `dist/cli.js` に入らないので、直に叩くと古い
controller が回り続ける。理由と例外は `CLAUDE.md` にある。

### この repo の外のリポジトリで使う

**ent 本体の置き場所と、回す対象のリポジトリは別でよい。** `ent` は「いま居る
ディレクトリ」を対象リポジトリとして扱う（`repoRoot = process.cwd()`）。そのため
ent はどこかに1つビルドしておき、対象リポジトリのルートで叩けばよい。
対象リポジトリに ent を入れる必要も、依存を足す必要もない。

```sh
cd /path/to/entelecheia && mise run build
ENT_NODE="$(mise which node)"       # この時点でNode 24以上の絶対パスを固定する
alias ent="$ENT_NODE /path/to/entelecheia/dist/cli.js"

cd /path/to/your-repo
ent init            # .goals/ と .gitignore の行と config.yaml と Goal の雛形を置く
ent doctor          # その場所で回せるかを読み取り専用で調べる
```

他の人と共有しているリポジトリでは `--private-goals` を付ける。無視の行は `info/exclude` へ書き、
tracked なファイルを1つも触らず、宣言部は controller が worktree へ配る。
「[チームのリポジトリで、`.goals/` を commit せずに回す](#チームのリポジトリでgoals-を-commit-せずに回す)」を見る。

`ent init` は冪等で、既にある `.goals/*.yaml` も `.goals/config.yaml` も上書きせず、
`.gitignore` に同じ行を二重に足さない。git リポジトリでなければ何も作らずに終了コード 1 で
断る。`desired_state` と `acceptance_criteria` は人間が書く。CI の criterion の書き方は
「[恒久的に落ちる workflow を数から外す](#恒久的に落ちる-workflow-を数から外す)」の
`[!IMPORTANT]` を見る。

`.goals/config.yaml` は、Goal ごとではなくリポジトリごとに決まる分を持つ
（「[リポジトリごとに1度だけ宣言する](#リポジトリごとに1度だけ宣言する)」）。`repository` は
`origin` と現在のブランチから読めた分を埋め、読めなければ `your-org/your-repo` のままになる。
Goal の雛形はそのぶんを書かないので、**雛形だけではスキーマを満たさない。config.yaml を
敷いて初めて通る。** `ent init` は同じ1周で両方を置く。

**`ent init` は対象リポジトリの外にも書く。** `~/.claude/skills/ent` に、ent 本体の
`.claude/skills/ent` を指すシンボリックリンクを張る。対象リポジトリで作業するエージェントが、
ent の手順書を Claude Code の skill として読めるようにするため。張る先を user scope にするのは、
ent 本体がマシンに1つ入るからになる。対象リポジトリの中に張ると、向け先が ent 本体の絶対パスで
マシン固有になり、commit すれば他の人の手元で壊れる。実体は写さないので、ent 本体を更新すれば
リンクの辿り先も一緒に新しくなる。対象リポジトリの外で触るのは `$HOME` だけで、対象リポジトリ側に
`.claude/` は増えない。

**この名前を黙って乗っ取ることはしない。** `~/.claude/skills/ent` に、この ent へのリンク以外の
ものが既にある場合——別の場所を指すリンク、壊れたリンク、人間が書いた実体のディレクトリの
いずれか——init は実行全体を終了コード 1 で断り、`$HOME` にもリポジトリにも何も作らない
（`.goals/` すら作らない）。どちらが正かを決めるのは ent ではない。既にあるものを退避してから
叩き直す。既にここを指していれば触らずに残す。冪等が成り立つのはここで、2度目は張り直しも
書き換えもしない。ent 本体の `.claude/skills/ent` が見当たらないとき（ビルド成果物だけを配った
場合など）は、断らずにその旨を stderr へ出してリンク無しで終わる。

`--json` を付けると、この1件も他と同じく `entries` に載る。初回は `created`、2度目からは `kept`
になる。`path` はリポジトリの中のものが相対なのに対し、これだけ絶対パスで出す。リポジトリの外に
置いた1件は、そう読めなければならない。外すときはシンボリックリンクを消す。

**起動する Node を固定する。** `node:sqlite` を使うので Node 24 以上が要る。
`/usr/bin/env node` に任せると、対象リポジトリ側の mise や nvm が効いて古い Node が
選ばれることがある。`ent doctor` の `node_version` がその場で言う。

対象リポジトリ側では `.goals/.state/` が gitignore されていることを確かめる
（`ent doctor` の `state_ignored`）。状態 DB と worktree と Agent の生ログが
そこに入るので、載せると commit に混ざる。

いま残っている制約が3つある。

- lease は `.goals/.state/goals.db` にあり gitignore 済みなので、**端末をまたいだ
  排他は効かない**（2台が同じ Goal を回すと両方が PR を立てる）
- `PROTECTED_PATH_FLOOR` は entelecheia 固有のパスを含むので、対象リポジトリに
  同じ名前のパス（`src/controller/**` など）があると、Agent がそこを触った時点で
  **誤って**違反になる
- **逆に、下限の保護パスは ent 自身のコードには届かない。** ent 本体は対象
  リポジトリの外にあるので、`src/controller/**` のような行は ent のソースを
  指さない。上の項目が「対象リポジトリ側に同名のパスがあると誤検知する」話なのに
  対し、こちらは「ent 本体を守る用途には使えない」話になる。**関門が守るのは
  対象リポジトリの中であって、ent 自身のコードではない**（自己ホストのときだけ
  両方が重なる）。対象リポジトリで意味を持つのは `.goals/**` と `.git/**` と
  `.goals/.state/**` の3つになる。後ろの2つは `git status` に出ないが、
  `.git/hooks/**` と `core.hooksPath` は ACT の前後で指紋を比べる別経路
  （`outOfSightState`）が、`.goals/.state/goals.db` とレビュー役の完了した Run の
  生ログ（`.goals/.state/runs/<id>/log.jsonl`）はその Goal に属する行から作る
  論理ダイジェスト（`Store.guardDigest`）が見ており、そこから関門に繋がる。
  生ログまで見るのは、その本文が `review.verdict` の Fact になるからで、
  行を守っても指す先を守らなければ verdict を偽造できる。
  見えないまま残るのは、この2つ以外の gitignore されたパスと repoRoot の外に
  なる（design.md §10-6 の穴 (a)(b)）。**`--private-goals` はその穴を宣言部まで
  広げる。** `.goals/` ごと無視するので、Goal YAML も `config.yaml` も——worktree の
  中だけでなく repoRoot 側も——見えない側に入り、どちらへの編集も関門に届かなくなる

### 恒久的に落ちる workflow を数から外す

`github.ci.failed_job_count` は head sha に紐づく**全 workflow run**を横断して、落ちている
job を数える。`{ type: fact, key: github.ci.failed_job_count, equals: 0 }` と書けば
「この commit で落ちている job が1つも無い」を criteria にできる。

**除外が効くのは `github.ci.failed_job_count` だけ。** いま `.goals/` にある Goal 31 本のうち、
CI を見ている 29 本は**すべて** criterion を
`{ type: fact, key: github.ci.conclusion, equals: success }` で書いており、
こちらは最新の run 1本の結論のままになる（下の「外れるのは数だけ」）。つまり宣言に
`exclude_workflows` を書き足しても、**既存の Goal の判定は1つも動かない。** 除外を効かせるには、
その Goal の criterion を `github.ci.conclusion` から `github.ci.failed_job_count` に移す必要がある。
移すかどうかは Goal ごとの判断になる（`conclusion` は1本の結論しか見ないので、
issue #58 の誤収束はそちらに残る）。

横断するので、**リポジトリの運用として意図的に赤いまま／保留のままにしてある workflow も
対象に入る。**「特定の人のレビューが通るまで mergeable にしない」種類の workflow がそれで、
落ちれば数に加わり、承認待ちのまま `completed` にならなければ数そのものが確定しない。
どちらにしても `equals: 0` は埋まらない。外すなら宣言部に書く。`ci` は `repository` の下の
キーなので、1本の Goal だけの話でなければ `.goals/config.yaml` に置く。

```yaml
# .goals/config.yaml
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
  ci:
    # .github/workflows/*.yml の name: で書く（PR の checks 欄には job 名や
    # third-party の check run も並ぶので、そこからは取らない）
    exclude_workflows:
      - Require owner approval
```

`exclude_workflows` を書かなければ、`failed_job_count` は全 workflow run を数える。

**外れるのは workflow run ごと**で、job 名では書けない。数が確定するのは「未確定の run が
1本も無い」ときなので、承認待ちで `completed` にならない gate は run ごと外さないと数が
永久に決まらない。job 名で外しても run の status は動かない。

**外れるのは数だけ。** `github.ci.conclusion` は最新の run 1本の結論のままで、除外を書いても
選び方は変わらない。宣言を1行足しただけで既存の `conclusion == success` の意味が動く形に
しないため。

> [!IMPORTANT]
> **新しい Goal の CI の criterion は `github.ci.failed_job_count` で書く。**
> `github.ci.conclusion == success` は最新の run 1本しか見ないので、他の run が
> 落ちていても通る（issue #58）。除外が効くのも `failed_job_count` の側だけになる。
>
> ```yaml
> - id: ac-5
>   description: 変更を載せた PR の CI で、落ちている job が1つも無い
>   verification: { type: fact, key: github.ci.failed_job_count, equals: 0 }
> ```
>
> 既にある Goal がまだ `conclusion` で書かれているのは、`failed_job_count` より先に
> あったからで、意味が正しいからではない。回っている Goal の判定を後から変えないために
> そのまま残してある。

**ただし `github.ci.failed_jobs` からも外れる。** 失敗ジョブの名前とログ URL を集めるのは
除外したあとの run なので、外した run の失敗ジョブは数だけでなくこの Fact からも消える。
**次の ACT に渡る材料が除外分だけ欠ける**ことになる。残す側に倒すと「数から外した＝直さなくて
よい」と宣言したはずの失敗を ACT に渡すことになり、除外の意味が消えるので、消す側に倒してある。
外した run に何が起きていたかは、次に書く `github.ci.excluded_workflows` の状態から読む。

**外せるのは GitHub Actions の workflow run だけ。** この数はもともと Actions の run の job
しか数えていないので、third-party の check run や branch protection の required review は
最初から入っていない。そういう gate をここに書いても何も起きない。

除外した結果は隠れない。何をいくつ外したかが `github.ci.excluded_workflows` の Fact と
`failed_job_count` の detail の両方に出て、criteria の判定結果（進捗コメントの detail 列）
にも載る。「全部緑」と「除外した上で緑」が同じ見た目にならないようにしてある。

```sh
ent get <slug> | jq '.snapshot.facts[] | select(.key == "github.ci.excluded_workflows")'
```

外した run 1本ずつの見え方（`waiting` / `failure` / `success` …）も添える。detail 側では
`excluded: Require owner approval (1 run / waiting)` の形になる。**数だけだと「保留のままの gate を
外した」と「本物の失敗を含む run を外した」を読み分けられない。** 失敗ジョブの側からも消える
以上、消えたものが赤かったかはここでしか読めない。終わっている run は結論、終わっていない
run は status を出す（その run について読める中でいちばん強い情報がそれになる）。

一致しなかった名前は弾かず、`runs: 0` として観測に出す。名前が実在するかは、宣言を読む
時点では決められない。解析はリポジトリを見ないし、`ent doctor` から見ても対象リポジトリは
手元の checkout とは限らない。そもそも「一致しない」は typo と「今回は起動しなかった
workflow」（path filter や branch filter で走らないことがある）の両方を指すので、観測の
側から区別できない。数を出して人間に読ませる方に倒してある。

**run が 100 本を超えると数は出ない。** `GET /actions/runs` は `per_page: 100` の1ページしか
読まない。応答の `total_count` が返ってきた件数を上回るとき——つまり読み切れていないとき——は、
`failed_job_count` を Fact にしない。読んでいない run に落ちているものがあっても数に入らず、
`failed_job_count=0` が「全部緑」と区別の付かない形で出てしまうため。数え切れていないなら
数を出さない、という「回っている run があるあいだは出さない」と同じ規則になる。
`total_count` そのものが応答に無いときも同じ扱いにする（読み切れたと決める根拠が無いため）。

このとき criterion は**永久に埋まらない。** 誤って緑になるよりは埋まらない方がよいという
判断だが、収束しない経路が1本増えたことになる。数が出ないまま止まっているときは、まず
run の本数を疑う。**除外はページを取ったあとに走る**ので、除外予定の run も 100 本の枠を
消費する。`on: pull_request_review` の gate はレビューのたびに run が増えるため、
ちょうど除外を使いたいリポジトリで先に上限に当たりやすい。

ページングは実装していない。2ページ目以降を引くと、`mise run check` が回す pinact と同じ
GitHub API のレート制限の枠を run の本数だけ食う。1ティックあたりの往復が読めなくなる方が、
数が出ないより重いと見た。

### リポジトリごとに1度だけ宣言する

`repository` と `setup` と `policies` は、Goal ではなくリポジトリが決める。Goal YAML 全部に
書くと同じ文面が N 本並び、運用を1つ変えるたびに全部を直すことになる。`.goals/config.yaml` に
1度書けば、`.goals/` の下の Goal 全部がそれを受け取る。

```yaml
# .goals/config.yaml
version: 1
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
setup:
  - pnpm install --frozen-lockfile
policies:
  require_human_approval: [merge, force_push, push_to_default_branch, deploy, secret_access, external_send]
  protected_paths: []
```

`version: 1` だけが必須で、その下は全部書かなくてよい。Goal とこのファイルの重なり方は
3つの規則で決まる。

- **Goal が書いた値は必ず残る。** 混ぜるのは検証の前で、サブツリーではなくキー単位になる。
  `repository.owner` を書いて `repository.ci` を書いていない Goal は、owner を保ったまま
  `ci` だけをここから受け取る
- **`require_human_approval` と `protected_paths` は足す。置き換えない。** 下限なので、
  リポジトリが閉じたゲートを Goal から開けられない。`APPROVAL_GATE_FLOOR` と
  `PROTECTED_PATH_FLOOR` はその下でこれまでどおり効く。残り（`setup` を含む）は置き換える
- **Goal 固有のキーはここに書けない。** `goal` / `acceptance_criteria` / `context` / `budget` は
  書いた時点で落ちる。とくに停止条件を Goal から出さないのは、リポジトリ側の既定に逃がすと
  Goal YAML を1本読んでもいつ止まるのか分からなくなるため

ファイルが無ければ何も変わらない。全部を自分で書いている Goal は、これまでと同じに読める。
`config` は予約 slug で、slug を取るサブコマンド（`start` / `run` / `get` / `abandon`）は
どれもこのファイルを Goal として読まずに断る。`doctor` も宣言の数に入れない。

#### チームのリポジトリで、`.goals/` を commit せずに回す

他の人と共有しているリポジトリで自分だけ ent を使うとき、宣言部を相手の履歴に載せたくない。
`ent init --private-goals` がその形を作る。

```sh
ent init --private-goals
```

素の `ent init` との違いは1つ、**tracked なファイルを1つも触らない**ことになる。無視の行は
`info/exclude`——checkout ごとに持つもので、commit されない——へ書き、`.goals/.state/` ではなく
`.goals/` ごと無視する。`.gitignore` は読みも書きもしないので、`git status` は綺麗なまま残る。

ディレクトリごと無視すると、本来はレビュー役が読む材料を失う。`git worktree add` が持ってくるのは
tracked なファイルだけなので、無視した `.goals/` は Actor の作業ツリーに現れない。レビュー役は
そこの `.goals/<id>.yaml` を読めと指示されている。代わりに controller が配る——役を起動する
たびに、Goal YAML と `config.yaml` をそこへ写す。

**配るのは git が無視しているものだけになる。** git から見えるパスに置くと untracked な
ファイルが1本増え、`changedPaths` に出て、触ってもいない Actor を
`protected_path_touched` で止める。`add --all` もそれを PR の diff に入れる。無視されていれば
どちらにも現れない。写しは役を起動するたびに置き直すので、Actor が自分の写しを書き換えても
（無視されている＝関門から見えない）、次の役が読む前に捨てられる。

逆の側はそのままにしてある。**`.goals/` を commit している構成では、古い worktree の中の
写しは古いまま残る。** tracked なファイルを配り直すと、その差分が Actor の編集として関門に並ぶ。

### 進捗を PR に投稿しない

既定では、criteria の pass 状況を PR コメントに積む。`--report` を付けると、その pass 状況を
PR ではなく手元に出す。

```sh
ent run <slug> --report stdout                        # 出力 JSON の report.body に入る
ent run <slug> --report stdout | jq -r .report.body   # 表として読む
ent run <slug> --report ./progress.md                 # ファイルに追記する
```

移るのは進捗の宛先で、そこに**レビュー本文が1節ぶん増える**（後述）。観測も判断も
変わらないし、Actor が書いたものの push と PR の作成も止めない。
**PR そのものは今までどおり公開される。** 投稿しなくなるのは criteria の pass 状況で、
試走のたびにレビュー中の PR を伸ばしたくないときに使う。

進捗は `GITHUB_TOKEN` が無くても、PR がまだ立っていなくても出る。進捗を書くのを PR の確保より
前に置いてあるので、PR を確保できるかどうかとは切り離されている。

`stdout` を指定しても素の Markdown は流れない。`run` の標準出力は JSON 専用で、
本文は `report.body` に入る。受け取るのは `run` だけで、`--dry-run` とは併用できない。
JSON に何が入るか、書けなかったときにどうなるかは `.claude/skills/ent/SKILL.md` にある。

**毎回ではなく恒久的に投稿を止めるなら、宣言に書く。** `policies.progress.report` はフラグと
同じ値を取り、既定を表す `pr` が増える。リポジトリ全体で決まるものなら `.goals/config.yaml` に
置く。

```yaml
policies:
  progress:
    report: stdout      # pr（既定）/ stdout / ファイルのパス
```

`--report` を付けたティックはそちらが勝つ。宣言は毎周に効き、フラグはその1周にしか効かないので、
手元に出したい1回を出せる側を上に置く。フラグと違い、宣言と `--dry-run` はエラーにしない——
dry-run は publish を通らないのでどちらにせよ何も書かれず、断ると宣言を書いただけで
dry-run が打てなくなる。

**この出力には、レビュー役が最後に返したレビュー本文も `## Review role message` の節として
付く。** レビュー役の返答は Fact になる過程で `review.verdict` と `review.reviewed_sha` の
2つに畳まれるので、`approved` の理由も留保も、そのままでは誰も読めないまま
`.goals/.state/runs/<id>/log.jsonl` に残るだけになる。節は `report.body` の**末尾**に置く。
criteria の表の位置は宛先を問わず同じで、長いレビュー本文を読み飛ばさなくても pass 状況に
届く。レビュー本文は要約せず、改行も表もコードブロックもそのまま出す。

節が出るのは、進捗の宛先が PR の外へ移ったティックだけになる（`--report` を付けたか、
`policies.progress.report` に `stdout` かパスを書いたか）。PR コメントには載せないので、
`report.body` と PR コメントは同じ内容でなくなる。レビュー役を1度も起動していない
Goal では節そのものが出ない。生ログを読めなかったときは理由が、レビュー本文が残っていない
Run（途中で切れた実行）では読んだ Run の id が節に出る。**どの経路でも黙って欠落させないし、
ティックも失敗させない。**

> [!NOTE]
> **積まれ方は2つの宛先で違う。** `stdout` は1回叩いて1回出すので積み上がらないが、パスを
> 指定するとファイルへの**追記**になる。フラグでもそうなるが、効きが大きいのは宣言のほうで、
> `policies.progress.report` にパスを書くと cron の毎周ぶんが永久に積まれる。節が読むのは直近の完了したレビュー役の
> Run なので、次のレビューが終わるまで中身は毎ティック同じで、レビュー待ちで回し続けると
> 同じ本文が回した数だけ並ぶ。長く回すなら `stdout` を使うか、宛先のファイルを分ける。

### PR を draft で立てる

対象リポジトリに「まず draft で出す」運用があるなら、`repository.pull_request.draft` に
書く。`repository` の下のキーなので、1本の Goal だけの話でなければ `.goals/config.yaml` に置く。

```yaml
# .goals/config.yaml
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
  pull_request:
    draft: true
```

**書かなければ、これまでどおり ready で立つ。** 既定は変えていないので、既存の
`.goals/*.yaml` は1本も挙動が変わらない。

効くのは PR を作るときだけになる。既に立っている PR を draft に戻すことはしない。
publish は作成後の PR のタイトルも本文も書き換えない（毎ティック書き換えると
レビューが差分を追えなくなる）ので、そこと揃えてある。

draft で立てておくと、タイトル規約や PR テンプレートに合わせる手直しを、レビュアーへの
通知より前に済ませられる。**そのタイトルと本文そのものを宣言で決める口はまだ無い。**
タイトルは `goal.name` のまま、本文は ent 固定のテンプレートで作られる。

> [!WARNING]
> 対象リポジトリの workflow が draft の PR を除外している
> （`if: github.event.pull_request.draft == false` など）と、**CI が一度も走らない。**
> 走らなければ `github.ci.*` の Fact は1つも作られないので、それを読む `type: fact` の
> criterion は解決しないまま残り、Goal は `max_unchanged_reconciles` に当たるまで
> 同じところを回る。draft を宣言する前に、対象リポジトリの workflow が draft を
> どう扱うかを見る。

### 粗いタスクを複数の Goal に割る

1つの粗いタスクを N 本の Goal に割ったら、順序は `goal.depends_on` に書く
（design.md §10-12）。

```yaml
goal:
  id: wire-it-up
  name: 配線する
  desired_state: |
    …
  depends_on:
    - build-the-thing
```

依存がすべて COMPLETED になるまで、`ent run` はそのティックを回さずに終了する。
**lease も取らない。** 待っているだけの Goal が枠を持ち続けると、進める側の Goal まで
cron の1周で回らなくなるからになる。判定は `ent start` ではなくティックの入口で行うので、
依存先をまだ start していない順序で宣言を書いてよい。割った分をまとめて登録して、
上から `ent run` を並べれば、進める本だけが進む（並べ方と、いま同時に並べられない
理由は次節）。

進めなかった理由は `ent run` の `skipped` に出る。依存が `FAILED` か `ABANDONED` に
落ちた場合は、待っても解けないことと次の一手（依存側をやり直すか `depends_on` を
書き換えるか）まで書く。まだ登録されていない依存は「待てば進む」側に数える。
`ent start` を打ち忘れただけかもしれないので、無いことを終端とは読まない。
**この待ちは Goal の状態には残らないので、`skipped` にしか出ない**（design.md §10-12
の残る穴）。自分自身への依存はスキーマが弾くが、**2本以上をまたぐ循環は YAML 1本からは
見えない**ので、全員が待ちのまま止まる。

依存の判定も端末ごとの状態 DB を読む。別の端末では依存の `COMPLETED` が見えないので、
未登録＝待ち扱いになる（上の lease と同じ制約）。

その N 本を書き出すのが `ent plan` になる。分解したいことを散文で渡すと、順序を
`depends_on` に入れた状態で宣言が並ぶ。

```sh
ent plan --desire "CLI に plan サブコマンドを足す" --dry-run   # 検証だけ。何も書かない
ent plan --desire "CLI に plan サブコマンドを足す"             # .goals/<id>.yaml を書く
```

**書くのは宣言部だけになる。** 実行時状態には触らず、Goal の登録もしない。`ent start` を
打つまで何も動かず、そこが承認点であることも変わらない（design.md §3.2）。書かれたものを
読んで、要らなければ消す。

**機械に書かせないものが4つある。** `repository` は `git remote get-url origin` と
`refs/remotes/origin/HEAD` から読む（`--repo <owner>/<name>` と `--default-branch <name>` で
上書きできる。後者は `git clone` でしか張られないので、必要になることが多い）。`policies` と
`budget` は `ent init` の雛形と同じ値を写すので、機械が書いた Goal だけが緩いところから
始まることはない。そして**1本も書く前に、集合まるごとを検証する**——スキーマ、既存の
`.goals/` との id 衝突、指す先の無い依存、循環の4つになる。落ちたら理由を添えて投げ直し、
再試行を使い切ったら1本も書かずに断る。既存の宣言は上書きしないし、`--force` も無い。

`--max <n>` で書き出す本数の上限を決める（既定 5）。ここで使ったトークンは
`.goals/.state/runs/plan-*/` の生ログに残り、**どの Goal の budget にも数えられない**。
数える先の Goal がまだ無いため。

**割った結果を残す判断は人間が持つ。** ティックの中では、controller が粗いタスクを
自分で N 本に割ることはしない（design.md §10-12）。

### 複数の Goal を同時に回す

設計としては、`ent run` は複数のプロセスから同時に叩いてよい。まとめて回す口
（`ent run --all` や常駐する watch）は用意しない。何本並べるかを決めるのは呼び出し側で、
`ent` は「同時に叩かれても壊れない」ところまでを受け持つ。**ただしこれは設計上の意図で、
同じディレクトリからの並列は実プロセス2本で確かめていない**（下の警告）。

> [!WARNING]
> **同じディレクトリからの並列は、実際に2本立てて確かめてはいない。**
> かつてここは「保護パスの関門が `ESCALATE(protected_path_touched)` で止まるので
> 1本ずつ回すこと」と書いていた。状態 DB は WAL なので、別プロセスの書き込みや
> 接続の切断で checkpoint が走って `goals.db` の中身が変わり、それを sha256 で
> 比べていた関門が巻き添えで鳴っていた。**その原因は塞いだ。** 関門は状態 DB を
> ファイルではなく「その Goal に属する行」の論理ダイジェストで見るようになったので、
> 別の Goal の書き込みでは動かない（issue #62、design.md §10-6）。
> 確かめたのは **Vitest の中で2本のティックを同じ `goals.db` へ同時に流したところまで**で、
> `ent run` のプロセスを2本立てて回してはいない。初回の `git worktree add` が
> `.git/index.lock` を取る競合と、SQLite の busy 競合は残っている。
> `.goals/.state/` は `process.cwd()` の下にできるので、worktree を分ければ DB ごと
> 分かれる。ただし lease も分かれるので、**別 worktree では同じ Goal を回さない**（下の
> 「同じ slug を2つのプロセスに渡しても安全」が効かず、両方が PR を立てる）。

```sh
# ワーカーを並べる側の例。slug ごとに1プロセス立てて、全部の終了を待つ
# （同じディレクトリなので、上の未確認が残るあいだはこのまま使わない）
for slug in goal-a goal-b goal-c; do
  ent run "$slug" &
done
wait
```

cron から回す場合も、対象repoへ移動してからNode 24以上とent本体の絶対パスを使う。
前回のティックが次の起動時刻を越えることがあるため、**Goalが1本でもrepo単位の外部ロックを
必ず取る**。次はmacOS / BSDの`lockf`で、ロック中なら次回を起動せずに終える例になる。
`/absolute/path/to/node-24`は、対話シェルで`mise which node`を実行して得たNode 24以上の
パスへ置き換える。Linuxではschedulerの重複起動禁止設定か同等のロックを使う。

```cron
*/10 * * * * cd /path/to/your-repo && /usr/bin/lockf -n /tmp/ent-your-repo.lock /absolute/path/to/node-24 /path/to/entelecheia/dist/cli.js run goal-a
```

同じディレクトリのGoalを複数回す場合も、開始時刻をずらすだけでは直列性を保証できない。
上の未確認が残るあいだは、同じrepo単位ロックを使うか、重複起動を禁止できる外部scheduler
から1本ずつ順番に起動する。ロック無しのcron行を直接並べない。

ent自身を直すGoalでは、対象repoと本体が同じなのでtask経由にする。cronのPATHに
依存しないよう、`command -v mise`で得た絶対パスへ置き換え、同じく外部ロックを取る。

```cron
*/10 * * * * cd /path/to/entelecheia && /usr/bin/lockf -n /tmp/ent-entelecheia.lock /absolute/path/to/mise run ent -- run goal-a
```

次の2段落（lease と本数の目安）は、同じディレクトリで2本立てるときの前提になる。
同一ディレクトリの並列はまだ実プロセスで確かめていないので、上の警告と合わせて読む。
その先の token の話は、1本だけ回すときも同じに効く。

同じ slug を2つのプロセスに渡しても安全に扱える。Goal の所有権は期限付きの
lease で決まるので、先に取れた側だけが進み、取れなかった側は
`another worker holds the lease` でスキップして exit 0 で終わる。二重に
Actor が走ることも、状態が混ざることもない。ティックの途中で lease を失った側も、
snapshot / verifications / Decision / 状態遷移を1つも書かずに降りる（既に書いてある
Run の行だけは残る。design.md §3.6）。

並べる本数は機械の資源で決める。各ティックは Actor（Claude Code または Codex）と Goal の
検証コマンド（このリポジトリなら `mise run verify`）を worktree の上で走らせるので、
1本あたり CPU コア1〜2本を見込むとよい。目安としてコア数の半分までにしておくと、
検証コマンドがタイムアウト側に倒れにくい。

GitHub の観測には token が要る。`GITHUB_TOKEN`（または `GH_TOKEN`）を渡せばそれを使い、
どちらの環境変数も無ければ `gh auth token` に落とす。gh はセットアップの前提に入っているので、
対話シェルから叩くぶんには何も渡さずに回してよい。cron から回すときは PATH と gh の設定が
引き継がれるとは限らないので、`GITHUB_TOKEN` を明示するか、同じ環境で `ent doctor` を
叩いて確かめる。**空文字を設定してあれば「渡さないと決めた」と読み、gh も呼ばない。**
未設定と空文字はここだけ意味が違う。GitHub を観測させたくない場面で、対話ログインした
gh のトークンが黙って使われないようにするためになる。**いずれの経路でも token を読めなければ**
観測は `unobserved` に `port_failed` として残り、ASSESS も「PR は無い」とは読まない。
読めた token は `process.env` に書き戻さないので、Agent と検証コマンドの環境から落とす扱いは
変わらない。Actor と LLM は、選んだCLIの保存済みログインをそのまま使う。APIキーを使う場合も、
検証コマンドには `ANTHROPIC_*` / `CLAUDE_CODE_*` / `OPENAI_API_KEY` / `CODEX_API_KEY`
を渡さない。

## ディレクトリ

```
.goals/<slug>.yaml        人間が編集。--private-goals でなければ Git 管理。宣言部のみ。
                          slug は goal.id と一致させる
.goals/config.yaml        人間が編集。扱いは上と同じ。宣言部のうち Goal 全部が受け取る
                          repo スコープの分。config は予約 slug なので、この名前の Goal は作れない
.goals/.state/goals.db    controller が書く実行時状態。gitignore 済み
.goals/.state/worktrees/  Actor が編集する worktree。controller 本体とは物理的に分ける
                          名前は (goal.id, role) から決まる。実装役とレビュー役は
                          同じ <slug> を共有し、実装役が書き、レビュー役が読む。
                          調べる役（investigate）だけ
                          <slug>-investigate に分かれる（design.md §4.2）
.goals/.state/runs/<run-id>/  Agent の生ログ。DB にはパスだけ持つ
src/domain/fact.ts        Fact の型（VERIFIED / INFERRED の分離）と Unresolved
src/domain/fact-keys.ts   観測キーのレジストリ。Goal YAML の fact 検証はここを参照する
src/domain/goal.ts        Goal YAML の Zod スキーマ
src/domain/goal-parse.ts  Goal YAML の検証と、slug と goal.id の突き合わせ。ファイルは読まない
src/domain/goal-config.ts .goals/config.yaml のスキーマと、Goal の下への敷き方
src/domain/gap.ts         ASSESS が出す Gap と Assessment の型
src/domain/action.ts      DECIDE が選ぶ Action と Decision の型
src/domain/run.ts         Actor の実行記録の型と ActorRole（実装役とレビュー役は同じ
                          worktree、investigate だけが分かれる。design.md §4.2）
src/domain/goal-state.ts  Goal のライフサイクルと、Action から次の状態を決める遷移
src/domain/port-error.ts  Port の失敗の種別（usage_limit / unavailable）
src/domain/verification.ts criteria 単位の検証結果。§9 の完了判定が読む索引
src/domain/digest.ts      観測値のダイジェスト。ループ検知の材料になる
src/domain/protected-paths.ts 保護パスの検査。制御ループ自体への編集を止める
src/domain/guard-rules.ts guard（純ロジック）が読む判断規則。関門の基準と停止条件
src/domain/withheld-env.ts Agent と検証コマンドの環境から落とす資格情報の除去リスト
src/domain/error-message.ts 例外から人間が読める1行を取り出す
src/domain/llm-call.ts    LlmPort を1回呼んだ記録。Run を作らない分のトークン
src/observe/              Observe と、依存する Port の定義
src/verify/               Verify と、依存する Port の定義
src/assess/               Assess。Acceptance Criteria と Fact を突き合わせて Gap を出す
src/decide/               Decide と LlmPort の定義。guard と LLM の境界はここにある
src/act/                  Act。Actor を worktree 上で走らせる。write-ahead はここ
src/reconcile/            OBSERVE → VERIFY → ASSESS → DECIDE を1ティックにまとめる
src/publish/              PR の確保と進捗コメント。CodeWriterPort と BranchPort の定義
src/store/port.ts         実行時状態の Port。使う側が所有する口で、実装は持たない
src/store/sqlite.ts       その SQLite 実装（node:sqlite）。挿すのは合成ルートだけ
src/controller/           1ティックの外側。lease → 回収 → reconcile → ACT → 永続化 → 遷移
src/adapters/local.ts     node:child_process で書ける Port（コマンド実行、git、worktree）
src/adapters/goal-file.ts .goals/<slug>.yaml を読み、同じディレクトリの config.yaml を下に敷く
src/adapters/github.ts    CodeProviderPort。@octokit/rest + ETag
src/adapters/claude.ts    ActorPort と LlmPort。Claude Agent SDK
                          role ごとの許可・拒否ツールとプロンプトもここ。編集の
                          ツールを持つのは実装役だけ（design.md §4.2）
src/adapters/codex.ts     ActorPort と LlmPort。Codex CLI の非対話JSONLを変換する
src/adapters/agent-prompt.ts Codex向けのrole別プロンプトと出力契約
src/wiring/index.ts       合成ルート。どの Port にどの Adapter を挿すかを決める唯一の場所。
                          関門への入力（Adapter の注入と verifyRoot）もここで決まる
src/usecase/init.ts       ent init。.goals/ と gitignore の行と config.yaml と Goal の雛形を置く
src/usecase/doctor.ts     ent doctor。回す前の前提を、書かずに調べる
src/usecase/inspect.ts    ent get / ent list が出す payload。読むだけ
src/cli/parse.ts          引数の解釈。実行はしない
src/cli/present.ts        出力の整形。stdout は JSON 専用、診断は stderr
src/cli/agent-context.ts  ent agent-context が出す CLI の構造
src/cli.ts                ent コマンドの入口。サブコマンドごとの手順と終了コードの契約
.claude/skills/ent/SKILL.md  エージェントが手順として読むもの。叩く順と、人の承認で止まる場所
.agents/skills/ent          Codex の探索先。上の正本を指す symlink
AGENTS.md                 上の SKILL.md を指すだけの入口。手順は二重に書かない
tests/                    Acceptance Criteria の実体と、実 git / 実 SQLite を叩く統合テスト
```

`.goals/.state/` は `ent start` を最初に叩いたときに作られる。

## セキュリティベースライン

このリポジトリは [`slashkiko/repository-baseline`](https://github.com/slashkiko/repository-baseline)
から作成した。以下は baseline 由来の統制で、外す場合は理由を残すこと。

- mise がセキュリティツールのサプライチェーンを固定し、新しいリリースは 7 日待ってから使う
- Pinact が GitHub Actions の完全な commit SHA ピン留めを要求する
- actionlint と zizmor が workflow の構文とセキュリティ特性を検査する
- Betterleaks が Git 履歴全体をスキャンする
- `.github/workflows/weekly-audit.yml` が OSPS Baseline のバージョン変更を週次で検出する

リポジトリ設定の初期化は、必ず dry-run を確認してから適用する。

```sh
mise run repository-initialize                    # dry-run。適用予定の設定を表示するだけ
mise run repository-initialize --configure-github # GitHub 側の設定を実際に書き換える
```

詳細は [`docs/security-baseline.md`](docs/security-baseline.md) と
[`SECURITY.md`](SECURITY.md)（いずれも英語）を参照。

## ライセンス

MIT。[`LICENSE`](LICENSE) にある。

`ent` が起動する Actor は Claude Code と Codex で、**どちらもこのライセンスの対象外になる。**
それぞれベンダーの規約のもとで動くので、選んだ側の有効なログインが要る。とくにこのリポジトリが
依存している `@anthropic-ai/claude-agent-sdk` は OSS ではない。OSI ライセンスではなく、Anthropic の
Commercial Terms of Service のもとで配布されている。
