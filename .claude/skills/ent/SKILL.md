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

## Actor を選ぶ

既定はClaude Code。全phaseをCodexにするなら、同じコマンドに`ENT_ACTOR=codex`を付ける。
provider・model・effortは`DECIDE`、`IMPLEMENT`、`REVIEW`、`INVESTIGATE`ごとにも選べる。
`ENT_<PHASE>_ACTOR` / `ENT_<PHASE>_MODEL` / `ENT_<PHASE>_EFFORT`がphase固有の指定で、
無ければ`ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT`へ落ちる。
effortの有効値はClaude Codeが`low / medium / high / xhigh / max`、Codexが
`none / minimal / low / medium / high / xhigh`。providerに合わない値は引数エラーになる。

```sh
ENT_ACTOR=codex ent doctor
ENT_ACTOR=codex ent run <slug>

ENT_DECIDE_ACTOR=codex \
ENT_IMPLEMENT_ACTOR=claude-code \
ENT_REVIEW_MODEL=<model> \
ent run <slug>
```

選んだ値はティックをまたいでDBに固定されない。cronでも毎回同じ環境変数を渡す。
Codexを含むphaseが1つでもあれば、先に`codex login status`でログインを確かめる。
Actorが使用量上限で止まった場合は、失敗分類とトークンをRunへ保存し、guardが元のACTを
`WAIT(usage_limit)`へ差し替える。Goalは`WAITING_EXTERNAL(usage_limit)`へ遷移し、
`resume_after`までは再実行しない。

## まだ `.goals/` が無いリポジトリ

`.goals/` が無い場所では、`ent doctor` の `goals` と `state_ignored` が同時に failed になる。
壊れているのではなく、まだ始めていない。1周を始める前に1度だけ叩くものがある。

```
ent init                    # .goals/ と .gitignore の行と Goal の雛形を置く
```

`ent init` は冪等で、2度目は既にある `.goals/*.yaml` を上書きせず、`.gitignore` に同じ行を
二重に足さない。git リポジトリでなければ何も作らずに終了コード 1 で断る。

**これはリポジトリの外にも書く。** `~/.claude/skills/ent` に、ent 本体の `.claude/skills/ent` を
指すシンボリックリンクを張る。この手順書を、対象リポジトリで作業するエージェントが skill として
読めるようにするため。実体は写さないので、正本は ent 本体の1箇所のままになる。対象リポジトリ側に
`.claude/` は増えない。**`$HOME` を書き換えるので、人間に断らずに叩いてよいものではない。**

既にここを指していれば触らずに残す（冪等が成り立つのはここ）。この ent へのリンク以外のものが
既にある場合——別の場所を指すリンク、壊れたリンク、実体のディレクトリ——は、`.goals/` も含めて
何も作らずに終了コード 1 で断る。どちらが正かを決めるのは ent ではないので、退避するかどうかは
人間に聞く。ent 本体の `.claude/skills/ent` が見当たらないときだけは、断らずに stderr へ出して
リンク無しで終わる。

`--json` を付けると、この1件も `entries` に載る。初回が `created`、2度目からが `kept` で、
`path` はリポジトリの中のものが相対なのに対し、これだけ絶対パスになる。

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

**対になる `ent complete` は無い。** 完了判定は VERIFIED な Fact だけで行う
（design.md §3.1）ので、
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
止まるため。その代わり、トークンを1つも読めないまま回すと `github.ci.failed_job_count`
のような `type: fact` の criteria が永久に unobserved のまま埋まらない。回り続けるので
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
選んだproviderのログイン状態は、`claude_login`または`codex_login`としてunknownで出る。
phase間でproviderが混ざる場合は両方が出る。
詳細は stderr ではなく stdout の JSON の `checks[].detail` にある。

