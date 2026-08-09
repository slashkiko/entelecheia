# entelecheia

> Declare the end state; the controller converges to it.

人間はプロジェクトの完了状態（Desired State）を宣言する。controller は現在状態を観測し、
ギャップが埋まるまでティックごとに Claude Code を起動する。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に対して実現しようとする状態そのものを指す言葉にあたる。CLI 名は `ent`。

設計の全体像・判断の根拠・Phase 計画は [`docs/design.md`](docs/design.md) にある。
このリポジトリで作業を始めるときは、まずそれを読む。

## 設計の要点

「実装」列は Phase 2 の3本目（`.goals/persist-and-resume.yaml`）を完了した時点の状態を示す。
「済」はコードとして揃っていることを意味し、実環境で動くこととは別のことになる。
GitHub と Claude Code に繋ぐ Port はまだ無く、そこは Phase 2 の4本目に入る。

| 原則 | 内容 | 実装 |
|---|---|---|
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない | 済 |
| 確かめられなかったことを黙って落とさない | 「対象が無い」と「対象を確かめられなかった」を区別し、後者は `unobserved` / `unverified` に理由付きで残す | 済 |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria を検証手段（コマンド / Fact 参照 / 人間の承認）に落とせない Goal は ACTIVE にしない | 済 |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない | 済 |
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria。タスク分解も Actor 選択も controller が決める | 済 |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる | 済 |

完了判定と暴走の停止条件は LLM に決めさせない。DECIDE が選ぶ行動のうち `COMPLETE` と
`ESCALATE(budget_exhausted)` は純ロジック（guard）が決め、Gap の埋め方だけを LLM に委ねる。
この境界は `src/decide/` にある。

Goal の状態（ACTIVE / COMPLETED など）は `.goals/.state/goals.db` が持つ。
行動の `COMPLETE` と Goal の状態 `COMPLETED` は別のもので、前者が選ばれた結果として後者になる。
`.goals/*.yaml` は宣言部だけを持ち、実行時状態は書かない。

## 現在地とロードマップ

**Phase 2。** Phase 0（`.goals/observe-returns-facts.yaml`）と
Phase 1（`.goals/automate-observe-and-verify.yaml`）は完了し、Goal YAML のスキーマが
`src/domain/goal.ts` に、観測キーのレジストリが `src/domain/fact-keys.ts` に確定した。

Phase 2 は ASSESS / DECIDE / ACT と永続化と CLI、および GitHub と Actor に繋ぐ Port の実装を
含み、1つの Goal には大きすぎるので4本に割ってある。3本目まで完了し、
`ent run <slug>` が1ティックを回して状態を SQLite に残す。

残るのは4本目の Port 実装になる。GitHub（octokit）と Actor（Claude Agent SDK）が
まだ無く、呼ばれたら throw する形にしてある。ティック自体は最後まで回り、
観測できなかった対象は `unobserved` に、LLM の不在は `ESCALATE` になって状態に残る。
捏造した観測を返すより、落として記録した方が状態が正しく残るため。

**4本目が入るまでは、実装だけを人間が回す。** Goal YAML を丸ごと Claude Code に渡して実装させ、
検証コマンドを回し、落ちたら結果を戻す。
この往復が ACT → VERIFY → OBSERVE の手動版になる。

Phase 1 と Phase 2 の1本目は、どちらも6本の Acceptance Criteria のうちコマンドで検証する4本を
通しただけでは COMPLETED にならなかった。Phase 1 で残ったのは CI の結果（`type: fact`）と
レビュー承認（`type: human`）、1本目で残ったのは CI の結果と、guard と LLM の境界が妥当かの
確認（`type: human`）だった。**設計の中核ほど検証コマンドに落ちない。**

下の表は、controller が回す範囲を累積で示す。各行はそのフェーズを**完了した時点**の
累積範囲で、数えているのは controller が回す段階であってコードの有無ではない。
起動の主体は「controller が回す範囲」の列には数えていない。
無人で回り始めるのは Phase 2 を完了した時点から。

| Phase | controller が回す範囲（累積） | 人間が担う |
|---|---|---|
| 0 | なし | OBSERVE / ASSESS / DECIDE / ACT / VERIFY のすべて |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT と、全段階の起動 |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | Goal を書く、承認する |
| 3 | Phase 2 と同じ範囲を、このリポジトリ自身に対して回す（自己ホスト） | Goal を書く、承認する |

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
ent show <slug>                    # 宣言部と実行時状態をまとめて表示する
```

`package.json` の `bin` に `ent` を登録してあるが、npm へ公開していないので
いまは alias か `node dist/cli.js` で呼ぶ。

常駐しない。`run` はどのティックも有限時間で終了し、待ちは Goal の状態として残る。
継続して回すなら cron から `run` を叩く。

いまは Port が揃っていないので、`run` は検証コマンドを流したあと
`ESCALATE(invalid_decision)` で止まる。理由は `LlmPort` が未実装であることで、
Phase 2 の4本目で埋まる。

## ディレクトリ

```
.goals/<slug>.yaml        人間が編集。Git 管理。宣言部のみ。slug は goal.id と一致させる
.goals/.state/goals.db    controller が書く実行時状態。gitignore 済み
.goals/.state/worktrees/  Actor が編集する作業ツリー。controller 本体とは物理的に分ける
src/domain/fact.ts        Fact の型（VERIFIED / INFERRED の分離）と Unresolved
src/domain/fact-keys.ts   観測キーのレジストリ。Goal YAML の fact 検証はここを参照する
src/domain/goal.ts        Goal YAML の Zod スキーマ
src/domain/goal-loader.ts Goal YAML の読み込みと、slug と goal.id の突き合わせ
src/domain/gap.ts         ASSESS が出す Gap と Assessment の型
src/domain/action.ts      DECIDE が選ぶ Action と Decision の型
src/domain/run.ts         Actor の実行記録の型
src/domain/goal-state.ts  Goal のライフサイクルと、Action から次の状態を決める遷移
src/observe/              Observe と、依存する Port の定義
src/verify/               Verify と、依存する Port の定義
src/assess/               Assess。Acceptance Criteria と Fact を突き合わせて Gap を出す
src/decide/               Decide と LlmPort の定義。guard と LLM の境界はここにある
src/act/                  Act。Actor を worktree 上で走らせる。write-ahead はここ
src/reconcile/            OBSERVE → VERIFY → ASSESS → DECIDE を1ティックにまとめる
src/store/                SQLite（node:sqlite）。lease、スナップショット、Run、Decision
src/controller/           1ティックの外側。lease → 回収 → reconcile → 永続化 → ACT → 遷移
src/adapters/             Port の実装。いまは node:child_process で書けるものだけ
src/cli.ts                ent コマンド
tests/                    Acceptance Criteria の実体
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
