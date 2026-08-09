# entelecheia

> Declare the end state; the controller converges to it.

人間はプロジェクトの完了状態（Desired State）を宣言する。controller は現在状態を観測し、
ギャップが埋まるまでティックを回し、埋め方を決める段で Claude Code を起動する。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に対して実現しようとする状態そのものを指す言葉にあたる。CLI 名は `ent`。

設計の全体像・判断の根拠・Phase 計画は [`docs/design.md`](docs/design.md) にある。
このリポジトリで作業を始めるときは、まずそれを読む。

## 設計の要点

controller は OBSERVE / ASSESS / DECIDE / ACT / VERIFY を回し、PR を自分で立てて
進捗をコメントに積み、人間の承認を検知して COMPLETED まで進む。
本文で **Actor** と呼ぶのは controller が起動する実行主体の抽象で、いまの実装は
Claude Code にあたる。その走っている実体を指すときは **Agent** と書く。
design.md §9 の完了条件9項目はすべて確認した。**MVP は完了している。**

完了後にレビューを1周かけ、自己ホストの安全装置とテストの穴を埋めた。§9 の完了条件は
「controller が最後まで回るか」を問うもので、「Agent が制御ループを書き換えられないか」は
そこに入っていない。何を直したかは後述する。下の表の「実装」列は、そのレビューを
反映した現時点の状態を示す。

| 原則 | 内容 | 実装 |
|---|---|---|
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない | 済 |
| 確かめられなかったことを黙って落とさない | 「対象が無い」と「対象を確かめられなかった」を区別し、後者は `unobserved` / `unverified` に理由付きで残す | 済 |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria を検証手段（コマンド / Fact 参照 / 人間の承認）に落とせない Goal は ACTIVE にしない | 済 |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない | 済 |
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria。タスク分解も Actor 選択も controller が決める | 済 |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる | 済 |
| 隔離は場所だけでは足りない | worktree でファイルを分けるだけでなく、Agent の出力を controller のシェルに流さない・Agent が書いたものを controller の権限で実行しない | 一部（シェルに流さない側は design.md §7 で対応済み、controller の権限で実行しない側は §10-9 が未決） |

完了判定と暴走の停止条件は LLM に決めさせない。LLM が選べるのは
`ACT` / `VERIFY` / `WAIT` / `REPLAN` の4つだけで、`COMPLETE` と `ESCALATE` は
純ロジック（guard）が決める。Gap の埋め方だけを LLM に委ねる。この境界は `src/decide/` にある。

自己ホストの安全装置として、`policies.protected_paths` に書いたパスを Agent が編集したら、
controller が ACT の外側で検知して止める。Agent 側の拒否ルールとは別に、controller 自身の
関門を持つ。検知の材料は Agent の自己申告ではなく git が観測した変更で、Bash 経由の
書き込みも見える。worktree の中だけでなく、その外に出た書き込みも本体リポジトリ側の
git で見る。ただし見えるのはリポジトリの中の変更だけで、範囲と残る穴は design.md §10-6
に書いてある。守るのは制御ループ本体（`src/controller/**`）と Goal の宣言部
（`.goals/**`）に加えて、**関門そのもの（Agent の拒否リストを決めるファイルを含む）と
検証系**にあたる。選び方の基準は design.md §7 にある。

controller が持つ資格情報（`GITHUB_TOKEN`）は Agent に渡さない。git は argv 配列で叩き、
シェルを通すのは Goal YAML の `setup` と `verification.run` だけにする。
`type: human` の承認は、リポジトリに書き込み権限がある人のものだけを数える。

Goal の状態（ACTIVE / COMPLETED など）は `.goals/.state/goals.db` が持つ。
行動の `COMPLETE` と Goal の状態 `COMPLETED` は別のもので、前者が選ばれた結果として後者になる。
`.goals/*.yaml` は宣言部だけを持ち、実行時状態は書かない。

## 現在地とロードマップ

**Phase 3 完了。MVP 完了。** Phase 0 から Phase 3 まで、Goal は合わせて11本。
Goal YAML のスキーマは `src/domain/goal.ts`、観測キーのレジストリは
`src/domain/fact-keys.ts` にある。