`ent run` は**1ティックで必ず終了する**。常駐しないし、完了まで待つフラグも無い。
収束させるには `ent run` を繰り返し叩く（cron から回す形を想定している）。
待ちは `ent run` の中で寝るのではなく、`WAIT` という判断として返る。
ただし`goal.depends_on`の依存待ちは例外で、`WAIT`も状態遷移も作らず`skipped`に出る。
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
Goal では `the Goal is not registered` が入る（`ent init` の直後がこれにあたる）。
dry-run かどうかは `skipped` ではなく `dryRun` で見分ける。

## 進捗を PR に投稿しないで回す

既定では criteria の pass 状況を PR コメントに積む。投稿せずに回すなら:

```
ent run <slug> --report stdout          # 出力 JSON の report.body に入る
ent run <slug> --report ./progress.md   # ファイルに追記する
```

移るのは進捗の宛先で、そこに1節ぶん増える（次の段落）。観測も判断も変わらず、
push と PR の作成も止まらない。PR そのものは今までどおり公開される。投稿しなくなるのは
criteria の pass 状況になる。

`GITHUB_TOKEN` が無くても、PR がまだ無くても出る。進捗を書くのは PR を確保するより前で、
確保できるかどうかとは切り離してある。

`stdout` を指定しても素の Markdown は流れない。stdout は JSON 専用のままで、本文は
`report.body` に入る。人間に見せるなら `jq -r .report.body` で取り出す。

**`--report` の本文には、末尾に `## Review role message` の節が付く。** レビュー役が最後に
返した本文をそのまま出す節で、PR コメントには載せない。**したがって `--report` の本文と
PR コメントの本文は同じではない。** 節が出るのは `--report` を付けたティックだけで、
`ReviewPort.latest()` が null を返す Goal（レビュー役を1度も起動していない、あるいは
完了した Run が1つも無い）では節そのものが出ない。生ログを読めなかったときは理由が、
本文が残っていない Run では読んだ Run の id が節に入る。ティックは落ちない。

**節の積まれ方は宛先で違う。** `stdout` は1回叩いて1回出すので積み上がらないが、
ファイルは追記なので、回した数だけ本文が並ぶ。しかも節が読むのは直近の完了した
レビュー役の Run なので、次のレビューが終わるまで中身は毎ティック同じになる
（`WAIT(review_pending)` が続く区間）。長く回すなら `stdout` を使うか、宛先の
ファイルを分ける。

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

**どちらの経路も、リポジトリに書き込み権限がある人のものだけを数える。**
レビュー承認は PR の作成者を除く（GitHub 自体が自分の PR への Approve を許さない）が、
コメントの定型文は作成者も数える。1人で回しているリポジトリでは、そこが唯一の
承認経路になる（design.md §10-4）。

`ESCALATE` は行動であって Goal の状態ではない。`protected_path_touched` による
`ESCALATE` は、触ってはいけないパスに変更が出たまま止まっている状態で、
Goal の状態としては `WAITING_HUMAN` になる。承認待ちではなく、人間が片付けるのを
待っている。次のティックでも解けない。`guard_unavailable` も同じ形で、こちらは
「触っていない」ではなく**関門そのものを動かせなかった**状態を指す。基準にした
commit が消えたときがこれにあたる。`budget_exhausted` の `ESCALATE` だけは
`BLOCKED` になる。

`status` に入るのは Goal の状態（`ACTIVE` / `WAITING_HUMAN` / `WAITING_EXTERNAL` /
`BLOCKED` / `COMPLETED` など）で、`ESCALATE` や `WAIT` は `action` の側に出る。

## controller が push や PR 作成をしなかったとき

Goal の宣言に `policies.publish` があると、controller は `manual` と書かれた段を行わない。
そのティックの出力に `publishHold` が入る（宣言を書いていない Goal には出ない）。

| キー | 入るもの |
| --- | --- |
| `step` | 止めた段。`push_branch` か `open_pull_request` |
| `reason` | `declared_manual`。宣言で止めたということ |
| `pushed` | `branch` が remote にあるか |
| `branch` | PR の head になるブランチ |
| `base` | PR の base |

判定はこのキーで行う。`skipped` と `decision.rationale` は人間が読む1行なので、
文面で分岐すると文言を直した時点で黙って壊れる。

