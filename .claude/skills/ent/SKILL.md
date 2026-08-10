---
name: ent
description: ent CLI で Goal を収束させるときの手順。agent-context での構造の把握、init での初回セットアップ、doctor での前提の確認、start / run / get / list の1周、--dry-run での事前確認、abandon で追わなくなった Goal を終端にするところ、--report で進捗を PR に投稿せず stdout やファイルに出すところ、--limit での出力の絞り方、終了コードの読み方、WAITING_HUMAN や ESCALATE で人の承認や介入を待つところを扱う。
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

## まだ `.goals/` が無いリポジトリ

`.goals/` が無い場所では、`ent doctor` の `goals` と `state_ignored` が同時に failed になる。
壊れているのではなく、まだ始めていない。1周を始める前に1度だけ叩くものがある。

```
ent init                    # .goals/ と .gitignore の行と Goal の雛形を置く
```

`ent init` は冪等で、2度目は既にある `.goals/*.yaml` を上書きせず、`.gitignore` に同じ行を
二重に足さない。git リポジトリでなければ何も作らずに終了コード 1 で断る。

雛形はスキーマとして妥当なところまでしか埋まっていない。残りの `desired_state` と
`acceptance_criteria` が、何を達成するかの宣言にあたる。**この2つは人間が書くもので、
エージェントが埋めて `ent start` まで進めてよいものではない。**

## 1周の手順

```
ent doctor                  # 回す前の前提が揃っているかを読み取り専用で調べる
ent start <slug>            # .goals/<slug>.yaml を登録して ACTIVE にする
ent run <slug>              # 1ティックだけ回して終了する
ent get <slug>              # 宣言部と実行時状態をまとめて読む
ent list                    # 登録済みの Goal を一覧する
```

`ent start` は、叩いたディレクトリの HEAD を関門の基準として記録する。Actor の
worktree はその commit から切られ、関門が worktree の差分を取る相手も同じ commit になる。
**Goal の宣言と仕様は `ent start` より前に commit しておく。** そうすれば人間が書いた分は
基準の側に入り、worktree の差分には Actor が書いた分だけが並ぶ。

回している間、この基準にした commit を amend も rebase もしない。分岐点が消えると
差分を取れなくなり、`ESCALATE(guard_unavailable)` で止まる。ティックの最中に
`.goals/*.yaml` を書き換えるのも避ける。本体リポジトリ側の ACT 前後の差として拾われ、
`.goals/**` はどの Goal からも外せない保護パスなので `protected_path_touched` になる。

HEAD を読めなかった場合と、この記録より前に start した Goal は `default_branch` を
基準にする。そのときは人間が書いた分も Actor の編集として並ぶ。止まったあとの扱いは
下の「人の承認で止まるところ」を読む。

追わなくなった Goal から降りるときだけ、もう1つサブコマンドがある。

```
ent abandon <slug> --reason "なぜ追わないのか"
```

`--reason` は必須で、空白だけも通らない。status を `ABANDONED` にして理由を残すので、
次のティックはその Goal を拾わなくなる。理由は `ent get` の `state.abandonReason` に出る。

**対になる `ent complete` は無い。** 完了判定は VERIFIED な Fact だけで行う（§3.1）ので、
criteria が赤いまま「完了した」と書ける口は用意していない。ループの外で desired state が
満たされた場合（人間が手で PR をマージした、など）に使うのが `abandon` だ。
「終わった」ではなく「もう追わない」を記録する。

落とせない状態なら、終了コード 1 で何も書かずに止まる。

- 既に終端（`COMPLETED` / `FAILED` / `ABANDONED`）。終端は塗り替えない
- `state.leaseOwner` が埋まっている。別のプロセスが回している最中に横から落とさない
- `ent start` を挟んでいない。降りる先の状態が無い

`--reason` を付け忘れた場合だけは 2 になる。argv を直せば通るので、1 とは倒す向きが違う。

`ent doctor` は書き込みを一切しない。state ディレクトリも作らない。

