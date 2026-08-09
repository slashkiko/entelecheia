# entelecheia 設計ドキュメント

このリポジトリの単一の設計ソース。新しく参加するとき（あるいは新しいセッションを開くとき）は、
まずこれを読めば足りるように書いてある。

最終更新: 2026-08-09（MVP レビューの指摘を反映）

---

## 1. 何を作るのか

プロジェクトの完了状態（Desired State）を宣言すると、現在状態を観測し、
ギャップが埋まるまで Claude Code を起動する controller。

Kubernetes の controller が `replicas: 3` に収束させるのと同じ構造を、
ソフトウェア開発のタスクに持ち込む。人間が書くのは「どうなってほしいか」だけで、
タスク分解も Actor の選択も実装手順も controller が決める。

```
        Desired State（人間が宣言）
                 │
                 ▼
  ┌──────► OBSERVE ──► ASSESS ──► DECIDE ──┐
  │                                         │
  │        ┌────────────────────────────────┤
  │        ▼          ▼        ▼       ▼    ▼
  │       ACT      VERIFY    WAIT  ESCALATE COMPLETE
  │        │          │        │
  └────────┴──────────┴────────┘
```

図は DECIDE の主要な分岐だけを示す。REPLAN も分岐先の一つで、`PLAN → ACT → VERIFY` を
固定の Workflow にはしない。Plan の更新は DECIDE が選べる行動の一つにすぎない。

---

## 2. なぜこれを作るのか

構想を5層に分解して既存を調べた結果、上の2層が空白だった。

| 層 | 内容 | 既存の状況 |
|---|---|---|
| L1 | プロジェクト単位の Desired State を収束させる Goal Controller | **空白** |
| L2 | 各サービスを Project / Task / PR という論理リソースに正規化する Adapter | **空白** |
| L3 | 複数のコーディングエージェントを並列実行し worktree と PR を管理する | 競合多数 |
| L4 | 永続 Goal とイベント駆動の再開 | 部品が揃っている |
| L5 | 実行履歴からの自己改善 | 研究段階 |

- **L1**: kagent や HumanLayer Agent Control Plane は「宣言的」を名乗るが、宣言の対象は
  エージェント定義であってプロダクトの完成状態ではない。lidangzzz/goal-driven は criteria を
  満たすまでループするが単一リポジトリ完結でアダプタ層がない。
- **L2**: MCP は配管であって抽象ではない。Composio や Corsair が解いているのは認証と接続の
  一元化。Merge.dev の ticketing unified data model が唯一近いが SaaS 前提でコードは対象外。
- **L3**: Emdash（20以上のプロバイダ、Linear/GitHub/Jira 取り込み、worktree 並列）、
  mission-control、Conductor、amux。**ここは自作しない。**
- **L4**: Temporal / Restate / Cloudflare Agents / Google ADK / LangChain Open SWE /
  Amp Event-Driven Orbs。**部品として参照する。**
- **L5**: EvoRoute など。**履歴の形式だけ決めて後回し。**

したがって実装コストは L1 と L2 に集中させ、L3 は Claude Code（Agent SDK）へ委譲する。

### 名前について

エンテレケイア（ἐντελέχεια）はアリストテレスの用語で「可能態が現実態に至った状態」を指す。
Goal に対して実現しようとする状態そのものを指す言葉にあたる。

`setpoint`（制御工学の目標値。意味は最適）・`cairn`・`attractor`・`servo` は npm で既に取られていた。
`telos` は npm が空いていたが Telos Network（ブロックチェーン）が検索空間を占有している。
`entelechy`（英語形）は辞書に載っている普通名詞で、固有名詞として立てにくく検索ノイズも多い。
ギリシャ語形の `entelecheia` は npm・GitHub とも実質無人。

Kubernetes 自体が κυβερνήτης の音写であって英語化した helmsman ではない、という先例にも合う。
読みにくさは `kubectl` と同じく短縮コマンド（`ent`）で解決する。

---

## 3. 中核の設計判断

判断が必要だった論点と、その結論。**ここを崩すと設計全体が崩れる。**

### 3.1 Fact に信頼度を持たせ、完了判定は VERIFIED のみで行う

Kubernetes と違い、ソフトウェアプロジェクトの現在状態は構造化されていない。
`oauth.implemented: false` を信頼できる形でどう得るのかが最大の問題になる。
「コードを読んで判断する」は LLM の主観であって観測ではない。

そこで Observed State をフラットな真偽値にせず、各 Fact に出所と信頼度を持たせる。

- **VERIFIED** — 外部から検証可能な一次情報のみ。検証コマンドの終了コード、CI の conclusion、
  GitHub API のレスポンス、git の出力。evidence を必須にする。
- **INFERRED** — LLM の推論やコード読解。Plan の材料には使ってよいが、
  Goal を COMPLETED にする判定には使わない。

これを discriminated union で表現し、型レベルで強制する（`src/domain/fact.ts`）。
「Agent がそう思っているだけ」と「実際に確認できた」を型で分離するのが目的。

観測できなかった対象について Fact を作らないのも同じ理由。
「PR が存在しない」ことと「PR を取得できなかった」ことは別物なので、後者を Fact にはしない。

ただし**落とすのは Fact であって記録ではない**。この2つがどちらも「Fact の不在」に
畳まれると、ASSESS は GitHub の障害を「PR は無い」と読む。Phase 0 を1周して、
そこから誤った DECIDE が出ることが分かった。そこで `ObserveResult` / `VerifyResult` は
`facts` の外側に `unobserved` / `unverified` を持ち、結論が出なかった対象を
理由付きで積む（`src/domain/fact.ts` の `Unresolved`）。

- `port_failed` — Port が throw した。外部が落ちている可能性がある
- `pending` — 手続きとしてまだ結論が出ていない。人間の承認待ち、参照先 Fact の不在など

Port が `null` を返した場合はここに積まない。「存在しないと観測できた」からで、
積むのは「確かめられなかった」ときだけになる。VERIFY 側も同じ構造で、
「criteria が落ちた」（`criteria.<id>.passed: false` という Fact）と
「criteria を検証できなかった」（`unverified`）を混ぜない。

`pending` は1回の観測・検証の結果であって、Goal の状態ではない。
§4.4 の `WAITING_HUMAN` / `WAITING_EXTERNAL` は、DECIDE が `unverified` を読んで
選ぶ遷移先にあたる。同じ「待ち」でもレイヤーが違うので語を分けてある。

### 3.2 Acceptance Criteria に還元できない Goal は ACTIVE にしない

`replicas: 3` は状態空間が有限だから収束を判定できる。「OAuth でログインできる」は無限。
Goal の入口で検証手段への変換を必須にし、変換できない criteria は登録させない。

MVP では Goal YAML を人間が手書きするので、YAML のレビューがそのまま承認ゲートになる。
承認用の別 UI は要らない。

### 3.3 Adapter は1実装だけ作り、境界だけ先に切る

Notion のページと GitHub Issue を同じ Task に正規化しきれない問題は、
Merge.dev が長年苦戦している領域。最初から全プロバイダを抽象化すると破綻する。

1環境で動くものを作ってから抽象を抽出する。ただし Provider のインターフェースは
最初から切っておき、1実装に癒着していないかだけレビューする。

### 3.4 webhook は MVP では不要

Kubernetes の controller も watch だけで動くわけではなく、必ず periodic resync を持つ。
reconcile は「今の状態を見て差分を埋める」冪等な関数で、
起動トリガーが webhook かタイマーかは本質ではない。

- **GitHub**: REST/GraphQL を 30〜60 秒間隔でポーリング。conditional request（ETag）を使えば
  レート制限はほぼ消費しない
- **Slack**（将来）: Socket Mode なら WebSocket の outbound 接続なので受信口が要らない

レビュー承認の検知が1分程度遅れて困る場面はない。
設計上は `EventSource` インターフェースだけ切っておき、後から webhook に差し替える。

### 3.5 LLM への依存は Claude Code 1本に寄せる

LLM を呼ぶのは DECIDE のうち Gap が残っている経路だけで、そこを Actor 層経由にすれば
依存も認証も1系統で済む。出力は必ず Zod で検証し、通らなければ受け取らない（最大2回リトライ）。

ASSESS は Fact だけを読む純関数で、LLM を呼ばない。DECIDE も、完了判定と停止条件は
**guard**（LLM を呼ばずに決める純ロジック。`src/decide/`）が持つ。
待ちは両方にまたがる。Gap が無いのに unresolved が残る場合の `WAIT` は guard が決め、
Gap が残る場合の `WAIT`（レビュー待ちなど）は LLM も選べる。ただし
**いつまで寝るかは常に guard が決める**（§10-3）。LLM に委ねるのは Gap の埋め方だけになる。

