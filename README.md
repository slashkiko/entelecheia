# entelecheia

> Declare the end state; the controller converges to it.

人間はプロジェクトの完了状態（Desired State）を宣言する。controller は現在状態を観測し、
ギャップが埋まるまでティックごとに Claude Code を起動する。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に対して実現しようとする状態そのものを指す言葉にあたる。CLI 名は `ent`。

設計の全体像・判断の根拠・Phase 計画は [`docs/design.md`](docs/design.md) にある。
このリポジトリで作業を始めるときは、まずそれを読む。

## 設計の要点

「実装」列は Phase 1 時点の状態を示す。型として存在するものと、controller 本体を
待っているものが混在している。

| 原則 | 内容 | 実装 |
|---|---|---|
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない | 型は済 |
| 確かめられなかったことを黙って落とさない | 「対象が無い」と「対象を確かめられなかった」を区別し、後者は `unobserved` / `unverified` に理由付きで残す | 型は済 |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria を検証手段（コマンド / Fact 参照 / 人間の承認）に落とせない Goal は ACTIVE にしない | 済 |
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria。タスク分解も Actor 選択も controller が決める | Phase 2 |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない | Phase 2 |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる | Phase 2 |

「型は済」は Zod スキーマと TypeScript の型が入っている状態を指す。値を実際に積む
処理は Phase 1 の作業に含まれる。

Goal の状態（ACTIVE / COMPLETED など）は、controller を実装したあと SQLite が持つ。
`.goals/*.yaml` は宣言部だけを持ち、実行時状態は書かない。

## 現在地とロードマップ

**Phase 1。** Phase 0（`.goals/observe-returns-facts.yaml`）は完了し、Goal YAML のスキーマが
`src/domain/goal.ts` に確定した。いま進めているのは `.goals/automate-observe-and-verify.yaml` で、
OBSERVE の取りこぼし記録と VERIFY を作っている。

Phase 1 でも起動は人間がやる。Goal YAML を丸ごと Claude Code に渡して実装させ、
検証コマンドを回し、落ちたら結果を戻す。
この往復が ACT → VERIFY → OBSERVE の手動版になる。

この時点では `tests/verify.test.ts` の全テストと `tests/observe.test.ts` の一部が落ちる。
それが正しい状態。`tests/goal.test.ts` は通る。

下の表は、controller が回す範囲を累積で示す。各行はそのフェーズを**完了した時点**の
状態で、コードの有無ではない。無人で回り始めるのは Phase 2 以降で、
Phase 0 と Phase 1 は人間が起動する。

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

未実装の Goal を抱えている間は `test` が落ちるため `verify` も失敗する。
それが現在地であって、環境の不備ではない。`typecheck` / `lint` / `check` は単体で通る。
同じ理由で、main の CI（`.github/workflows/verify.yml`）も赤い。

`ent` コマンドはまだビルドできない。CLI の実装は Phase 2 で入る。

## ディレクトリ

```
.goals/<slug>.yaml        人間が編集。Git 管理。宣言部のみ。slug は goal.id と一致させる
.goals/.state/            controller が書く実行時状態。gitignore 済み
src/domain/fact.ts        Fact の型（VERIFIED / INFERRED の分離）と未観測の記録
src/domain/fact-keys.ts   観測キーのレジストリ。Goal YAML の fact 検証はここを参照する
src/domain/goal.ts        Goal YAML の Zod スキーマ
src/domain/goal-loader.ts Goal YAML の読み込みと、slug と goal.id の突き合わせ
src/observe/              Observe と、依存する Port の定義
src/verify/               Verify と、依存する Port の定義
tests/                    Acceptance Criteria の実体
```

`.goals/.state/` 自体は、controller を実装したあとに生成される。

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
