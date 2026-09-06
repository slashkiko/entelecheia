---
name: ent-bookend
description: >
  ent の Goal を回す「前」と「後」に、人間側でやる作法を通すスキル。前は、落ちるテストを先に書いて
  protected_paths で守り、宣言ごと baseline に commit して `ent start` を人間に渡すまで。後は、Goal が
  terminal になってから baseline より後ろの commit を意味単位に整理して押すまで。
  トリガーワード: ent-bookend, ent の準備, Goal を立てる, Goal の宣言を書く, ent start の前,
  着手条件, 落ちるテストを先に, テスト先行, ent の後片付け, コミット整理, commit を整理,
  squash, 意味単位のコミット, ent が終わった, COMPLETED になった
  「ent で〇〇をやりたいから Goal 作って」「ent 終わったからコミット整理して」
  「ent start していい状態にして」のような依頼で発動する。
  ent CLI そのものの手順（run / get / doctor / plan の使い方）は `ent` skill が持つ。
  こちらはその前後にある人間側の工程だけを扱う。
---

# ent の Goal を挟む2つの工程

ent は宣言した end state に収束するところだけを見る。順序を宣言する口が無いので、
**「テストを先に書く」も「コミットを意味単位に割る」も ent の中には無い。** どちらも
人間側に残る工程で、このスキルはその2つを通す。

- **Part 1（前）** — 落ちるテストと宣言を用意し、baseline に commit して `ent start` を人間に渡す
- **Part 2（後）** — Goal が terminal になってから、baseline より後ろの commit を整理して押す

`ent` CLI の手順そのものは `ent` skill にある。ここでは繰り返さない。構造が知りたければ
`ent agent-context` を叩く。

---

## Part 1: 着手の準備

### 1. 1本の Goal に収まる範囲を決める

収まらないなら分ける。`ent plan --desire "..." --dry-run` が分割案を出せる。
**書かせるだけで、`ent start` までは進めない。**

### 2. 落ちるテストを先に書く

**なぜ先か。** ent は end state を宣言して収束する controller で、順序を宣言する口を持たない。
「テストを先に書く」は手順なので criteria に還元できない（design.md §3.2）。検証に還元できるのは
「着手時点で落ちる criterion がある」という状態だけで、それは `ent start` の前にしか作れない。

**先に書かないと何が起きるか。** 着手時点で `type: command` の criteria が全部通る Goal を start
すると、ent は Gap が無いので COMPLETE を選ぶ。1ティック目で、何も書かずに完了扱いになる。
`ent plan` は宣言時点でこれを拒むが（`alreadyDone` / `src/usecase/plan.ts`）、手で書いた Goal は
その検査を通らない。

**実際に走らせて、落ちることを確かめる。** 「落ちるはず」と書かない。出力を残す。

### 3. テストを `protected_paths` に入れる

実装役は編集ツールを持つ唯一の role なので、テストを書き換えて criteria を通せる。宣言の
`policies.protected_paths` にテストのパスを並べる。検証系（タスクランナーの設定、lint 設定、
CI 定義）も同じ理由で入れる。

### 4. criteria を書く

- `type: command` を最低1本。**着手時点で落ちるもの**を必ず含める
- レビューを通してから完了させたいなら
  `verification: { type: fact, key: review.verdict, equals: approved }` を足す。承認が出るまで
  Gap が残るので COMPLETE に届かない
- **`github.ci.*` と `policies.publish.open_pull_request: manual` は併用できない。** CI は PR を
  観測できたティックでしか引かないので（`src/observe/index.ts:379-381`）、PR を最後に回すと
  永久に unobserved のまま Gap が残る。PR を先に開く（`repository.pull_request.draft: true` で
  通知を抑えられる）か、CI を criteria から外すかを、ここで決める

`desired_state` は「どう作るか」ではなく「何が満たされていればよいか」を書く。手順を書くと、
Actor が従ったかどうかを誰も確かめられない形になる。

### 5. 宣言とテストを commit する

`ent start` は叩いた時点の HEAD を関門の baseline に固定する。宣言とテストが baseline 側に
入っていないと、**人間が書いた分まで Actor の編集として関門に並ぶ。**

### 6. 人間に渡す

**`ent start` は打たない。** 宣言を読んで start するのが人間の承認点で、そこを代わりに踏むと
承認そのものが消える。渡すときは3点を書く。

- 確かめたこと（テストが落ちること、その出力）
- 確かめていないことと、その理由
- 人間にしか決められない残り

---

## Part 2: 終わったあとの整理

controller が commit するのは「`type: command` の criteria が全部通ったティック」で1回ずつ
（design.md §10-11）。**1ティック1コミット**なので、履歴は作業の意味ではなくティックの区切りで
割れている。意味単位に直すのはここでやる。

**いつ触ってよくて、どこまで触ってよいかは `ent` skill の「One round」が持つ。** ここに書くのは
手順だけになる。

### 1. terminal になっているか確かめる

```bash
ent get <slug> --json
```

`state.status` が `COMPLETED` / `FAILED` / `ABANDONED` のときだけ進む。`WAITING_HUMAN` はティックを
止めないので、ここには含めない。`policies.publish.open_pull_request: manual` の Goal は、
**PR を作る → terminal を見届ける → 整理**、の順になる。

### 2. 整理してよい範囲を出す

同じ出力の `state.guardBaseSha` から HEAD までが、Actor の書いた範囲になる。

**`guardBaseSha` が `null` なら止める。** 範囲を推測しない。人間に聞く。

### 3. 整理する

`<guardBaseSha>..HEAD` の中だけを squash / reword する。**baseline commit 自体は触らない。**
消したときに何が起きるかも、`ent` skill の同じ節にある。

コミットメッセージは、初見のコントリビューターが差分とそれだけで読める状態にする。
ティックの都合（「2周目のレビューで出た指摘」「N ティック目で直した」など）は執筆の経緯なので
落とす。**残すのは決定の経緯。**

### 4. 押す前に

1. criteria のコマンドを全部通す。**`--no-verify` で関門を迂回しない**
2. `git range-diff <base>...<old> <base>...<new>` を出して、**中身が変わっていないこと**を見せる
3. force push はユーザーの承認を取る。`policies.require_human_approval` の `force_push` は
   Actor のツールに掛かる拒否で、人間の手には掛からない。だから止めるのはこちら側の作法になる