Agent SDK は Claude Code の OAuth をそのまま使うため Claude Max のサブスクリプション内で動く。
一方、Messages API に切り出した部分だけは API キーの従量課金になる。
定額で回すなら Claude Code 1本に寄せるのが唯一の選択肢。

`LlmPort` を挟んでおき、実測でコストや品質が問題になったら DECIDE だけ差し替える。

### 3.6 待機はプロセスではなく状態にする（中断可能性）

使用量上限やレビュー待ちで controller が常駐して落とせなくなるのは論外。

- reconcile はどのティックも**有限時間で必ず return する**。sleep して常駐しない
- 待ちは `WAITING_*` として DB に書き、プロセスは終了する
- 次のティックは cron の次周回で来る。`ent run --once` を cron から叩く構成なら
  常駐プロセスがそもそも存在しない（`ent watch` は未実装。§6）

副作用の前に意図を書く **write-ahead** を徹底し、任意の瞬間に kill されても
次ティックで回収できる crash-only 設計にする。

```
1. Run(status: starting) を commit          ← ここで kill されても
2. Claude Code を起動                          次ティックが orphan として回収
3. Run(status: completed|failed) を commit
4. Fact / Decision を同一トランザクションで反映
```

SIGTERM を受けたら走行中の Actor に伝播して kill し、Run を `interrupted` で確定し、
lease を解放して終了する。Ctrl+C が効かない状態は作らない。

---

## 4. アーキテクチャ

### 4.1 論理リソースと Adapter

本書では **Provider** をインターフェース、**Adapter** をその1実装の意味で使う。
`CodeProvider` に対する GitHub Adapter、という関係になる。

**Port** はこれらとは別の粒度で、reconcile の各段階が依存する関数の口を指す。
`observe()` が受け取る `CodeProviderPort` のように、Provider の全体ではなく
その段階が実際に呼ぶメソッドだけを並べる。テストで差し替える単位でもある。

| Provider | 論理リソース | MVP の実装 |
|---|---|---|
| ProjectStateProvider | `Project` / `Task` | 実装しない（インターフェースのみ） |
| CodeProvider | `Repository` / `Branch` / `PullRequest` | GitHub |
| ReviewProvider | `Review` / `Approval` | GitHub |
| CommunicationProvider | `Message` / `Notification` | GitHub PR コメント + CLI 標準出力 |
| CIProvider | `CIRun` | GitHub Actions |

各 Provider は read（OBSERVE 用）と write（ACT 用）を分ける。

### 4.2 Actor

```ts
type ActorRole = 'implement' | 'review' | 'investigate'

interface Actor {
  id: string
  kind: 'claude-code' | 'codex' | 'human'
  roles: ActorRole[]
  run(task: Task, ctx: RunContext): Promise<RunResult>
}
```

MVP では `claude-code` だけを実装し、3つの role をすべて持たせる。
Codex を足すときに Planner 側のコードを変えなくて済む形にしておけば十分。

### 4.3 OBSERVE が取得するもの

```
PR        number, state, mergeable, head_sha, review_decision, requested_reviewers
Review    state (APPROVED / CHANGES_REQUESTED / COMMENTED), author, submitted_at
CI        workflow_run の conclusion、失敗時は失敗ジョブ名とログ URL
Issue     state, labels, linked_pr
local     current_branch, HEAD sha, worktree に未コミット変更があるか
```

CI の失敗内容まで取るのが要点。「CI が落ちた」だけでは次の ACT に渡す材料がない。
失敗ジョブ名とログがあれば、そのまま Claude Code に渡して修正させられる。

観測キーの実体は `src/domain/fact-keys.ts` に列挙してある。上の表は論理リソース側の
呼び名で、Fact のキーは `github.pr.review_decision` のようなドット区切りの snake_case になる。
Phase 0 では Port の camelCase フィールド名との対応表がどこにも無く、実装者が
テストを読まないと当てられなかった。Goal YAML の `verification: { type: fact }` は
このレジストリを参照するので、実在しないキーは Zod が弾く。

上の表とレジストリは現時点で1対1ではない。Review 行（`author` / `submitted_at`）に
対応するキーは無く、レビューの状態は `github.pr.review_decision` に集約されている。
レビュー一覧は `review_decision` の導出に使うだけで、個別のレビューを Fact として
出す Port は無い。表は取得したい対象、
レジストリは実際に取得できる対象を表すので、実装するときはレジストリ側を正とする。

`github.pr.review_decision` は REST の `pulls/{n}` と `pulls/{n}/reviews` から導出する。
GraphQL なら1回で取れるが、ETag による conditional request（§3.4）が効くのは REST の
GET だけなので、レビュアーごとに最後の1件を見て組み立てる。変更要求を承認より優先する。
`github.issue.linked_pr` は「その Issue 自身が PR である」場合しか埋まらない。
相互参照された PR は timeline API が要るので、まだ観測しない。

**`github.pr.review_decision` *だけ* を人間の承認の観測源にはできない。** GitHub は自分が
作った PR に Approve を押させないので、controller が Goal の所有者と同じアカウントで PR を
作る限り `reviewDecision` は `APPROVED` にならない。これを `type: human` の唯一の判定に使うと
reconcile は `WAIT(review_pending)` から抜けられず、§9 の完了判定に到達できない。
`.goals/assess-and-decide.yaml` の Goal で実際に踏んだ。

経路そのものが誤りではない。`ApprovalPort` はレビュー承認と PR コメントの定型文の
2つを signal にする（理由と判定順は §10-4）。

### 4.4 状態機械

```
Goal のライフサイクル

  DRAFT → AWAITING_CRITERIA_APPROVAL → ACTIVE
                                        ⇅
                    WAITING_HUMAN / WAITING_EXTERNAL / BLOCKED
                                        ↓
                      COMPLETED | FAILED | ABANDONED

待機の種類（いずれも reconcile は即 return する）

  WAITING_HUMAN(reason: review_pending)     レビュー承認待ち
  WAITING_EXTERNAL(reason: ci_running)      CI 完了待ち
  WAITING_EXTERNAL(reason: usage_limit)     Claude の使用量上限。resume_after を持つ
  BLOCKED(reason: budget_exhausted)         予算・回数・時間の上限に到達
```

`AWAITING_CRITERIA_APPROVAL` は MVP では実装しない。§3.2 のとおり、Goal YAML の
レビューがそのまま承認ゲートを担うので、`ent start` は `DRAFT` から `ACTIVE` に直行する。
型には残してあるが、この値を書き込むコードは無い。

ESCALATE は reconcile が選ぶ行動、BLOCKED は Goal の状態。
ESCALATE の結果として Goal は BLOCKED か WAITING_HUMAN に遷移する。

**終端状態からは戻さない。** `nextStatus` と `tick` に加えて、`ent start` も
終端の Goal を ACTIVE に戻さない。COMPLETED を後から取り消せると、
§9 の完了判定そのものが意味を失う。やり直すなら DB の状態を明示的に戻す。

Claude Max には5時間ローリングの使用量上限と週次上限がある。
何時間も走る controller はいずれ必ず当たるので、クラッシュではなく
`WAITING_EXTERNAL(usage_limit)` に落ちて、リセット時刻まで寝て自動再開する。
リセット時刻が取れなければ指数バックオフ。

### 4.5 データモデル

以下は DB のテーブル定義であり、`src/domain/` の型とは1対1に対応しない。
例えば evidence は、DB では `evidence_source` / `evidence_detail` の2列に開き、
型では `evidence: { source, detail }` として入れ子で持つ。

```
Goal          id, name, desired_state, status, lease_owner, lease_until,
              resume_after, activated_at, reconciles, pr_number, issue_number
StateSnapshot goal_id, observed_at
Fact          snapshot_id, seq, key, value, observed_at, confidence, evidence
Unresolved    snapshot_id, seq, key, reason, detail      観測できなかった対象
Verification  goal_id, reconcile_seq, criterion_id, result, reason,
              evidence, detail, verified_at
Decision      goal_id, reconcile_seq, observed_digest, action, rationale,
              decided_by, decided_at
Run           goal_id, intent, actor, worktree, attempt, status, started_at,
              finished_at, exit_code, log_ref, tokens, artifacts, detail
LlmCall       goal_id, purpose, tokens, log_ref, ok, called_at

Criteria      未作成。criteria は Goal YAML が正
Plan / Task   未作成。Plan の永続化を入れる Goal で足す
Event         未作成。webhook を入れる Goal で足す
```

`policies` と `budget` は Goal YAML が正で、DB には持たない。宣言部と実行時状態を
混ぜないという §4.6 の分け方に従う。

`LlmCall` は当初この一覧に無かった。DECIDE を Actor 層経由に寄せた（§3.5）結果、
Run を作らない LLM 呼び出しが生まれ、そのトークンを §7 のとおり残す場所が要るようになった。

