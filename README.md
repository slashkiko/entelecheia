# entelecheia

> Declare the end state; the controller converges to it.

人間はプロジェクトの完了状態（Desired State）を宣言する。controller は現在状態を観測し、
ギャップが埋まるまでティックごとに Claude Code を起動する。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に対して実現しようとする状態そのものを指す言葉にあたる。CLI 名は `ent`。

要件定義: Claude の Artifact（作成者のみ閲覧できるため、公開時にリンクを外した）

## 設計の要点

以下は Phase 2 到達時の設計であり、現状（Phase 0）ではまだ実装されていない。

| 原則 | 内容 |
|---|---|
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria だけ。タスク分解も Actor 選択も controller が決める |
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria に落とせない Goal は ACTIVE（YAML 上は `status: active`）にしない |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる |

## 現在地とロードマップ

**Phase 0。** controller はまだ存在せず、OBSERVE / ASSESS / DECIDE / ACT / VERIFY はすべて人間がやる。
`.goals/phase1-observe.yaml` を Claude Code に丸ごと渡し、検証コマンドを回し、落ちたら結果を戻す。
この往復が ACT → VERIFY → OBSERVE の手動版になる。

この時点では `tests/observe.test.ts` の全テストが落ちる。それが正しい状態。

下の表は、controller の構成要素としてコード化されている範囲を累積で示す。
無人で回り始めるのは Phase 2 以降で、Phase 0 と Phase 1 は人間が起動する。

| Phase | コード化済み（累積） | 人間が担う |
|---|---|---|
| 0 | なし | OBSERVE / ASSESS / DECIDE / ACT / VERIFY のすべて |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT と、全段階の起動 |
| 2 | OBSERVE / VERIFY / ASSESS / DECIDE / ACT | Goal を書く、承認する |
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

Phase 0 では `test` が落ちるため `verify` も失敗する。それが現在地であって、環境の不備ではない。
`typecheck` / `lint` / `check` は単体で通る。

`ent` コマンドはまだビルドできない。CLI の実装は Phase 2 で入る。

## ディレクトリ

```
.goals/<slug>.yaml   人間が編集。Git 管理。宣言部のみ
.goals/.state/       controller が書く実行時状態。gitignore 済み
src/domain/fact.ts   Fact の型（VERIFIED / INFERRED の分離）
src/observe/         Observe と、依存する Port の定義
tests/               Acceptance Criteria の実体
```

`.goals/.state/` のディレクトリ自体は、controller を実装したあとに生成される。

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
