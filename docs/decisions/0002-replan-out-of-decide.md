# 0002. `REPLAN` を DECIDE の選択肢から外す

- 日付: 2026-09-07
- 状態: 採用

## 何を決めたか

DECIDE のプロンプトと `LLM_MAY_CHOOSE` から `REPLAN` を外す。LLM が選べる行動は
`ACT` / `VERIFY` / `WAIT` の3つになる。`actionSchema` の union には残すが、それは
過去の Decision を読み直すためだけで、新しい Decision がこの行動になることはない。

同じ判定の中で、「実装計画を state として持つ（ティックに PLAN の段を足す）」案を
**却下**した。

## なぜそう決めたか

**controller に受け手が無く、選ばれたティックが空振りするため。** Actor を起動するのは
`ACT` だけなので（`src/controller/index.ts`）、`REPLAN` を選んだティックは何も書かずに
終わり、次のティックが同じ材料で決め直す。埋める先の Plan を DB に持たないと決めてある
（design.md §4.5、分解した1本ごとに Goal を立てるので、Plan にあたるものはサブ Goal の
宣言そのものになる。§10-12）以上、作り直す相手が存在しない。

**その意図は既に guard の側にある。** 「いまのやり方では Gap を埋められない」の判定は
`max_unchanged_reconciles` と `ESCALATE(loop_detected)` が観測から出していて、LLM の
判断に依存しない。停止条件を LLM に持たせない（design.md §7、オーナーの問い1）以上、
guard が持つ判定の弱い版を LLM 側に並べておく理由が無い。

プロンプトから外すだけでは足りない。許可表に残したままだと、モデルが返した `REPLAN` が
`llmActionSchema` で弾かれて再試行を1回消費する。逆に許可表からだけ外すと、選択肢として
見せた行動が必ず弾かれる。両方を同時に外す。

外した理由をプロンプトに書かない。`ESCALATE` には「選べない」と添えてあるが、あちらは
guard が代わりに決めるので境界を伝える意味がある。`REPLAN` は行動そのものが無いので、
名前を出せば「いつかは選べる」と読める。`waitActionLines` と同じ手になる。

## 代わりに検討して落とした案

- **実装計画を state として持ち、`REPLAN` に受け手を作る。** 分解した1本ごとに Goal を
  立てる方針（§10-12）と二重になる。Plan を DB の別の層に持つと、宣言（Goal YAML）と
  実行時状態のどちらが正なのかが Plan について曖昧になり、§4.6 の分け方が崩れる。
  ループを回している最中に planner が YAML を書き換える経路（§10-12）が入れば、書き換える
  相手は Goal 宣言そのものになるので、別の層は要らない。
- **`actionSchema` の union からも `REPLAN` を消す。** `decisions` テーブルは読むたびに
  `actionSchema.parse` を通る（`listDecisions`）ので、既に `REPLAN` を選んだことのある
  Goal の行がそこで落ち、履歴を読み直せなくなる。`waitReasonSchema` の `review_pending` と
  同じ理由で残す。
- **入れ直すための口を別に用意する（コメントアウトした選択肢、フラグ、設定）。** 用意しない。
  `LLM_MAY_CHOOSE` の `REPLAN: false` と union に残した語と `nextStatus` の遷移が、そのまま
  口になっている。入れ直すのは boolean を1つ反転してプロンプトの行を1つ戻すだけで、
  眠っている仕掛けを別に置く必要が無い。

## 効いてくる範囲

- `src/decide/index.ts`: `LLM_MAY_CHOOSE` と DECIDE のプロンプト。`LLM_ACTIONS` と
  `llmActionSchema` のメッセージはここから導出されるので、追って直す箇所は無い
- `src/domain/action.ts`: `REPLAN` は残すが、新しく選ばれない行動として書く
- `src/domain/goal-state.ts`: `REPLAN → ACTIVE` の遷移は残す。union に語がある以上、
  この switch は網羅でなければならない
- 入れ直す条件: ループを回している最中に planner が Goal 宣言を書き換える経路（§10-12）が
  入ること。その経路が無いあいだ、`REPLAN` は「もう一度考える」以上のことをしない
