# 収束の測り方

**ent が良くなったかどうかを、7つの指標で測る。** この文書は測り方だけを決める。
これから入れる2つの変更（ループ検知の二系統化、Actor の試行台帳）より先に固定するため、
入れたものを正当化する指標を後から選べない。

指標ごとに実データ7本で叩いて確かめた結果、**7つのうち4つはいまの出力で測れ、1つは集計を足せば出せ、
2つは観測そのものが無い。** 観測が無い2つはここでは埋めない。足すかどうかは別の作業になる。

**ループ検知の変更には、過去データの基準線が無い。** `loop_detected` は7本を通して一度も
出ていないので、変更の前後を履歴で比べることはできない。§5 で前向きの測定に切り替える。

## 1. 何を基準線にするか

**基準線は、`.goals/.state/goals.db` に残っている7本の Goal になる。** 2026-08-25 13:16 から
2026-08-26 03:04 までの約14時間で回したもので、内訳は COMPLETED 3本、ABANDONED 4本になる。

| Goal | status | reconciles | Actor 起動 | DECIDE 呼び出し | metered USD | 実時間 |
| --- | --- | --- | --- | --- | --- | --- |
| `calculate-metered-cost-from-raw-logs` | COMPLETED | 3 | 2 | 2 | 1.5504 | 0.50h |
| `harden-what-plan-writes` | ABANDONED | 2 | 2 | 2 | 1.3663 | - |
| `plan-refuses-goals-with-nothing-to-do` | COMPLETED | 3 | 1 | 2 | 0.4035 | 8.18h |
| `plan-writes-declarations-that-hold` | ABANDONED | 1 | 1 | 1 | 0.9410 | - |
| `plan-writes-yaml-that-holds` | COMPLETED | 5 | 1 | 4 | 0.5596 | 2.15h |
| `surface-unregistered-declarations` | ABANDONED | 4 | 1 | 2 | 0.9186 | - |
| `zz-driver-boundary-probe` | ABANDONED | 1 | 0 | 1 | 0.0497 | - |

**USD の絶対値には意味が無い。** `examples/prices.example.json` は桁を揃えただけの仮の価格表で、
実際の単価ではない。同じ価格表で測った値どうしの比較にだけ使う。

`zz-driver-boundary-probe` は境界の確認に使った使い捨ての Goal で、宣言 YAML は既に消えている。
**完了率の分母からは外す。** 収束を測る対象ではないものを分母に入れると、率が意味を持たなくなる。

判断の内訳は次の5種類になる。全19件で、これは `reconciles` の合計と一致する。

| 判断 | 回数 |
| --- | --- |
| `ACT` | 6 |
| `ESCALATE(protected_path_touched)` | 4 |
| `COMPLETE` | 3 |
| `VERIFY` | 3 |
| `WAIT(human_review_pending)` | 3 |
| `ESCALATE(loop_detected)` | **0** |
| `ESCALATE(budget_exhausted)` | **0** |

**最後の2行がこの文書の出発点になる。** これから直そうとしているループ検知は、基準線の中で
一度も発火していない。

## 2. 指標を7つに割る

**指標を1本にしない。** 「`loop_detected` で人間が呼ばれた回数」1本なら、検知を弱めるだけで
改善に見える。減った分は `budget_exhausted` と無駄な Actor 起動へ移るので、1本では
その移動が見えない。互いの逃げ道を塞ぐ形で7つに割る。

| ID | 指標 | 採否 |
| --- | --- | --- |
| M1 | 完了率 | 採用 |
| M2 | 完了までの Actor 起動数 | 採用 |
| M3 | 完了までのトークンと USD | 採用 |
| M4 | 完了までの実時間 | 採用（単独では読まない） |
| M5 | 同一失敗シグネチャの反復回数 | 採用（観測が無い） |
| M6 | 人間介入の数 | **理由別に割って**採用 |
| M7 | 早すぎた停止の割合 | 採用（観測が無い） |

### M1 完了率

COMPLETED に届いた Goal の割合を、検証用の使い捨てを除いた分母で数える。基準線は 3/6 = 50%。

### M2 完了までの Actor 起動数

1つの Goal が COMPLETED に届くまでに Actor を何回起動したか。基準線は6本の中央値が1、合計8。
**M6 とセットで読む。** 検知を弱めれば人間は呼ばれなくなるが、代わりにここが増える。