同じティックの `action` は `ESCALATE(push_branch_declared_manual)` か
`ESCALATE(open_pull_request_declared_manual)`、`status` は `WAITING_HUMAN` になる。

`--dry-run` にはこの停止が映らない。publish を通らないので `publishHold` は出ず、
`wouldTransitionTo` も止める前の判断のまま返る。宣言で止まる Goal では、dry-run の予告と
実ティックの結果が食い違う。

**`step: open_pull_request`（`pushed: true`）なら、代わりに PR を立てる。**
ブランチは既に remote にあり、止まっているのは controller が作らないと宣言されている
からだけになる。この宣言は controller に作らせない口であって、叩いた側に作らせない
口ではない。

```
gh pr create --head <publishHold.branch> --base <publishHold.base> \
  --title <Goal の name> --body <本文>
```

**代行に要る宣言は `.goals/<slug>.yaml` から読む。`ent get` には出ない。**
`ent get` が宣言部から出すのは `goal`（`id` / `name` / `desired_state` / `depends_on`）だけで、
`repository` も `acceptance_criteria` も1キーも出ない。`verifications` が持つのも criterion の
id と結果までなので、description も `verification.type` もそちらには無い。`publishHold` に
入るのは、宣言からは決まらないもの（`branch` と `pushed`）になる。

| 代行に要るもの | どこから読む |
| --- | --- |
| head と base | `publishHold.branch` / `publishHold.base` |
| `--draft` を付けるか | `.goals/<slug>.yaml` の `repository.pull_request.draft` |
| PR のタイトル | `.goals/<slug>.yaml` の `goal.name`（`ent get` の `goal` でもよい） |
| 本文の Desired State | 同じく `goal.desired_state` |
| 本文の criteria 一覧 | `.goals/<slug>.yaml` の `acceptance_criteria`（id / `verification.type` / description） |

`repository.pull_request.draft: true` なら `--draft` を付ける。controller が立てるときは
渡している値なので、付け忘れると**代行した PR だけがレビュアーに通知を飛ばす**。
`open_pull_request: manual` が止めようとしているのは、まさにその通知になる。

本文は controller が立てるものと同じ形にする（`pullRequestBody`、`src/publish/index.ts`）。

````markdown
Changes for the entelecheia Goal `<goal.id>`.

## Desired State

<goal.desired_state>

## Acceptance Criteria

- `<id>` (<verification.type>) <description>

The controller stacks progress as comments. Approve with the following phrase.

```
/ent approve <criterion-id>
```
````

`verification.type: human` の criteria は、この定型文が本文に無いとレビュアーが承認の口を
見つけられない。**本文の `<criterion-id>` は実際の id に置き換えない。** 承認として数えるのは
PR コメントの側で、行全体が `/ent approve <実際の id>` と一致したときだけになる。本文は
書き方を見せる雛形にしておく。

次のティックがその PR を見つけて先へ進む。宣言はそのままでよい。
**人間が先に中身を見てから立てたいと言われている場合だけ**、立てずに `publishHold` を
そのまま渡す。

**`step: push_branch`（`pushed: false`）は代行しない。** ブランチが remote に無いので
PR は立てられない。手で push しても controller はそれを観測できないため、宣言を `auto` に
戻すまで毎ティック同じところで止まる。人間に渡す。

**`BLOCKED` にはならない。** 予算を使い切っても `ESCALATE(push_branch_declared_manual)` が
`ESCALATE(budget_exhausted)` を上書きするので、状態は `WAITING_HUMAN` のままになる。
止まっているあいだ `max_reconciles` と `max_actor_runs` は進むが、`max_wall_clock` だけは
止まる（予算切れ以外の `ESCALATE` は待ちとして経過時間から引かれる）。
「そのうち `BLOCKED` になって気づく」は起きないので、人間に渡すまで止まったままになる。

`ESCALATE(protected_path_touched)` などの関門で止まったティックには `publishHold` は
出ない。そちらは push も PR も代行してはいけない停止になる。

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