**結論が出なかった対象も永続化する。** ここを落とすと §3.1 が避けたかった
「Fact の不在に畳まれる」問題が DB 層で再発し、ASSESS が取りこぼしを読めなくなる。
観測側は `Unresolved` の行として、検証側は `Verification.result` を
`passed` / `failed` / `unresolved` の3値にして持つ（`unresolved` のときだけ `reason` が埋まる）。

`Verification` 行と `criteria.<id>.passed` の Fact は同じ結果の二重表現になるが、
前者が criteria 単位の索引、後者が ASSESS に渡る観測値という役割分担にする。

**この2つは同じ criterion について違う結論を出すことがあり、それは意図どおり。**
reconcile は前ティックの Fact を土台に今ティックの観測を重ねるので、今ティックで
検証できなかった criterion にも前ティックの `passed: true` が残る。ASSESS が答えるのは
「VERIFIED な根拠で満たされているか」なので、そこは Gap にしない（そうしないと、
GitHub が一時的に落ちただけで直したはずの Gap が復活する）。`Verification` が答えるのは
「このティックで何が起きたか」なので、`unresolved` を Fact より先に見る。
役割が違うので判定を1つの関数に畳まない。畳むと、どちらかの意味が失われる。

**`Decision` を必ず残す。** L5 の改善レイヤーは後回しにするが、
そこに食わせる履歴の形式だけは最初から確定させておく。

`Goal` の `lease_owner` / `lease_until` が「1 Goal につき reconcile は同時に1つ」を担保する。
行ロックではなく期限付きの所有権にすることで、プロセスがクラッシュしても自動で解放される。

**ティックが走っているあいだは期限を延長し続ける。** ACT は Claude Code の実行なので
分単位でかかる（§9 の実測では、1ティック目に 1,341,349 tokens を消費している）。
`leaseSeconds` は 300 なので、延長しないと ACT の途中で期限が切れる。cron から回す構成
（§3.6）では、そこで別プロセスが lease を奪い、同じ worktree（名前は `goal.id` 固定）で
2つの ACT が並行する。稀な競合ではなく、実運用の既定の挙動になっていた。

```sql
UPDATE goals
   SET lease_owner = :worker_id,
       lease_until = :now_plus_5min
 WHERE id = :goal_id
   AND (lease_owner IS NULL OR lease_owner = :worker_id
        OR lease_until IS NULL OR lease_until < :now);
-- 更新行数が 0 なら他のワーカーが lease を持っている。今回のティックはスキップ。
-- 自分が持っているなら期限の延長になる。取得と延長を同じ1文にしておくと、
-- 「延長したつもりで別のワーカーの lease を上書きする」経路が生まれない
```

### 4.6 ファイル配置

```
.goals/<slug>.yaml            人間が編集。Git 管理。宣言部のみ
.goals/.state/goals.db        SQLite。機械のみが書く。gitignore
.goals/.state/runs/<run-id>/  Agent の生ログ・diff。DB にはパスだけ持つ
.goals/.state/worktrees/<slug>/ Actor が編集する worktree
```

人間が編集する宣言部と、機械が書き換える実行時状態を混ぜない。
同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
`ent get <slug>` が両者をマージした1枚を標準出力に吐くので、参照時は1ファイルに見える。

`.goals/<slug>.yaml` のスキーマは `src/domain/goal.ts` にある。slug は `goal.id` と
一致させる（突き合わせは `src/domain/goal-loader.ts`）。ファイル名は Phase 番号ではなく
Goal の内容から付ける。Phase は本書側の計画であって Goal の属性ではない。
こうしておけば、Phase の区切りを変えてもファイル名は腐らない。

Agent の全出力を DB の行に入れない。数十MBの文字列を SQLite に押し込むと
クエリが遅くなり、壊れたときの復旧もつらい。ログはファイル、DB は索引とメタデータに徹する。

### 4.7 なぜファイルだけでなく DB を使うのか

並行処理の危険（複数ワーカーの同時書き込み、read-modify-write の lost update）もあるが、
決め手は別の3つ。

1. **履歴が走査ではなくクエリになる。** L5 は「このタスク種別ではどの Actor の成功率が高いか」を
   出す。ファイル走査で書くものではない
2. **クラッシュ整合性。** reconcile が書き込み途中で死ぬと JSON は壊れたまま残る
3. **イベントの冪等性。** ポーリングは同じイベントを何度も拾う。
   「この event_id は処理済みか」はインデックス付きの参照で解くのが自然。
   これは webhook を入れた時点で効く理由で、`Event` テーブルはまだ作っていない（§4.5）

SQLite の設定は以下。WAL にすれば「複数リーダー + 単一ライター」が同時に動く。

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

---

## 5. MVP のスコープ

前提が「実環境1本に決め打ち」だったが、その実環境（Notion のページ・Slack ワークスペース）が
まだ存在しないため、依存先を GitHub だけに絞った。

### 入れる

- Goal の登録と永続化。Desired State と Acceptance Criteria は `.goals/*.yaml` に手書き
- OBSERVE（GitHub Issue / PR / CI、ローカル repo）
- ASSESS（ギャップ算出）、PLAN / REPLAN、DECIDE
- ACT（Claude Code の headless 実行、git worktree 隔離）
- VERIFY（`command` = 検証コマンド、`fact` = CI ステータスなど観測値との照合、`human` = 人間承認）
- 状態機械、ポーリング、write-ahead 永続化、予算とループ上限、使用量上限での自動待機
- 通知と承認は GitHub の PR コメント + CLI 標準出力で完結させる。
  承認の signal はレビュー承認と PR コメントの定型文の2つで、CLI 標準出力は通知だけを担う（§10-4）

### 入れない

- Notion 連携（読み取り・書き戻しとも。環境ができてから足す）
- Slack 連携（同上）
- Web UI（CLI と生成レポートのみ）
- GitLab / Linear / Jira の Adapter 実装（インターフェースだけ切る）
- 複数 Actor の並列実行（インターフェースは複数対応、実装は逐次1本）
- Codex CLI の実装（`kind` の型だけ用意）
- L5 改善レイヤー（History は貯めるだけ、学習はしない）

Notion と Slack を外したことで、MVP の外部依存が GitHub 1つになり、
認証も GitHub token と Claude Code の OAuth だけで済む。
「Adapter を差し替えられる」という価値提案の検証は MVP 完了後に回る。
Phase 3 も GitHub 単独の自己ホストなので、そこでは検証されない。

---

## 6. 技術選定

### 言語

**TypeScript を採用した。決め手は Claude Agent SDK の対応状況。**

| 言語 | 利点 | 欠点 |
|---|---|---|
| **TypeScript** | Agent SDK 公式対応。Zod 1つで「LLM の構造化出力・YAML バリデーション・DB スキーマ」を賄える。discriminated union が強く Event / Decision のモデリングが素直。Notion・Slack・GitHub すべて公式 SDK。`yaml` のコメント保持ラウンドトリップが最良 | 配布が重い（Node 前提、単一バイナリ化は SEA か bun compile）。ネイティブ依存のクロスコンパイルが面倒。長時間常駐時のメモリ管理は Go より雑 |
| Python | Agent SDK 公式対応。Pydantic は Zod と同等以上。ruamel.yaml のラウンドトリップも優秀 | CLI として配布するのがつらい（uv / pipx 前提）。union の表現力が TS に劣る。asyncio と同期ライブラリの作法が混在しがち |
| Go | 単一バイナリ配布で導入障壁が最小。長時間常駐と並行処理が最も堅い。controller-runtime のイディオムをそのまま持ち込める | **Agent SDK が無い**（`claude -p` を exec することになる）。sum type が無く union モデリングが冗長。Notion / Slack の SDK が非公式 |
| Rust | 型システムは最良（enum が完全な sum type）。単一バイナリ | Agent SDK が無く周辺 SDK も薄い。MVP の速度が落ちる |

設計思想には Go が一番合う（「宣言的リソースを controller が収束させる」は Go の世界のもの）。
それでも落ちるのは Agent SDK が無い一点で、そこが今回の中核依存にあたる。

配布の弱さは `npx entelecheia` で試せるようにすれば十分カバーできる。

### ライブラリ