### M3 完了までのトークンと USD

`ent cost` が出す4分類のトークンと、同じ価格表で計算した USD。基準線は6本で合計 5.7393、
中央値 0.93。M2 と違って DECIDE 側の消費も含むので、Actor 起動が減っても
リコンサイルが増えれば下がらない。

### M4 完了までの実時間

Goal を ACTIVE にしてから COMPLETE 判断が出るまでの時計。基準線は 0.50h / 2.15h / 8.18h。

**この値を単独で読まない。** 人間の承認待ちを含んでいる。8.18h の
`plan-refuses-goals-with-nothing-to-do` は2ティック目が `WAIT(human_review_pending)` で、
差の大半は人間が寝ていた時間になる。機械の時間と人間の時間を分けるには、判断ごとの
時刻が要る（§4 の M6 と同じ観測が要る）。

### M5 同一失敗シグネチャの反復回数

同じ失敗を何回繰り返してから止まったか。**試行台帳が作ろうとしている観測そのものになる。**
台帳が入れば「何を試して駄目だったか」が行として残るので、その反復を数えられる。

### M6 人間介入の数（理由別）

**総数1本では測れない。** 基準線の介入7件のうち4件は `protected_path_touched` で、
ループ検知とも試行台帳とも関係がない。総数で見ると、この4件の増減に
測りたい変化が埋もれる。理由ごとに分けて数える。

- `ESCALATE(loop_detected)` — 基準線 0
- `ESCALATE(budget_exhausted)` — 基準線 0
- `ESCALATE(protected_path_touched)` — 基準線 4
- `WAIT(human_review_pending)` — 基準線 3

### M7 早すぎた停止の割合

止まった Goal のうち、人間が「まだ進めたはずだ」と判断したものの割合。M6 の逃げ道を塞ぐ。
検知を強くすれば介入は増えるが、その介入が正しかったかはここでしか分からない。

## 3. いまの出力で測れるもの

**M1・M2・M3・M4 は、いま出ているものだけで測れる。** 以下は実データに対して実際に叩いた
コマンドと出力になる。`ent` は `process.cwd()` を repoRoot にする（`src/cli.ts:117`）ので、
測る対象のディレクトリで叩く。

### M1 — `ent list --json`

```console
$ ent list --json | jq -c '.[] | {id, status}'
{"id":"calculate-metered-cost-from-raw-logs","status":"COMPLETED"}
{"id":"harden-what-plan-writes","status":"ABANDONED"}
{"id":"plan-refuses-goals-with-nothing-to-do","status":"COMPLETED"}
{"id":"plan-writes-declarations-that-hold","status":"ABANDONED"}
{"id":"plan-writes-yaml-that-holds","status":"COMPLETED"}
{"id":"surface-unregistered-declarations","status":"ABANDONED"}
{"id":"zz-driver-boundary-probe","status":"ABANDONED"}
```

### M2 と M4 — `ent get <slug> --json`

```console
$ ent get calculate-metered-cost-from-raw-logs --json \
    | jq '{runs: (.runs|length), llm: .llm, activatedAt: .state.activatedAt,
           decidedAt: .decision.decidedAt, type: .decision.action.type}'
{
  "runs": 2,
  "llm": { "calls": 2, "tokens": 77473 },
  "activatedAt": "2026-08-25T13:16:44.789Z",
  "decidedAt": "2026-08-25T13:46:39.332Z",
  "type": "COMPLETE"
}
```

M4 は `state.activatedAt` と、`decision.action.type` が `COMPLETE` のときの
`decision.decidedAt` の差で出す。**`goals` に完了時刻の列は無い**ので、この差でしか取れない。

**`runs` は `--limit` で切られる。** 既定は50（`src/usecase/inspect.ts:22`）で、古い方から落ちる。
基準線の最大が2なので今回は欠けていないが、Goal が長くなれば M2 を数え落とす。
50を超える Goal を測るときは `--limit` を上げる。

### M3 — `ent cost <slug> --prices <path>`

```console
$ ent cost calculate-metered-cost-from-raw-logs --prices examples/prices.example.json
{
  "goal_id": "calculate-metered-cost-from-raw-logs",
  "token_usage": {
    "input_tokens": 222710,
    "cache_creation_input_tokens": 122923,
    "cache_read_input_tokens": 8381339,
    "output_tokens": 60929
  },
  "charged_token_usage": { ... },
  "metered_usd": 1.5504059,
  "charged_usd": 1.5504059,
  "oauth_metered_usd": 0,
  "sources": { "runs": 2, "llm_calls": 2 }
}
```

