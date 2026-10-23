# known-bad と known-good

factory の検査（`ent-check`）と自動マージの判定（`decideAutoMerge`）が、落とすべき PR を
落とし、通すべき PR を通すことを確かめる見本。`packages/check/tests/known-samples.test.ts` が
全部を回す。

- `known-bad/`: factory が止めるべき PR
- `known-good/`: factory が止めてはいけない PR
- `known-bad/fixture/`: 見本を当てる作り物のリポジトリ。どちらの見本もここに差分を当てる

**中身はすべて作り物の値で書く。** 実在のリポジトリ、パッケージ、人、データを入れない。

## 見本の書き方

見本は1件1ディレクトリにし、`meta.yaml` と `change.patch` を置く。

```yaml
# meta.yaml
description: 落ちるテストの期待値を、定数を確かめるだけのアサーションに書き換える
kind: fix             # 作業の種別
author: actor         # actor | renovate
expect:
  stage: check        # check | governor
  verdict: fail       # known-bad は fail | needs-human、known-good は pass | auto-merge
  rule_id: test-weakened
```

- `stage: check` は、検査で落ちる（通る）ことを確かめる。`rule_id` は evidence.json の
  `results[].rule_id` になる
- `stage: governor` は、検査の結果を受けた判定で人に回る（自動マージになる）ことを確かめる。
  検査で落ちるかどうかは問わない。下限が検査の結果に頼らずに効くことを見るため。
  known-good は検査も通ること。
  `rule_id` は承認ルールの下限の id（`checks-config` など）か、人に回す理由の code
  （`renovate_conditions_unmet` など）になる
- known-bad には `rule_id` が要る。名指ししないと、別の理由で落ちても緑になる

判定は、ポリシーが全部の種別の自動マージを許し、レビューも済んだ状態で回す。一番緩い設定でも
人に回ることを確かめるため。governor が GitHub とレジストリから読む値（lockfile に新しく
入ったパッケージ、公開からの日数）は、`observed` に作り物の値で書く。

```yaml
observed:
  added_packages: []
  releases:
    - { name: example-money, released_days_ago: 30 }
```

`change.patch` は、fixture のリポジトリで `git diff` を取ったものになる。fixture を変えたら、
当たらなくなった見本を作り直す。

## 見本を足すとき

- factory をすり抜けた変更が見つかったら、その形を known-bad に足す
- 規則が正当な変更を止めたら、その形を known-good に足す
- 検査の規則を変えたら、規則を外すと見本が赤になることを確かめる。見本が規則の有無に
  関係なく緑なら、その見本は何も確かめていない
