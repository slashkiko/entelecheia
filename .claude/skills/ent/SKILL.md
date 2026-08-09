---
name: ent
description: ent CLI で Goal を収束させるときの手順。agent-context での構造の把握、doctor での前提の確認、start / run / get / list の1周、--dry-run での事前確認、--limit での出力の絞り方、終了コードの読み方、WAITING_HUMAN や ESCALATE で人の承認や介入を待つところを扱う。
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
ent doctor                  # 回す前の前提が揃っているかを読み取り専用で調べる
ent start <slug>            # .goals/<slug>.yaml を登録して ACTIVE にする
ent run <slug>              # 1ティックだけ回して終了する
ent get <slug>              # 宣言部と実行時状態をまとめて読む
ent list                    # 登録済みの Goal を一覧する
```

追わなくなった Goal から降りるときだけ、もう1つある。

```
ent abandon <slug> --reason "なぜ追わないのか"
```

`--reason` は必須で、空白だけも通らない。status を `ABANDONED` にして理由を残すので、
次のティックはその Goal を拾わなくなる。理由は `ent get` の `state.abandonReason` に出る。

**対になる `ent complete` は無い。** 完了判定は VERIFIED な Fact だけで行う（§3.1）ので、
criteria が赤いまま「完了した」と書ける口は用意していない。ループの外で desired state が
満たされた場合——人間が手で PR をマージした、など——に使うのが `abandon` になる。
「終わった」ではなく「もう追わない」を記録する。

落とせない場合は終了コード 1 で、何も書かずに止まる。

- 既に終端（`COMPLETED` / `FAILED` / `ABANDONED`）。終端は塗り替えない
- `lease_owner` が埋まっている。別のプロセスが回している最中に横から落とさない
- `ent start` を挟んでいない。降りる先の状態が無い

`ent doctor` は書き込みを一切しない。state ディレクトリも作らない。

前提が欠けていても `ent run` は入口で落ちない。トークンが無くてもローカルの観測・
検証コマンド・Actor の実行は進むので、入口で殺すと進められるものまで止まるため。
その代わり、`GITHUB_TOKEN` が無いまま回すと `github.ci.conclusion` のような
`type: fact` の criteria が永久に unobserved のまま埋まらない。回り続けるので
気づけない。doctor は何が欠けているかをその場で出す。

終了コードだけは他のサブコマンドと意味が違う。0 は「failed が1件も無い」で、
1 は「failed が1件以上」を指す。実行時エラーではない。unknown は数えない。
Claude のログイン状態はトークンを消費せずに確かめられないので、常に unknown で出る。
詳細は stderr ではなく stdout の JSON の `checks[].detail` にある。

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
`doctor` と `agent-context` は常に JSON で、`--json` も `--limit` も受け取らない。
付けると終了コード 2 になる。

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
| 0 | 成功。ティックが最後まで回った（`ran: false` でも 0）。`doctor` では failed が1件も無い |
| 1 | 実行時エラー、または実行できない状態。詳細は stderr。`doctor` では failed が1件以上で、詳細は stdout の JSON |
| 2 | 引数が不正。stderr に有効値が並ぶ |

1 と 2 を取り違えないこと。2 は「打ち直せば通る」の意味で、stderr に有効値が並ぶ。
終端の Goal に `ent start` を掛けたときのように、argv は妥当だが実行できない状態は
1 になる。ここを 2 にすると、argv を変えて再試行し続けることになる。

`ran: false` は失敗ではない。`skipped` に理由（寝ている / 他のワーカーが処理中 / 終端）が入る。
`--dry-run` だけは例外で、`ran: false` でも `skipped` は `null` になる。代わりに
`dryRun: true` が付くので、そちらで見分ける。
