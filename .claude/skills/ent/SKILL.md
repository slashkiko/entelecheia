---
name: ent
description: ent CLI で Goal を収束させるときの手順。agent-context での構造の把握、start / run / get / list の1周、--dry-run での事前確認、--limit での出力の絞り方、終了コードの読み方、WAITING_HUMAN や ESCALATE で人の承認や介入を待つところを扱う。
---

# ent を回す

`ent` は現在の状態を、宣言した end state に収束させる controller。エージェントが叩く前提の手順を書く。
人間向けの導入は README.md にある。ここは重複させない。

## 最初に叩くもの

```
ent agent-context
```

サブコマンド・引数・フラグの型・環境変数・終了コードを JSON で出す。
`--help` の散文を読む必要は無い。以下の手順が古くなっていたら、こちらが正。

## 1周の手順

```
ent start <slug>            # .goals/<slug>.yaml を登録して ACTIVE にする
ent run <slug>              # 1ティックだけ回して終了する
ent get <slug>              # 宣言部と実行時状態をまとめて読む
ent list                    # 登録済みの Goal を一覧する
```

`ent run` は**1ティックで必ず終了する**。常駐しないし、完了まで待つフラグも無い。
収束させるには `ent run` を繰り返し叩く（cron から回す形を想定している）。
待ちは `ent run` の中で寝るのではなく、`WAIT` という判断として返る。
ポーリングを自作しない。次の周まで待つのは呼び出し側の仕事になる。

回す前に中身だけ見たいなら:

```
ent run <slug> --dry-run    # OBSERVE / VERIFY / ASSESS / DECIDE だけ回す
```

Actor の起動と PR への書き込みは起きない。snapshot / verifications / decision /
status も書かない。次のティックが何を観測し、どの criteria が落ちていて、
次に何をするつもりかが読める。

タダではない。VERIFY は criteria のコマンドを本当に流し、DECIDE は LLM を呼ぶ。
消費したトークンは `llm_calls` に記録が残る。安全に何度でも叩けるものではない。

出力は `ran: false` / `skipped: null` / `dryRun: true` になる。書いていたら
どの状態に移っていたかは `wouldTransitionTo` に入る。

## 出力の絞り方

`run` / `get` / `list` は既定で JSON を出す。`start` は `--json` を付けたときだけ JSON になる。

```
ent list --limit 10
ent get <slug> --limit 5    # runs の件数。落ちるのは古い方から
```

`--limit` の既定は 50。切り捨てたときだけ、絞り込み方が **stderr** に出る。
`run` / `get` / `list` の stdout は JSON だけなので、そのまま `jq` に渡してよい。

## 人の承認で止まるところ

`WAITING_HUMAN` は失敗ではない。人間が動くまでは、何度回しても状態は変わらない。
ただし承認を検知するのは次のティックなので、回し続けること自体は正しい。

- PR のレビュー承認
- PR コメントの `/ent approve <criterion-id>`（`verification.type: human` の criteria）

この2つはどちらもエージェントが代行してはいけない。人間が承認したことの signal
なので、代わりに出すと承認の意味が消える。`ent get <slug>` の `verifications` で、
どの criterion が待ちなのかを読む。

`ESCALATE` は行動であって Goal の状態ではない。`protected_path_touched` による
`ESCALATE` は、触ってはいけないパスに変更が出たまま止まっている状態で、
Goal の状態としては `WAITING_HUMAN` になる。承認待ちではなく、人間が片付けるのを
待っている。次のティックでも解けない。`budget_exhausted` の `ESCALATE` だけは
`BLOCKED` になる。

`status` に入るのは Goal の状態（`ACTIVE` / `WAITING_HUMAN` / `WAITING_EXTERNAL` /
`BLOCKED` / `COMPLETED` など）で、`ESCALATE` や `WAIT` は `action` の側に出る。

## 終了コード

| code | 意味 |
| --- | --- |
| 0 | 成功。ティックが最後まで回った（`ran: false` でも 0） |
| 1 | 実行時エラー。詳細は stderr |
| 2 | 引数が不正。stderr に有効値が並ぶ |

`ran: false` は失敗ではない。`skipped` に理由（寝ている / 他のワーカーが処理中 / 終端）が入る。
`--dry-run` だけは例外で、`ran: false` でも `skipped` は `null` になる。代わりに
`dryRun: true` が付くので、そちらで見分ける。