`ent cost` は状態ストアだけを読み、宣言 YAML を読まない。だから宣言を消した
`zz-driver-boundary-probe` でも値が出る。一方 `ent get` は宣言を読むので、同じ Goal では落ちる。

```console
$ ent get zz-driver-boundary-probe --json
ENOENT: no such file or directory, open '.../.goals/zz-driver-boundary-probe.yaml'
```

**畳んだ Goal の宣言を消すと、M1 と M3 は残るが M2 と M4 が測れなくなる。**
測定対象にする Goal の宣言は消さない。

## 4. 集計を足せば出せるもの

**M6 は、記録には残っているが、いまの出力からは読めない。** `ent get` の `decision` も
`ent list` の `stopped` も**直近1件だけ**を出す（`src/usecase/inspect.ts:128`）。生涯の
回数ではないので、そのまま数えると取りこぼす。

実例が基準線にある。`surface-unregistered-declarations` は `ESCALATE(protected_path_touched)` を
3回出しているが、`ent list` には1件にしか見えない。

```console
$ ent list --json | jq -c '.[] | {id, status, stopped}'
{"id":"calculate-metered-cost-from-raw-logs","status":"COMPLETED","stopped":null}
{"id":"harden-what-plan-writes","status":"ABANDONED","stopped":null}
{"id":"plan-refuses-goals-with-nothing-to-do","status":"COMPLETED","stopped":null}
{"id":"plan-writes-declarations-that-hold","status":"ABANDONED","stopped":{"action":"ESCALATE","reason":"protected_path_touched"}}
{"id":"plan-writes-yaml-that-holds","status":"COMPLETED","stopped":null}
{"id":"surface-unregistered-declarations","status":"ABANDONED","stopped":{"action":"ESCALATE","reason":"protected_path_touched"}}
{"id":"zz-driver-boundary-probe","status":"ABANDONED","stopped":{"action":"WAIT","reason":"human_review_pending"}}
```

`harden-what-plan-writes` の `stopped` が `null` なのも同じ理由になる。最後の判断が `ACT` で、
人間はその後に手で畳んだ。**`stopped` は「いま誰の番か」を出すもので、履歴ではない。**

材料は `decisions` テーブルにあり、`Store.listDecisions` は全件を返す。出す口が無いだけになる。
**この口を足すのは別の作業にする。** この作業では挙動を変えない。M4 の「機械の時間と
人間の時間を分ける」も同じ口で解ける。

## 5. 観測が無いもの

**M5 と M7 は、いまの記録のどこにも無い。埋めない。**

### M5 — 失敗が1件も記録されていない

`runs` は8件すべて `completed` で、`error_kind` は全件が空になる。

```console
$ sqlite3 goals.db "select status, error_kind, count(*) from runs group by status, error_kind;"
completed||8
```

**Actor が失敗して終わった記録が1件も無い。** 基準線の空回りは、Actor の失敗ではなく
「同じ意図でもう一度 ACT した」形で現れている。`calculate-metered-cost-from-raw-logs` の
2ティック目と `harden-what-plan-writes` の2ティック目がそれで、どちらも1ティック目とは
別の意図として記録されているので、機械には同一とは読めない。

`Decision.observed_digest` は「観測が動いていない」ことしか言わず、「同じ失敗を繰り返した」は
言わない。**M5 を測るには試行台帳が要る。** 台帳が入るまで、この指標の値は空欄になる。

### M7 — 早すぎたかどうかを記録する欄が無い

`abandon_reason` は自由記述で、早すぎた停止かどうかのフラグを持たない。基準線の4件は次のとおり。

| Goal | `abandon_reason` の要旨 |
| --- | --- |
| `harden-what-plan-writes` | ベースが古く、修正が重複していた |
| `plan-writes-declarations-that-hold` | 保護パスの関門で停止し、Goal を分割した |
| `surface-unregistered-declarations` | 成果はマージ済み。関門が毎ティック誤って発火する |
| `zz-driver-boundary-probe` | 検証用の使い捨て |

**読めば分類できるが、機械には数えられない。** M7 を測るには、人間が畳むときに
「早すぎた / 妥当だった」を記録する欄が要る。足すかどうかは別の作業になる。