| 領域 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node.js 24（`mise.toml` で固定） | ネイティブモジュールの安定性 |
| Actor 実行 | `@anthropic-ai/claude-agent-sdk` | Claude Code のライブラリ版。`claude -p` の exec と違い権限制御・hooks・セッション管理を API で扱える。Max の OAuth をそのまま使う |
| スキーマ | Zod | Agent 出力の検証ゲートと YAML バリデーションを同一定義で兼ねる |
| YAML | `yaml`（eemeli） | コメント保持のラウンドトリップ編集。機械が書き戻すなら必須 |
| DB | `node:sqlite`（Node 標準） | 同期 API でコードが素直。Node 22.13 以降はフラグなしで使える（22.5 で導入、それ以前は無い）。`mise.toml` が Node 24 を固定し、`engines` も `>=24` にしてあるため常に使える。better-sqlite3 + Drizzle の採用予定を取り下げた（下記） |
| CLI | `node:util` の `parseArgs`（Node 標準） | サブコマンドが4つなので依存を足す価値が出ない。10 を超えたら citty か oclif に寄せる |
| プロセス実行 | `node:child_process`（Node 標準） | 検証コマンドと git を叩くだけなので標準で足りる。ストリーム制御が要るようになったら execa に移す |
| GitHub | `@octokit/rest` + plugin-throttling/retry | ETag でポーリングのレート制限を節約 |
| ログ | pino（未着手） | 構造化ログ。Decision テーブルとは別に生ログを残す。いまは CLI が JSON を1本出すだけ |
| テスト | Vitest | |
| Lint | Biome | 設定が少なく速い |
| 状態機械 | 自前の discriminated union | DECIDE が LLM 判断なので状態機械は薄く保つ。可視化が欲しくなったら XState |

`@notionhq/client` と `@slack/bolt` は MVP から外れたので、現時点では入れない。

### DB と CLI を Node 標準に寄せた理由

Phase 2 の3本目で better-sqlite3 + Drizzle と citty を入れる直前に見直し、
DB と CLI のどちらも Node 24 標準で置き換えた。判断の根拠は3つ。

1. better-sqlite3 はネイティブモジュールで、上表が TypeScript の欠点に挙げた
   配布の重さをさらに増やす。`node:sqlite` は同じ同期 API を標準で持つ
2. Drizzle の価値はマイグレーションだが、Goal YAML のスキーマは `version: 1` を
   literal で固定してあり（§10-8）、まだマイグレーションが存在しない
3. CLI のサブコマンドは `start` / `run` / `show` / `list` の4つで、citty の型の恩恵より
   依存が1つ増えるコストの方が重い

結果として、controller の本体は zod と yaml の2つだけに依存する。
同じ理由で、プロセス実行も execa ではなく `node:child_process` にしてある。

外部依存は Port の実装側に寄せた。4本目で `@octokit/rest`（+ throttling / retry）と
`@anthropic-ai/claude-agent-sdk` が入っている。octokit は `src/adapters/` に閉じており、
Agent SDK は `src/cli.ts` が `query` を注入する1点だけが外に出る。

§3.6 が触れている `ent watch` はまだ無い。常駐しない形（cron から `run` を叩く）だけを
用意してあり、`watch` を足すかどうかは実際に cron で回してから決める。

`node:sqlite` は標準とはいえ better-sqlite3 ほど枯れていない。API が変わった場合の
移行先は better-sqlite3 で、`Store` インターフェースの内側に閉じているので
実装だけ差し替えれば済む。なお `node:sqlite` は Node 22.5 から入り、22.13 までは
フラグが要る。`package.json` の `engines` は `>=24` にしてある（`>=22` と書いていたころは、
engines のチェックを通ったうえで起動時にクラッシュする範囲があった）。

### タスクランナー