Phase 3 は自己ホストで、5本に割った。1本目で1ティックの記録が読めるようになり、
2本目で PR の作成・通知・承認の検知が入り、3本目で待機と暴走の制御が入り、
4本目で自己ホストの安全装置が入った。**5本目は controller に実装させた。**

人間がやったのは Goal YAML と Acceptance Criteria を書き、`ent start` してから
`ent run` を繰り返しただけで、controller が Actor を worktree で走らせ、PR を立て、
進捗をコメントに積み、承認待ちで止まった（`COMPLETED` への遷移そのものは別の Goal で
確認済み。design.md §9）。

**実際に回すまで、配管は繋がっていると見なせない。** Phase 3 で見つかった断線は
どれもテストでは通っていた。`git branch --format` の引用符不足で worktree の作成が
Phase 2 からずっと失敗していたこと、VERIFY が worktree ではなく controller 自身の
リポジトリでコマンドを流していたこと、PR がある間 push しなくなっていたこと、
そして **Actor が実装を書き切ったまま commit していなかった**こと。
3つ目のものは、それを仕様として固定したテストが緑のままだった。

4つ目は壊れ方が違う。push も VERIFY も DECIDE も契約どおりに動いていて、誰も
誤った動きをしていない。push は commit 済みの差分しか送らないのに VERIFY は
worktree の作業ツリーを見るので、criteria は全部通るのに remote には何も出ず、
controller は承認待ちで止まった。人間が待っているのは実装が載った PR なので、
その待ちは永久に終わらない。**「Actor が commit する」という前提を、どこも
要求していなかった。** いまは「機械側にやることは残っていない」と言い切るティックで
未 commit の変更を検知し、`ESCALATE(uncommitted_changes)` で人間を呼ぶ
（design.md §10-11）。読むのは**今ティックの観測が worktree を見て作った**
`local.dirty` だけで、観測に失敗したティックや worktree がまだ無いティックでは
止まらない。役割ごとに worktree が分かれた（design.md §4.2）あとも、突き合わせるのは
**実装役のブランチ**に固定してある。検証コマンドと `local.*` を観測する先が
そちらだからで、レビュー役の作業ツリーの汚れを実装の書き残しと読まない。止めた理由と次の一手は `ent show` と PR のコメントの両方に出す。

MVP 完了後のレビューでも、同じ形の穴が残っていた。Port を注入するテストは
`src/adapters/local.ts`（実際の git とシェル）と `src/cli.ts` の `main()` を1行も通らず、
その2つにはテストが1本も無かった。**壊しても全件が緑のまま通る変更が5件あった**（LLM に
`COMPLETE` を許す、Agent の拒否リストを空にする、ダイジェストの正規化から `sort` を消す、
承認 Port の失敗を「検証済み不合格」にする、lease の解放を `finally` から外す）。
いまは実際の git と実際の SQLite に対して回す統合テストがあり、上の5件はそれぞれ
1本のテストで固定してある。統合テストは書いたその場で1件バグを見つけた
（`git status --porcelain` の出力を trim してパスが1文字欠ける。統合テストと同じ変更で
入れた誤りで、それ以前のコードには無い）。

**ただし ACT を通る経路は、いまの自動テストでは覆えていない。** `main()` の統合テストが
通すのは guard が `COMPLETE` を選ぶ経路で、Actor も GitHub も呼ばない。上の3つの断線は
どれも実際に外部（git / GitHub / Actor）を叩く側にあったので、そこは変わらず
「実際に `ent run` を回す」でしか確かめられない。

Phase 1 と Phase 2 の1本目は、どちらも6本の Acceptance Criteria のうちコマンドで検証する4本を
通しただけでは COMPLETED にならなかった。Phase 1 で残ったのは CI の結果（`type: fact`）と、
Port の抽象が1実装に癒着していないかの確認（`type: human`）。Phase 2 の1本目で残ったのは
CI の結果と、guard と LLM の境界が妥当かの確認（`type: human`）だった。**設計の中核ほど検証コマンドに落ちない。**

