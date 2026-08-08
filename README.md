# entelecheia

> Declare the end state; the controller converges to it.

プロジェクトの完了状態（Desired State）を宣言すると、現在状態を観測し、ギャップを埋めるまで
Claude Code を起動し続ける controller。

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で、「可能態が現実態に至った状態」を指す。
このツールが Goal に与えるものそのものにあたる。CLI 名は `ent`。

要件定義: Claude の Artifact（作成者のみ閲覧できるため、公開時にリンクを外した）

## 設計の要点

| | |
|---|---|
| 宣言と収束の分離 | 人間が書くのは Desired State と Acceptance Criteria だけ。タスク分解も Actor 選択も controller が決める |
| VERIFIED のみで完了判定 | Fact に信頼度を持たせ、LLM の推論（INFERRED）は Plan の材料にはするが完了判定には使わない |
| 検証に還元できない Goal は受け付けない | Acceptance Criteria に落とせないものは ACTIVE にしない |
| 待機はプロセスではなく状態 | reconcile はどのティックも有限時間で return する。常駐して sleep しない |
| write-ahead | 副作用の前に意図を DB へ書く。任意の瞬間に kill されても次ティックで回収できる |

## 現在地

**Phase 0。** controller はまだ存在せず、OBSERVE / ASSESS / DECIDE は人間がやる。
`.goals/phase1-observe.yaml` を Claude Code に丸ごと渡し、検証コマンドを回し、
落ちたら結果を戻す。この往復が ACT → VERIFY → OBSERVE の手動版になる。

この時点では `mise run test` は 6 件すべて落ちる。それが正しい状態。

| Phase | 自動化される部分 | 人間がやる部分 |
|---|---|---|
| 0 | なし | Observe・Assess・Decide すべて |
| 1 | Observe・Verify | Assess・Decide |
| 2 | Decide・Act | 承認のみ |
| 3 | 全部（自己ホスト） | Goal を書くだけ |

## セットアップ

```sh
mise install --locked
pnpm install --frozen-lockfile
```

## 検証

```sh
mise run verify   # typecheck → lint → test
mise run check    # サプライチェーンと workflow のチェック（baseline 由来）
```

## ディレクトリ

```
.goals/<slug>.yaml            人間が編集。Git 管理。宣言部のみ
.goals/.state/                controller が書く実行時状態。gitignore
src/domain/fact.ts            Fact の型（VERIFIED / INFERRED の分離）
src/observe/                  Observe と、依存する Port の定義
tests/                        Acceptance Criteria の実体
```

## セキュリティベースライン

このリポジトリは [`slashkiko/repository-baseline`](https://github.com/slashkiko/repository-baseline)
から作成した。以下は baseline 由来の統制で、外す場合は理由を残すこと。

- mise がセキュリティツールのサプライチェーンを固定し、新しいリリースは 7 日待ってから使う
- Pinact が GitHub Actions の完全な commit SHA ピン留めを要求する
- actionlint と zizmor が workflow の構文とセキュリティ特性を検査する
- Betterleaks が Git 履歴全体をスキャンする
- 週次監査が OSPS Baseline のバージョン変更を検出する

初期化は dry-run を確認してから実行する。

```sh
mise run repository-initialize
mise run repository-initialize --configure-github
```

詳細は [`docs/security-baseline.md`](docs/security-baseline.md) と
[`SECURITY.md`](SECURITY.md) を参照。