このリポジトリは [`slashkiko/repository-baseline`](https://github.com/slashkiko/repository-baseline)
から作られており、mise + aqua でセキュリティツールを固定する規約を持つ。
Node 側もそれに合わせて mise タスクに寄せた。

```
mise run typecheck / lint / test / verify   アプリケーション側
mise run check                              サプライチェーンと workflow（baseline 由来）
```

---

## 7. 暴走とコストの制御

自律実行させる以上、ここは機能要件と同格に扱う。

以下は記述例。実際の値は Goal ごとに `.goals/*.yaml` で指定する。

```yaml
budget:
  max_actor_runs: 20              # 1 Goal あたりの Claude Code 起動回数
  max_reconciles: 50
  max_wall_clock: 6h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 5     # 観測が変わらないまま回した回数の上限（§10-2）
  usd: 20                         # 任意。API キー経由の実行にのみ適用
```

Claude Max（OAuth）経由の実行は課金が発生しないので `usd` の対象外だが、
**トークン使用量は必ず記録する**。Actor の実行は `Run.tokens`、Run を作らない
DECIDE の LLM 呼び出しは `LlmCall.tokens` に残す（§4.5）。あとから単価をかければ
「従量課金だったらいくらだったか」を出せる。Messages API に切り出したときはそのまま
実費計算へ移行できるし、L5 でコスト効率を評価する材料にもなる。

その他の制御。

- **LLM は「いつまで寝るか」も決めない。** 行動の種類だけを閉じても、`WAIT` の
  `resume_after` に遠い未来を返されれば Goal を無期限に止められる。LLM が返した
  `resume_after` は採らない。埋めてよいのは、使用量上限のリセット時刻を Port から
  受け取ったときだけになる（§10-3 / §10-5）
- 経過時間の上限は、`activated_at` を解釈できなければ「上限に到達した」側に倒す。
  0 秒として扱うと NaN との比較が常に false になり、`max_wall_clock` だけが
  黙って無効化される。停止条件が消えるより人間を呼ぶほうがよい
- 同一 Task の再試行上限。達したら別 Actor か Replan、それも尽きたら ESCALATE
- 観測が N 回連続で変わらなければ ESCALATE（ループ検知）。N は `budget.max_unchanged_reconciles`。
  判定の材料は Gap ではなく `Decision.observed_digest`（§10-2）
- 人間承認を必須にする操作: main への直接 push、force push、merge、デプロイ、
  シークレット操作、外部への送信
- 自己ホスト時の追加: `policies.protected_paths` に挙げたパスへの変更、worktree 隔離の強制

`protected_paths` に何を並べるかは、**「Agent がそこを書き換えたら他の統制を全部外せるか」**
で決める。制御ループ本体（`src/controller/**`）と Goal の宣言部（`.goals/**`）だけでは足りない。

- 関門そのもの（`src/domain/protected-paths.ts`）と、Agent の許可・拒否ツールを決める
  ファイル（`src/adapters/claude.ts`）。ここが開いていると、照合を常に false にするか
  拒否リストを空にするだけで残りが全部外れる
- 検証系（`mise.toml` / `mise-tasks/**` / `vitest.config.ts` / `biome.json` /
  `tsconfig*.json` / `.github/**`）。VERIFY は worktree で criteria のコマンドを
  流すので（§10-9）、ここを書き換えられると Agent が自分の Acceptance Criteria を
  通せる。そのとき生まれる Fact は VERIFIED になり、§3.1 の
  「外部から検証可能な一次情報のみ」が成立しなくなる
- 依存（`package.json` / `pnpm-lock.yaml`）。理由は検証系とは別で、
  サプライチェーンの判断を Agent に委ねないため。このリポジトリは baseline が
  依存を固定する規約を持っており（mise の `minimum_release_age`、pinact、renovate）、
  そこだけ Agent が素通りできる形にはしない
- `tests/**` は入れない。criteria を「確かめる仕組み」と「確かめる中身」は別で、
  後者まで凍らせると新しいテストを1本足すたびに ESCALATE する
- `src/**` 全体も入れない。Agent が実装するのはまさにそこで、丸ごと保護すると
  このツールが仕事をできなくなる

**トークンは Agent に渡さない。** Bash を許している以上、`printenv` も
`echo $GITHUB_TOKEN` も実行できる。どちらも `secret_access` の拒否パターン
（`gh secret` / `gh auth token`）に一致しないので、拒否リストでは塞げない。
Agent SDK の `env` は「マージではなく置き換え」なので、`process.env` から
`GITHUB_TOKEN` / `GH_TOKEN` を落として渡す。push と PR は controller だけが行うので、
Actor 側にトークンが要る場面はそもそも無い。

**git を argv 配列で叩く。** 外部コマンドをテンプレート文字列で組み立てると、
引数のどれか1つでも controller の制御下に無ければシェルインジェクションになる。
`gitBranch.push` はブランチ名を worktree から読むが、worktree の中身は Actor が
書き換えられ、git は `;` や `$()` をブランチ名に許す。Actor が
`evil;touch${IFS}PWNED` という名前のブランチを1本作るだけで、controller の
プロセス上で任意コマンドが走った。ファイルを1つも書かないので、保護パスの検査にも
`Run.artifacts` にも `disallowedTools` にもかからない。
シェルを通してよいのは Goal YAML の `setup` と `verification.run` だけにする。
この2つは「任意のシェルコマンドを流す」ことが宣言された機能なので、
シェルであること自体が仕様にあたる。

---

## 8. Phase 計画

各フェーズは「前のフェーズを自分で使って作る」構造になっている。
Goal YAML の実用性は、机上ではなく自分で使うことでしか検証できない。

各行はそのフェーズを**完了した時点**の累積範囲を示す。数えているのは
controller が回す段階であって、コードの有無ではない。Phase 0 で `observe()` は
書かれるが、呼ぶのは人間なので Phase 0 行は「なし」になる。

| Phase | controller が回す範囲（累積） | 人間が担う | 検証されること |
|---|---|---|---|
| 0 | なし | 全段階 | Goal YAML のフォーマットが書けるか、Acceptance Criteria が検証コマンドに落ちるか |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT と、全段階の起動 | 検証の自動化が実用に耐えるか |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | Goal を書く、承認する | reconcile ループが収束するか |
| 3 | Phase 2 と同じ範囲（対象がこのリポジトリ自身） | Goal を書く、承認する | MVP 完了 |

### Phase 0 のやり方

controller の実装は1行も要らない。型・スタブ・テストは Phase 0 の出発点として用意済み。

1. `.goals/observe-returns-facts.yaml` を手で書く
2. Acceptance Criteria を実際の Vitest として書く。この時点でテストは全部落ちる
3. Claude Code を起動して YAML を丸ごと渡し、実装させる
4. 検証コマンドを回す。落ちたら結果を Claude Code に戻す
5. 全部通ったら Goal を完了にする

3〜4 のループが、そのまま ACT → VERIFY → OBSERVE の手動版になる。

CLI（`ent` コマンド）の実装は Phase 2 で入る。Phase 0 と Phase 1 では `mise run` を直接叩く。

### Phase 1 のやり方

Phase 0 と同じ手順を、Goal `.goals/automate-observe-and-verify.yaml` に対して回す。
違いは、Phase 0 の成果である Goal YAML スキーマ（`src/domain/goal.ts`）を使って
Goal を書いている点と、その Goal が OBSERVE の取りこぼし記録と VERIFY 自身を作る点にある。

Phase 1 が完了すると、Acceptance Criteria の検証は人間がコマンドを打つ代わりに
`verify()` が回す。reconcile ループはまだ無いので、人間に残るのは
ASSESS / DECIDE / ACT と、全段階の起動になる。

### Phase 2 は Goal 4本に割る

Phase 2 の範囲は ASSESS / DECIDE / ACT と永続化と CLI、および GitHub と Actor に繋ぐ
Port の実装で、1つの Goal には大きすぎる。
Phase で数えるのは controller が回す段階だが、Goal で数えるのは1回の
「宣言 → 実装 → 検証」で閉じる単位なので、粒度が合わない。

| 順 | Goal | 範囲 | 状態 |
|---|---|---|---|
| 1 | `.goals/assess-and-decide.yaml` | Fact から Gap を出し、次の行動を決める。Port 注入の純ロジック | 完了 |
| 2 | `.goals/run-actor-in-worktree.yaml` | ACT。Claude Code の headless 実行、worktree 隔離 | 完了 |
| 3 | `.goals/persist-and-resume.yaml` | 永続化。SQLite、write-ahead、lease、状態機械、CLI | 完了 |
| 4 | `.goals/connect-github-and-claude.yaml` | Port の実装。`@octokit/rest`（GitHub の read）、Claude Agent SDK（Actor と LLM） | 完了 |

この順にしたのは、Phase 2 で検証したいのが「reconcile ループが収束するか」だから。
収束を判定するには、まず同じ入力から同じ Decision が出る必要がある。1本目はそこまでを担う。
ACT と永続化は収束の判定そのものには要らない。

4本目は当初 Phase 2 の範囲に数えていなかった。Port を注入する設計にした結果、
controller 側は Port が無くても最後まで書けてしまい、3本目の時点で
「コードは揃っているが実環境には繋がっていない」状態になったため分けてある。
未実装の Port は呼ばれたら throw する形にしてあり、`unobserved` / `unverified` と
`ESCALATE` として状態に残った。捏造した観測を返さないので、繋いだ時点との差分が読めた。

**これで Phase 2 は完了した。** controller が OBSERVE / ASSESS / DECIDE / ACT / VERIFY を
実際の GitHub と Claude Code に対して回すようになった。ただし §9 の完了条件のうち
この時点で確認できたと考えていたのは9項目中4つで、残りは Phase 3 で埋めることにした。
この4つのうち「実装」は実 Actor を起動していなかったため成立しておらず、
Phase 3 で取り直している。

1本目を終えて分かったのは、reconcile を「決める」までで純粋に保てることだった。
ACT の実行と write-ahead は reconcile の外側に置ける。reconcile が Port の注入だけで動くので、
収束のテストが実際の Claude Code も DB も使わずに書ける。ここでの reconcile は
`src/reconcile/` の決定コアを指す。lease の取得と write-ahead（§3.6）はその外側のシェルが持つ。

3本目で分かったのは、**時刻をどの層が作るかを決めておく必要がある**ことだった。
Store が `new Date()` を呼ぶと、`now` を注入されて動く `tick()` と時間軸が分かれる。
実際、経過時間が数時間ずれて予算超過と判定された。Store は時刻を作らず引数で受け取る。
lease の期限判定だけを実時計の例外にしていたが、そこも引数で受け取る形に揃えた。
例外を1つ残すと、その1つだけテストから再現できない（実際、期限切れの lease を奪う経路が
そうなっていた）。実運用では `deps.now()` が実時計を返すので、挙動は変わらない。

4本目で分かったのは、**外部 SDK の挙動は型定義からもドキュメントからも決まらない**
ことだった。使用量上限の判別（§10-3）は型 → ドキュメント → issue → 実装の順に読んで初めて確定した。
あわせて、ドキュメントだけで書いた段階のコードには3つの誤りが残っていた。
拒否ルールのパターン形式、`permissionMode` の選び方、そして「サブスクリプションの上限」と
「一時的な 429」が同じ値で区別できないこと。いずれも実際に Agent を起動するまで
表面化しない種類の誤りで、Port を足すときは実装まで読みに行く。

### Phase 3 は Goal 5本に割った

Phase 3 の範囲は §9 の残り5項目と、取り直した「実装」、および §7 の自己ホスト用の
制約で、Phase 2 と同じく1つの Goal には大きすぎる。

| 順 | Goal | 範囲 | 状態 |
|---|---|---|---|
| 1 | `.goals/record-the-tick.yaml` | 1ティックの記録。観測対象の指定、LlmPort の生ログとトークン、Verification、`ent show` | 完了 |
| 2 | `.goals/open-pr-and-detect-approval.yaml` | PR の作成と通知、`ApprovalPort`（§10-4） | 完了 |
| 3 | `.goals/sleep-and-stop.yaml` | `resume_after` を読む（§10-5）、ループ検知（§10-2）、中断と使用量上限の実測 | 完了 |
| 4 | `.goals/guard-the-controller.yaml` | 自己ホストの安全装置。`protected_paths`（§10-8）と controller 側の関門（§10-6） | 完了 |
| 5 | `.goals/list-goals.yaml` | 自己ホストで1周。**controller に実装させた** | 完了 |

1本目で分かったのは、**実際に回すまで配管は繋がっていると見なせない**ということだった。
`Store.setObserveTarget()` に本番の呼び出し元が無く、`github.*` を1つも観測して
いなかった。テストは Port を注入するので、この種の断線を通してしまう。

3本目で分かったのは、その一般形だった。`git branch --list --format=%(refname:short)` を
シェル経由で流していたため括弧が解釈され、**worktree の作成が Phase 2 からずっと
失敗していた**。ACT はどのティックでも起動していなかった。§9 の「実装」に付いていた
チェックは、実 Actor を起動して初めて成立した。

5本目で分かったのは、**VERIFY が worktree ではなく controller 自身のリポジトリを
見ていた**ことだった。Actor は worktree の中で実装するのに、`mise run test` は
`repoRoot` で走る。criteria が確かめるのは「その変更」であって controller が
動いているコードではない。worktree 隔離が実際に効くようになって初めて表面化した。

あわせて、`publish` が PR の存在を見て push を止めていたため、2ティック目以降の
Actor の commit が remote に届いていなかった。この誤りは2本目で書いたテストが
仕様として固定しており、テストが緑でも壊れていた。

4つ目の断線は Phase 3 の後で見つかり、`.goals/commit-what-the-actor-wrote.yaml`
として1本立てた。**Actor が worktree に実装を書き切ったまま commit していなかった。**
push は commit 済みの差分しか送らないので remote には何も出ないのに、VERIFY は
worktree の作業ツリーを見るので criteria は全部 passed になる。controller からは
「ローカルは通っているのに PR だけが古い」に見え、`WAIT(review_pending)` で
止まった。前の3つは controller の実装の誤りだったが、これは違う。push も VERIFY も
DECIDE も契約どおりに動いていて、**「Actor が commit する」という前提を誰も
要求していなかった**ことが原因になる。いまは「機械側にやることは残っていない」と
言い切るティック（`COMPLETE` と `WAIT`）で、**今ティックの観測が worktree を見て
作った** `local.dirty` を読み、それが VERIFIED で汚れていれば
`ESCALATE(uncommitted_changes)` にする（§10-11）。確かめられなかったティックは
違反にしない。

### 自己ホストには制約が要る

自分自身を書き換えさせる以上、暴走すれば被害は自分に返ってくる。

- worktree 隔離を必ず使う。controller 本体を動かしているコードと Agent が編集するコードを
  物理的に分ける
- 制御ループ自体を Agent に書き換えさせない。対象は `src/controller/**` と `.goals/**`
  だけでは足りず、関門そのものと検証系まで含める（選び方は §7）
- controller が持つ資格情報を Agent に渡さず、外部コマンドを argv 配列で叩く（同じく §7）

1つ目は `policies.protected_paths` として宣言し、controller が ACT の外側で
worktree の変更を検査する。Agent 側の `disallowedTools` は残したまま二重にする。
片方は Agent の設定、もう片方は controller の判定で、破れ方が違う。

実際に「`src/controller/index.ts` にコメントを1行足す」と指示したところ、Agent は
worktree 内でそれを実行し、controller が検知して `WAITING_HUMAN` で止めた。
**Agent 側の設定だけでは止まらない**ことが実地で確認できた。

ただしこの時点の検査は `Run.artifacts` を読んでいて、Bash 経由の書き込みを
1件も見ていなかった。いまは git が観測した変更を主にする（§10-6）。
**「Agent が書いた」ことの根拠を Agent 自身の申告に置かない。**
その git も、当初は worktree の中でしか回していなかった。隔離は「どこに置くか」の話で
しかなく、「何を観測できるか」の境界とは別に引く必要がある。

---

## 9. MVP 完了条件

Goal の記述と承認を除いて、以下を人手の介入なしで確認できたら MVP 完了とする。
9項目は1本の通し実行ではなく、複数の Goal にまたがって確認した。
**9項目すべての確認が済んだ。MVP は完了している。**
Phase 2 で付けた4項目のうち「実装」は成立していなかったので、worktree 隔離を直したうえで
Phase 3 で取り直した（§8）。
自己ホストが通れば他の GitHub リポジトリでも通るが、逆は言えない。

**9項目は「controller が最後まで回るか」だけを問う。** 「Agent が制御ループを
書き換えられないか」「承認を偽装できないか」は1項目も入っていない。完了後に
レビューを1周かけ、そこで見つかった穴は §7・§10-4・§10-6 に反映した。
自律実行させる以上、収束の確認と統制の確認は別に立てる必要がある。
完了条件そのものを増やすかどうかは、他のリポジトリで回すときに決める。

- [x] **Goal の登録** — このツール自身への機能追加を `.goals/*.yaml` に書き、Zod 検証を通して `ent start` で ACTIVE になる
- [x] **実装** — reconcile ループが Claude Code を worktree 上で起動し、実装が行われる
- [x] **検証** — 検証コマンドが通り、Fact が VERIFIED で記録される
- [x] **PR と通知** — PR が作られ、進捗が PR コメントに書かれる
- [x] **完了判定** — 人間の承認を検知し（signal は §10-4）、全 criteria の `Verification.result` が `passed` になって COMPLETED へ遷移する。`unverified` が空でないうちは COMPLETED にしない
- [x] **取りこぼしが見える** — Port を人工的に落とし、観測できなかった対象が `unobserved` に残ること、ASSESS がそれを「対象なし」と読まないことを確認する
- [x] **いつでも殺せる** — Actor 実行中に `SIGTERM` を送って即座に終了し、再度 `ent run <slug>` を叩くと中断した Task を回収して続きから進む
- [x] **上限で寝て起きる** — 使用量上限を人工的に起こし、`WAITING_EXTERNAL(usage_limit)` でプロセスが終了すること、次ティックで自動再開することを確認する
- [x] **暴走しない** — 予算・reconcile 回数・ループ検知のいずれかが働くケースを人工的に作り、ESCALATE することを確認する

### 確認の仕方に幅がある

同じ「確認した」でも、実地の度合いが違う。あとから読む人が誤解しないように分けておく。

| 度合い | 項目 |
|---|---|
| 実物をそのまま通した | Goal の登録、実装、検証、PR と通知、完了判定 |
| 条件を人工的に作った | 取りこぼしが見える（Port を落とした）、暴走しない（同じ観測を続けた） |
| Port の1つを差し替えた | いつでも殺せる（LlmPort を固定）、上限で寝て起きる（`query()` を差し替え） |

「上限で寝て起きる」は Agent SDK が上限時に流すメッセージを再現したもので、
本物の使用量上限に当たったわけではない。store・controller・状態機械・`PortError` の
判定はすべて本物を通している。

「完了判定」を実物に数えているのは、`.goals/open-pr-and-detect-approval.yaml` で
`/ent approve ac-6` を人間が書き、guard が `COMPLETE` を選んで `COMPLETED` へ遷移する
ところまで通したため。下の実測は別の Goal のもので、承認前の承認待ちで止まっている。

### 通しで1周したときの実測

`.goals/list-goals.yaml` を controller に実装させたときの記録。

```
tick 1  ACT   Actor が worktree で実装        1,341,349 tokens
tick 2  ACT   再試行                            462,017 tokens
tick 3  ACT   再試行、worktree に commit         446,598 tokens
tick 4  WAIT(review_pending) → WAITING_HUMAN
```

controller が PR を自分で立て、進捗コメントを3件積み、承認待ちで止まった。
人間がやったのは Goal YAML と Acceptance Criteria を書き、`ent start` してから
`ent run` を繰り返しただけになる。

1ティック目のトークンが突出しているのは、Actor がコードベース全体を読むため。
大半はキャッシュ読み出しで、`Run.tokens` は4種類（input / cache_creation /
cache_read / output）の合計を持つ。単価が違うので、合計1つから正確な金額は出ない。

---

## 10. 未決事項

MVP を止める未確定は残っていない。ただし、他のリポジトリで回す前に決める必要があるものが
2つある（8 の Goal YAML の移行方針と、9 の検証コマンドの実行権限）。
以下は実運用で必要になった順に埋める。

1. ~~**Goal YAML のスキーマ詳細**~~ — Phase 0 を1周して確定した。`src/domain/goal.ts` を参照。
   Phase 0 版からの差分は、`repository` と `setup` を足し、`verification` を
   `command` の1形式から `command` / `fact` / `human` の3形式に広げ、
   `adapters` / `goal.status` / `goal.source` を削ったこと。
   `context.references` は `title` / `path` のみを許し、URL は受け付けない
2. **上限値の初期チューニング** — `max_actor_runs` などの値は仮置きのまま。
   ~~ループ検知の N が無い~~ — Phase 3 の3本目で `budget.max_unchanged_reconciles` を
   足して確定した。材料は前ティックの Gap ではなく `Decision.observed_digest` にしてある。
   2ティック続けて完全に一致することを実測しており、Gap を別に永続化しなくてよい。
   今ティックの digest が直近の連続と違えば数え直す。「3回同じだったが今回は変わった」を
   空回りと読むと、進んだ直後に止めてしまう。
   判定順は `budget_exhausted` → `COMPLETE` → `WAIT` → `loop_detected`。
   人間の承認を待つあいだも観測は変わらないので、Gap が無い場合より後に置く
3. ~~**使用量上限の検出方法**~~ — Phase 2 の4本目で確定した。Agent SDK の
   `rate_limit_event` が持つ `rate_limit_info.status` が `rejected` なら上限で、
   応答ヘッダ `anthropic-ratelimit-unified-status` から作られる。`resetsAt` は
   **秒**（実装が `Date.now()/1000` と引き算している）。`assistant` メッセージの
   `error: "rate_limit"` は上限と一時的な 429 の両方に付くので、単体では根拠にならず、
   直前に `rejected` を見ているかで判断する。Port は `PortError("usage_limit")` を投げ、
   DECIDE の guard が `WAIT(usage_limit, resumeAfter)` を返す。
   なおこれらはドキュメントに記載が無く、根拠は Claude Code の実装読解にある。
   SDK が変われば黙って壊れるので、Port を触るときに読み直す
4. ~~**人間の承認をどの signal で検知するか**~~ — Phase 3 の2本目で確定し、
   MVP レビューで**認可**を足した。誰が書いたかを見ていなかったので、公開リポジトリでは
   通りすがりの1行で `type: human` の criterion が VERIFIED になった。
   §9 の完了判定は人間の承認を根拠にしているので、ここが開いていると完了判定が成立しない。
   どちらの経路も `author_association` が `OWNER` / `MEMBER` / `COLLABORATOR` のときだけ
   承認として数える。`CONTRIBUTOR`（過去にマージされた PR がある）は書き込み権限とは
   別物なので含めない。関係が読めなければ承認しない側に倒す。
   変更要求のほうは権限を問わず止める側に数える。承認を厳しくするのと拒否を厳しくするのは
   別の話で、倒す向きが逆になる。
   あわせて、**controller 自身の進捗コメントを承認として読まない**。`rationale` には
   LLM が決めた `intent` がそのまま載るので、そこに定型文を書かせれば controller の
   トークンで投稿されたコメントの中に承認の1行が成立する。Agent に `gh pr comment` を
   禁じて塞いだ経路を controller が迂回する形だった。進捗コメントには HTML コメントの
   目印を入れて除外し、`rationale` の改行も潰して二重にする。
   以下は signal そのものの定義で、Phase 3 の2本目から変わっていない。
   signal は2つあり、どちらか一方でも成立すれば承認とみなす。
   GitHub のレビュー承認（他人が Approve を押す。仕事で使うときの本来の経路）と、
   PR コメントの定型文 `/ent approve <criterion-id>`。§4.3 が言うのは
   「`review_decision` *だけ* には頼れない」で、経路そのものが誤りではない。
   **1人で開発しているあいだ成立しないのはレビュー承認の側だけで、コメントの定型文は
   1人でも成立する。** レビュー承認は作成者自身の Approve を数えない（GitHub 自体も
   自分の PR の Approve を許さない）が、コメントの側は作成者を除外していない。
   `GITHUB_TOKEN` は開発者自身のトークンなので、そこで作成者を除いてしまうと
   `/ent approve` の経路そのものが消える。自分のリポジトリなら
   `author_association` は `OWNER` になるので、そのまま承認として数える。
   レビュー承認は PR 全体に対するものなので `type: human` の criteria すべてを満たす。
   作成者自身の Approve は数えない。変更要求が最新として残っていれば、どちらの経路でも
   承認しない。定型文は行全体で照合する。引用やコード例の中の同じ文字列を承認と読むと、
   捏造した承認が作れてしまう
5. ~~**`resume_after` を誰が読むか**~~ — Phase 3 の3本目で確定した。`tick` が入口で
   判定し、過ぎるまで何もせずに return する。lease も取らない。取ると、寝ているだけの
   Goal が他のワーカーを塞ぐ。解釈できない値は「起きてよい」と読む。壊れた値のせいで
   Goal が永久に止まる方が、1ティック早く起きるより悪い
6. ~~**`require_human_approval` を誰が止めるか**~~ — Phase 3 の4本目で確定し、
   MVP レビューで**検査の入力**を入れ替えた。
   controller が ACT の外側で検査し、worktree の外に出た編集と保護パスへの編集を
   見つけたら `ESCALATE(protected_path_touched)` にする。Agent 側の `disallowedTools` は
   残して二重にする（理由は §8 の自己ホスト節）。
   当初の検査対象は `Run.artifacts`（Edit / Write / NotebookEdit が触ったパス）だけだった。
   Bash の `tool_use` は `file_path` を持たないので、`echo >` や `sed -i` で書いたファイルは
   **原理的に artifacts へ現れない**。「Bash 経由なら外にも書ける」ことを
   前提に置きながら、それを原理的に捕捉できないデータ源の上に検査を建てていた。
   いまは **git が観測した変更**（`status --porcelain -uall` と base からの
   `diff --name-only`）を主にする。自己申告ではなく「書けた結果」を見るのが、
   Bash を許したまま取れる唯一の検査点になる。
   **worktree の外も git で見る。** worktree の中で git を回しても、
   `git worktree add` で分けた本体側の作業ツリーは観測できない。`Run.artifacts` も
   Bash を拾わないので、`bash -c 'echo > ../../src/controller/index.ts'` は
   どちらの入力にも現れなかった。隔離が守るはずの当のファイルが、隔離の検査から
   漏れていたことになる。本体リポジトリ側でも `status --porcelain -uall` を回し、
   絶対パスで返して `escaped_worktree` に落とす。
   本体側は ACT の前後の差だけを違反として数える。自己ホストでは人間の編集中の
   ファイルが最初から汚れているので、それを違反にすると関門が毎ティック鳴る。
   比較はパスの集合ではなく**中身の指紋**で行う。パス名だけで比べていると、人間が
   編集中のファイルを Actor が上書きしたときに前後で同じパスが並び、差が消える。
   Actor は `git -C ../.. status` で汚れているファイルを読めるので、
   パス名だけで比べていれば、どこを上書きすれば検知されないかを Actor が選べた。
   **commit 済みの差分は、base が解決できなければ握り潰さず throw する。**
   以前は `catch {}` で「変更なし」に畳んでいたが、Actor は
   `git update-ref -d refs/heads/main` を実行できた。違反を commit してから
   base の ref を消せば、未 commit の変更は無く diff は fatal になり、
   検査は空を返す。`origin/main` は残るので push だけ通り、違反が通常の変更として
   PR に流れた。ローカルの base が無ければ `origin/<base>` に落とし、
   どちらも解決できなければ `guard_unavailable` に倒す。
   あわせて、ref を操作する Bash 呼び出し（`git update-ref` / `git symbolic-ref` /
   `git branch -d|-D|--delete` / `git worktree`）は Goal の設定によらず常に拒否する。
   検査の入力そのものを Actor に選ばせない。`git worktree` は読み取りの `list` ごと
   拒否する。サブコマンドを列挙する形だと、書ける形を1つ書き落とした時点で穴になる。
   違反の種別（`escaped_worktree` / `protected_path`）と ESCALATE の理由は別の層で、
   種別がどちらでも理由は `protected_path_touched` になる。
   検査できなかったら `ESCALATE(guard_unavailable)`。「触っていない」と
   「確かめられなかった」を混ぜない（§3.1）。関門が動いていない状態で先へ進めるのは、
   関門が無いのと同じになる。
   **検査はティックごとに行う。** 違反した編集は worktree に残す（人間が判断できるように）
   ので、そのティックの Run だけを見ていると、次のティックが保護パスに触れずに終わった
   時点で汚れた worktree ごと push される。違反は1ティックの出来事ではなく、
   worktree が汚れているあいだ続く状態として扱う。
   照合はシンボリックリンクを実体へ解決してから行い、大文字小文字は区別しない。
   macOS も Windows も既定でパスの大小を区別しないので、`src/Controller/index.ts` と
   書けば同じファイルに届くのに glob には一致しない、という抜け道ができる。
   **関門が止めたティックは push も PR 作成も行わない。** 違反を含む worktree が
   remote に出た時点で、通常の変更として流れる余地が生まれる。
   そのうえで、**PR が既にあるなら、観測が前ティックと同じでもコメントを書く。**
   ダイジェストは Fact だけから作るので Decision を含まない。Actor が worktree の
   外だけを書いたティックは観測が1文字も変わらないので、黙って飛ばすと隔離が
   破れたことが PR に一度も出ないまま `WAITING_HUMAN` になる。
   PR がまだ無いうちに違反したティックでは、PR を作らないので通知も残らない。
   その場合に人間へ届くのは `ent get` と Decision の履歴だけになる。
   **残る穴を5つ書いておく。**
   (a) repoRoot の外（`~/.zshrc` や `~/.claude/**`）は git で観測できないので見えない。
   (b) gitignore されたパスも見えない。`--ignored` を付ければ出るが、
   controller 自身が `.goals/.state/**` に毎ティック書くので、自分の書き込みが
   毎回違反として並ぶ。DB を直接書き換えられる経路がここに残る。
   (c) 本体側の違反は、同じファイルが次のティックまで**そのまま**なら、
   その内容がベースラインに入るので鳴り止む。指紋で比べているので、同じファイルを
   もう一度書き換えれば再び鳴る。鳴り止むのは「1回の改変を放置した場合」に限る。
   それでも、止まった Goal を人間が掃除しないまま回し続ければ、改変された
   controller のソースはディスクに残る。
   (d) ACT 中に人間が repoRoot を編集すると差分に載り、`protected_path_touched`
   として止まる。安全側だが誤検知になる。
   (e) 本体側は未 commit の汚れしか見ない。worktree 側は commit 済みの差分まで
   追うが、本体側のブランチは controller が動かさないので `status` だけにしてある。
   `git -C ../.. commit` や `git -C ../.. stash` は拒否リストに無いので、
   本体側で書いてから commit されると、汚れの集合から消えて検査の外に出る。
   (c) と (d) は逆向きのトレードオフで、どちらも検知を永続化するか
   Actor プロセスと編集を紐付けないと同時には解けない。MVP では両方残す
7. **Notion / Slack を足す時期** — 実環境ができてから
8. ~~**`require_human_approval` にパス条件をどう載せるか**~~ — Phase 3 の4本目で確定した。
   enum には載せず、`policies.protected_paths`（glob の配列）を別に持つ。
   enum の6値は「操作の種類」で、パスは「対象」なので軸が違う。1つの enum に混ぜると
   controller 側の照合が分岐だらけになる。
   **Goal YAML のスキーマ変更の移行方針は未決のまま。** Phase 3 で2回
   （`budget.max_unchanged_reconciles` と `policies.protected_paths`）変更し、
   どちらも既存 YAML 8〜9本を手で書き直した。`version: 1` は literal で固定したままで、
   Goal が増えたときに同じやり方は続けられない。
   **同じ問題は宣言の値にもある。** レビューで `protected_paths` を広げたとき、
   書き直したのは自己ホストで実際に回す2本だけで、完了済みの9本は `[]` のまま残した。
   再実行しない Goal に手を入れても差分が増えるだけだが、「どの Goal がどこまで
   守られているか」は YAML を1本ずつ読まないと分からない。既定値をどこに置くかは
   まだ決めていない
9. **VERIFY をどこで流すか** — Phase 3 の5本目で `repoRoot` から Goal 専用の worktree に
   変えたが、規則が「worktree があればそちら」という暗黙のものになっている。
   Goal YAML から指定できる方がよいかは決めていない。1ティック目は worktree が
   無いので `repoRoot` を見る、という非対称も残る。
   **より大きな未決は、検証コマンドを controller の権限で実行していること。**
   worktree で `mise run test` を流すということは、worktree の `mise.toml` が
   何を実行するかを決める、ということでもある。検証系を `protected_paths` に入れて
   （§7）Agent に書き換えさせないようにしたが、これは「書き換えを検知して止める」
   統制であって、実行そのものの隔離ではない。本筋はネットワーク遮断・トークン非注入の
   サンドボックスで流すことで、MVP の範囲には入れていない
10. **トークンから金額をどう出すか** — 記録しているのは4種類の合計だけで、正確な
    金額は出ない（§9 の実測を参照）。内訳は生ログにあるので、§7 の「従量課金だったら
    いくらだったか」を出すには、そこから読む口が要る
11. ~~**「Actor が commit する」という前提を誰が確かめるか**~~ — 確定した。
    controller が ACT の外側で確かめ、**未 commit の変更が残っていることを確かめたら**
    `ESCALATE(uncommitted_changes)` にする。確かめられなかったティックは違反にしない
    （下の「材料」を参照。§10-6 の `guard_unavailable` とは倒す向きが逆になる。
    あちらは関門そのものが動かなかったので止める側に倒すが、こちらは
    材料が欠けたティックでは criteria も揃わず、止めるべき `COMPLETE` に届かない）。
    push が送るのは commit 済みの差分だけ（`git push -u origin HEAD:<branch>`）なのに、
    VERIFY は worktree の**作業ツリー**を見る。Actor が実装を書いたまま commit しないと、
    ローカルの criteria は全部 passed になるのに remote には何も出ない。controller からは
    「ローカルは通っているのに PR だけが古い」に見え、`WAIT(review_pending)` を選んで
    `WAITING_HUMAN` で止まった。人間が待っているのは実装が載った PR なので、
    この待ちは永久に終わらない。実際に踏んだ経路になる。
    **これまでの断線と壊れ方が違う。** push も VERIFY も DECIDE も契約どおりに
    動いていて、誰も誤った動きをしていない。足りなかったのは「Actor が commit する」
    という前提をどこも要求していないことで、前提が満たされたかを確かめないまま
    満たされていることにして先へ進む形になっていた。§3.1 が Fact について避けたかった
    構図が、Fact ではなく前提の側で起きたことになる。
    **関門を置くのは「機械側にやることは残っていない」と言い切るティックに限る。**
    その形は `COMPLETE` と `WAIT` の2つで、前者は終端であとから取り消せず（§4.4）、
    後者は次のティックまで機械側が何もしない。どちらのティックでも、worktree に
    未 commit の変更が残っていてはいけない。差し替えないのは `WAIT(usage_limit)` だけで、
    あれは判断そのものを保留しただけなので、待てば続きがある（§10-5）。
    **材料は既にあった `local.dirty` を読む。** 観測を足していない。VERIFY と同じく
    Goal 専用の worktree を見ており（§10-9 の `verifyRoot`）、VERIFIED な Fact として
    毎ティック残っていた。**誰も読んでいなかっただけになる。**
    捏造した違反で人間を呼ぶと、関門そのものが信用されなくなる（§3.1）ので、
    **いつ・どこを観測した値かまで見る。**
    *いつ* — 読むのは今ティックの OBSERVE が作った Fact だけにする。reconcile は
    前ティックの Fact を土台にして今ティックの観測で上書きするので、`LocalRepoPort` が
    落ちたティックには前ティックの `local.dirty` が VERIFIED のまま残る（陳腐化して
    落ちるのは `github.ci.*` だけ）。それを今の観測として読むと、「確かめられなかった」が
    「汚れている」に化ける。そのティックは `WAIT(observation_failed)` のまま進む。
    *どこ* — 同じ観測が作る `local.branch` が worktree のブランチ
    （`worktreeBranchFor`）と一致するときだけ見る。「Run が1件でもあれば worktree を
    観測している」は代理にならない。`act` は `worktree.ensure` より先に Run(starting) を
    書くので、worktree を作れずに失敗した Run が1本あるだけで `verifyRoot` は
    controller 自身のリポジトリに落ちたままになり、人間の編集を Actor の書き残しと読む。
    **逆向きの誤検知を2つ避ける。** 実装の途中で作業ツリーが汚れているのは正常なので、
    Gap が残っているティックは進む。ただし理由は「Gap があれば関門を通らない」では
    **ない**。Gap があるティックは LLM に渡り、LLM は `WAIT` を返せて、その `WAIT` は
    ここで止まる。関門を通らないのは `ACT` / `VERIFY` / `REPLAN` に落ちたティックで、
    どれも「機械側にやることが残っている」と言っているティックになる。
    もう1つは、Actor がまだ1度も走っていない Goal をそもそも見ないこと。1ティック目は
    worktree が無く `local.*` は controller 自身のリポジトリを観測するので（§10-9）、
    自己ホストでは人間の編集で汚れているのが普通になる。
    判定は保護パスの関門（§10-6）と同じく、1ティックの出来事ではなく worktree が
    汚れているあいだ続く状態として扱う。書き残したのは前のティックなので、
    今回の Run ではなく Run の履歴を見る。
    **止めたことを人間に届ける。** 保護パスの関門と同じく、PR が既にあるなら
    観測が前ティックと同じでもコメントを書く。止まっているあいだ観測は1文字も
    変わらないので、初回しか書かないと2ティック目以降は PR が静かなまま
    `max_reconciles` に当たって `BLOCKED` になる。`rationale` には止めた理由だけでなく
    **どうすれば進むか**（worktree のパスと、commit するか元に戻すか）を書く。
    `ent show` の `decision.rationale` と PR の進捗コメントは同じ文字列を出すので、
    ここが人間に届く唯一の説明になる。
    push まで止めるのは保護パスの関門だけで、こちらは止めない。commit された分は
    remote に出てよい。
    **`intent` に commit を含めるのは代わりにならない。** 原因を細くする向きとしては
    正しいが、intent は LLM が生成するので「書いた」ことは確かめられても「従った」ことは
    確かめられない（§3.2）。従わなかったティックは、やはり黙って `WAIT` に落ちる。
    検証に還元できるのは controller 側の検知だけになる。
    **残る穴。** 検知するのは「commit されていない」までで、「commit された内容が
    実装であること」は見ていない。Actor が空の commit を積めば関門は鳴らない。
    そこは CI（`github.ci.conclusion`）と `type: human` の criterion が受け持つ

---

## 参考

調査で参照した既存プロジェクト。

- **L1 近傍**: [humanlayer/agentcontrolplane](https://github.com/humanlayer/agentcontrolplane)、
  [lidangzzz/goal-driven](https://github.com/lidangzzz/goal-driven)、
  [Kubernetes Agent Sandbox](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/)
- **L3（自作しない領域）**: [Emdash](https://github.com/generalaction/emdash)、
  [mission-control](https://github.com/builderz-labs/mission-control)
- **L4（部品として参照）**: [LangChain Open SWE](https://github.com/langchain-ai/open-swe)、
  [Cloudflare Agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)、
  [Amp Event-Driven Orbs](https://ampcode.com/news/event-driven-orbs)
- **L5（研究段階）**: [EvoRoute](https://arxiv.org/pdf/2601.02695)
- **ドキュメント**: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