下の表は、controller が回す範囲を累積で示す。各行はそのフェーズを**完了した時点**の
累積範囲で、数えているのは controller が回す段階であってコードの有無ではない。
起動の主体は「controller が回す範囲」の列には数えていない。
1ティックの内側に人間の判断が入らなくなるのは Phase 2 を完了した時点からで、
起動そのものは cron が担う。常駐プロセスは作らない（design.md §3.6）。

| Phase | controller が回す範囲（累積） | 人間が担う |
|---|---|---|
| 0 | なし | OBSERVE / ASSESS / DECIDE / ACT / VERIFY のすべて |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT と、全段階の起動 |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | Goal を書く、承認する |
| 3 | Phase 2 と同じ範囲を、このリポジトリ自身に対して回す（自己ホスト） | Goal を書く、承認する |

Phase 3 を完了した時点で、ティックの起動にも人間の判断は要らなくなる。
人間に残るのは Goal を書くことと、PR に `/ent approve <criterion-id>` と書くこと
（あるいは GitHub のレビューで Approve を押すこと）の2つになる。

## セットアップ

[mise](https://mise.jdx.dev/) と [gh](https://cli.github.com/) が入っていること。
Node と pnpm のバージョンは `mise.toml` で固定してあるので、個別に入れる必要はない。

```sh
mise install --locked
pnpm install --frozen-lockfile
```

## 検証

```sh
mise run verify   # typecheck / lint / test をまとめて実行
mise run check    # サプライチェーンと workflow のチェック（baseline 由来）
```

現時点では `typecheck` / `lint` / `test` / `check` の4つとも通る。

Acceptance Criteria を先に書く進め方なので、Goal に着手した直後は `test` が落ちる。
それは進め方に由来する想定内の状態であって、環境の不備ではない。

## ent を動かす

```sh
mise run build                     # dist/cli.js を作る
alias ent="node $(pwd)/dist/cli.js"

ent start <slug>                   # Goal を登録して ACTIVE にする
ent run <slug>                     # 1ティック回して終了する
ent run <slug> --pr <n>            # 観測対象の PR を指定する（controller が立てた分は自動）
ent run <slug> --issue <n>         # 観測対象の Issue を指定する
ent run <slug> --dry-run           # 書かずに、次のティックの中身だけを見る
ent get <slug>                     # 宣言部と実行時状態をまとめて表示する
ent abandon <slug> --reason "…"    # もう追わないと宣言して終端にする（理由は必須）
ent list                           # 登録済みの Goal を一覧する
ent doctor                         # 回す前の前提が揃っているかを読み取り専用で調べる
ent agent-context                  # CLI の構造を機械可読な JSON で出す
```

`--json` は出力を JSON にする（`run` / `get` / `list` は既定で JSON。`start` だけが平文）。
`doctor` と `agent-context` は常に JSON で、`--json` は受け取らない。
`--limit <n>` は `get` / `list` の件数を絞る。既定でも上限で切り、切れたときだけ
絞り込み方が stderr に出る。エージェント向けの手順は `.claude/skills/ent/SKILL.md` に置いてある。

`ENT_MODEL` と `ENT_EFFORT` で Actor と LLM のモデルを上書きできる。
1ティックごとに使用量を消費するので、試走は安いモデルで回せる。

`package.json` の `bin` に `ent` を登録してあるが、npm へ公開していないので
いまは alias か `node dist/cli.js` で呼ぶ。

常駐しない。`run` はどのティックも有限時間で終了し、待ちは Goal の状態として残る。
継続して回すなら cron から `run` を叩く。

### 複数の Goal を同時に回す

`ent run` は複数のプロセスから同時に叩いてよい。まとめて回す口（`ent run --all` や
常駐する watch）は用意しない。何本並べるかを決めるのは呼び出し側で、`ent` は
「同時に叩かれても壊れない」ところまでを受け持つ。

```sh
# ワーカーを並べる側の例。slug ごとに1プロセス立てて、全部の終了を待つ
for slug in goal-a goal-b goal-c; do
  ent run "$slug" &
done
wait
```

cron から回すなら、Goal ごとに行を分ければよい（同じ分に並んでも構わない）。

```cron
*/10 * * * * cd /path/to/repo && node dist/cli.js run goal-a
*/10 * * * * cd /path/to/repo && node dist/cli.js run goal-b
```

同じ slug を2つのプロセスに渡しても安全に扱える。Goal の所有権は期限付きの
lease で決まるので、先に取れた側だけが進み、取れなかった側は
「他のワーカーが lease を持っている」でスキップして exit 0 で終わる。二重に
Actor が走ることも、状態が混ざることもない。ティックの途中で lease を失った側も、
そのティックの記録を1つも書かずに降りる。

並べる本数は機械の資源で決める。各ティックは Actor（Claude Code）と Goal の
検証コマンド（このリポジトリなら `mise run verify`）を worktree の上で走らせるので、
1本あたり CPU コア1〜2本を見込むとよい。目安としてコア数の半分までにしておくと、
検証コマンドがタイムアウト側に倒れにくい。

`GITHUB_TOKEN`（または `GH_TOKEN`）を渡すと GitHub を観測する。無ければ観測は
`unobserved` に `port_failed` として残り、ASSESS も「PR は無い」とは読まない。
Actor と LLM は Claude Code の OAuth をそのまま使う。

## ディレクトリ

```
.goals/<slug>.yaml        人間が編集。Git 管理。宣言部のみ。slug は goal.id と一致させる
.goals/.state/goals.db    controller が書く実行時状態。gitignore 済み
.goals/.state/worktrees/  Actor が編集する worktree。controller 本体とは物理的に分ける
                          名前は (goal.id, role) から決まる。実装役は <slug>、
                          それ以外は <slug>-<role>（design.md §4.2）
.goals/.state/runs/<run-id>/  Agent の生ログ。DB にはパスだけ持つ
src/domain/fact.ts        Fact の型（VERIFIED / INFERRED の分離）と Unresolved
src/domain/fact-keys.ts   観測キーのレジストリ。Goal YAML の fact 検証はここを参照する
src/domain/goal.ts        Goal YAML の Zod スキーマ
src/domain/goal-loader.ts Goal YAML の読み込みと、slug と goal.id の突き合わせ
src/domain/gap.ts         ASSESS が出す Gap と Assessment の型
src/domain/action.ts      DECIDE が選ぶ Action と Decision の型
src/domain/run.ts         Actor の実行記録の型と ActorRole（役割ごとに worktree が分かれる）
src/domain/goal-state.ts  Goal のライフサイクルと、Action から次の状態を決める遷移
src/domain/port-error.ts  Port の失敗の種別（usage_limit / unavailable）
src/domain/verification.ts criteria 単位の検証結果。§9 の完了判定が読む索引
src/domain/digest.ts      観測値のダイジェスト。ループ検知の材料になる
src/domain/protected-paths.ts 保護パスの検査。制御ループ自体への編集を止める
src/domain/llm-call.ts    LlmPort を1回呼んだ記録。Run を作らない分のトークン
src/observe/              Observe と、依存する Port の定義
src/verify/               Verify と、依存する Port の定義
src/assess/               Assess。Acceptance Criteria と Fact を突き合わせて Gap を出す
src/decide/               Decide と LlmPort の定義。guard と LLM の境界はここにある
src/act/                  Act。Actor を worktree 上で走らせる。write-ahead はここ
src/reconcile/            OBSERVE → VERIFY → ASSESS → DECIDE を1ティックにまとめる
src/publish/              PR の確保と進捗コメント。CodeWriterPort と BranchPort の定義
src/store/                SQLite（node:sqlite）。lease、スナップショット、Run、Decision
src/controller/           1ティックの外側。lease → 回収 → reconcile → 永続化 → ACT → 遷移
src/adapters/local.ts     node:child_process で書ける Port（コマンド実行、git、worktree）
src/adapters/github.ts    CodeProviderPort。@octokit/rest + ETag
src/adapters/claude.ts    ActorPort と LlmPort。Claude Agent SDK
                          role ごとの許可・拒否ツールとプロンプトもここ。編集の
                          ツールを持つのは実装役だけ（design.md §4.2）
src/cli.ts                ent コマンド。引数の解釈と agent-context もここ
.claude/skills/ent/SKILL.md  エージェントが手順として読むもの。叩く順と、人の承認で止まる場所
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