前提が欠けていても `ent run` は入口で落ちない。GitHub のトークンが無くても
ローカルの観測・検証コマンド・Actor の実行は進むので、入口で殺すと進められるものまで
止まるため。その代わり、トークンを1つも読めないまま回すと `github.ci.conclusion` の
ような `type: fact` の criteria が永久に unobserved のまま埋まらない。回り続けるので
気づけない。doctor は何が欠けているかをその場で出す。

GitHub のトークンは `doctor` も `run` も同じ順で読む（`GITHUB_TOKEN` → `GH_TOKEN` →
`gh auth token`）。対話シェルから叩くぶんには、gh にログインしていれば環境変数を
渡さなくてよい。**cron から回すときは別で**、PATH と gh の設定が引き継がれるとは
限らないので `GITHUB_TOKEN` を明示するか、同じ環境で `ent doctor` を叩いて確かめる。
doctor の `github_token` が落ちるのは、3つとも読めなかったときになる。
環境変数に**空文字**を設定してあれば「渡さないと決めた」と読み、gh も呼ばない。
未設定と空文字はここだけ意味が違う。

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

出力は `ran: false` / `dryRun: true` になる。書いていたらどの状態に移っていたかは
`wouldTransitionTo` に入る。`skipped` は原則 `null` だが、`ent start` を挟んでいない
Goal では「Goal が登録されていない」が入る（`ent init` の直後がこれにあたる）。
dry-run かどうかは `skipped` ではなく `dryRun` で見分ける。

## 進捗を PR に投稿しないで回す

既定では criteria の pass 状況を PR コメントに積む。投稿せずに回すなら:

```
ent run <slug> --report stdout          # 出力 JSON の report.body に入る
ent run <slug> --report ./progress.md   # ファイルに追記する
```

移るのは進捗の宛先だけになる。観測も判断も変わらず、push と PR の作成も止まらない。
PR そのものは今までどおり公開される。投稿しなくなるのは criteria の pass 状況だけになる。

`GITHUB_TOKEN` が無くても、PR がまだ無くても出る。進捗を書くのは PR を確保するより前で、
確保できるかどうかとは切り離してある。

`stdout` を指定しても素の Markdown は流れない。stdout は JSON 専用のままで、本文は
`report.body` に入る。人間に見せるなら `jq -r .report.body` で取り出す。

出力の `report` に入るもの:

| 宛先 | 入るもの |
| --- | --- |
| `stdout` | `destination` / `written` / `error` / `body` |
| ファイル | `destination` / `path` / `written` / `error`（本文はファイルの側にある） |

`written: false` になるのは2通りある。書けなかったとき（`error` に理由が入り、stderr にも
1行出る）と、そもそもティックが回らなかったとき（`error` は null で、理由は同じ出力の
`skipped` にある）。どちらも終了コードは変わらない。通知の失敗でティックの成否を
塗り替えない。

`--report` を受け取るのは `run` だけで、他のサブコマンドに付けると終了コード 2 になる。
`--dry-run` との併用も 2 で断る。あちらは publish を通らないので書く先が無く、
criteria の結果は `observed.verifications` の側に入っている。

## 出力の絞り方

`run` / `get` / `list` は既定で JSON を出す。`init` と `start` と `abandon` は `--json` を
付けたときだけ JSON になる。
`doctor` と `agent-context` は常に JSON で、`--json` も `--limit` も受け取らない。
付けると終了コード 2 になる。

```
ent list --limit 10
ent get <slug> --limit 5    # runs の件数。落ちるのは古い方から
```

`--limit` の既定は 50。切り捨てたときだけ、絞り込み方が **stderr** に出る。
`run` / `get` / `list`（と `init` / `start` / `abandon` の `--json`）の stdout は JSON だけなので、
そのまま `jq` に渡してよい。

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
待っている。次のティックでも解けない。`guard_unavailable` も同じ形で、こちらは
「触っていない」ではなく**関門そのものを動かせなかった**状態を指す。基準にした
commit が消えたときがこれにあたる。`budget_exhausted` の `ESCALATE` だけは
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
`--dry-run` は `ran: false` でも失敗ではなく、`skipped` も原則 `null` になる。
ただし未登録の Goal に掛けたときだけは理由が入るので、dry-run かどうかは
`skipped` ではなく `dryRun: true` で見分ける。