## 6. 比較の取り方

### リプレイ評価は、片方にしか使えない

**材料は残っている。** `guard_base_sha` は7本すべて git から到達でき、宣言は6本、
生ログは26本が `.goals/.state/runs/` に残っている。過去の失敗時点の worktree を
固定して回し直すことは、原理的にはできる。

**しかしループ検知には種が1つも無い。** `loop_detected` は0回なので、二系統化した検知が
偽陽性を減らしたかどうかも偽陰性を拾ったかどうかも、再現すべき失敗点が無いために確かめられない。
**リプレイでループ検知の変更は測れない。**

**試行台帳には種が2つある。** 同じ Goal の中で ACT を2ティック続けた
`calculate-metered-cost-from-raw-logs` と `harden-what-plan-writes` になる。
2本では傾向にならないので、**リプレイは補助**に留める。

リプレイには副作用がある。先に見ておく。

- Actor を実 LLM で回すので**非決定的**になる。同じ入力で同じ結果は返らない
- 1 Goal あたり基準線で 0.40〜1.55 USD かかる。複数回回すならその倍数になる
- `open_pull_request: auto` の宣言は **PR を立てる**。リプレイでは宣言を書き換えるか、
  隔離した worktree で回す

### 前向きに、各アーム10本で見る

**素直な A/B は取れない。** Goal ごとに難易度が違い、同じ Goal を両方の実装で回すことは
（リプレイを除いて）できない。変更の前後で回した Goal 群を比べる形になる。

**各アーム10本を最小とする。** 基準線が6本（分母に入る分）で、そこから読める中央値が
Actor 起動1・USD 0.93 になる。10本あれば中央値と四分位が動いたかどうかは読めるが、
**有意差の検定には足りない。** この指標群を検定には使わない。傾向として読む。

**前のアームは4本足りない。** いまの実装で回した Goal は6本しかないので、2つの変更を
入れる前に4本を回して10本にする。**足せないまま変更を入れるなら、前のアームは6本のままで
確定させる。** 変更を入れたあとに前のアームを足すことはできない。

読み方を先に決めておく。後から閾値を選ぶと、指標を割った意味が無くなる。

- **M6 の `loop_detected` は、増えたかどうかしか読めない。** 基準線が0なので、偽陽性の
  減少は測れない。二系統化で新たに人間を呼ぶようになったら、それは悪化になる
- **偽陰性の側は測れる。** 「人間が手で畳んだ Goal のうち、空回りしていたのに検知が
  出なかったもの」の割合になる。基準線では ABANDONED 4本中2本
  （`harden-what-plan-writes`、`surface-unregistered-declarations`）がこれに当たる
- **M2 と M3 は中央値で見る。** どちらかが基準線から2倍を超えて増えたら、
  介入が減っていても改善とは読まない

## 7. 測り方

`mise run metrics` が、いま測れるものを1 Goal 1行の TSV で出す。

```sh
mise run metrics --prices examples/prices.example.json
```

**状態ストアは `process.cwd()` の下に出来るので、測る対象のディレクトリで叩く。**
worktree ごとに `.goals/.state/goals.db` が分かれるため、どこで叩いたかで結果が変わる。
**基準線として数えるのは、本体リポジトリのルートで回した分だけにする。**

このタスクが読むのは `ent` の出力だけになる。`goals.db` を直接引くと、CLI が出していない列まで
測れることになり、§3〜§5 の3分類と食い違う。分類の境界をタスクが体現する。

出力例が §1 の表になる。`--prices` を省くと USD の列は `-` になる。

## 8. なぜ `docs/decisions/` ではなくここに置くか

`docs/decisions/` は「持ち込まれた案を判定した記録」で、判定が終われば動かない
（`docs/decisions/README.md`）。**この文書は動く。** 観測が足されれば §5 の指標は §3 へ移り、
基準線は測るたびに増える。判定の記録と混ぜると、決定が後から書き換わったように見える。

**指標を7つに割ると決めた判定そのものは、`docs/decisions/0003-metrics-before-the-changes.md`
に置く。** 却下した案（1本で測る）が主役になるので、あちらの書式に合う。

`design.md` §10-2「上限値の初期チューニング」が、この文書の測定結果を待っている論点になる。
`max_unchanged_reconciles` などの値は仮置きのままで、基準線が無いと動かせない。
