# entelecheia 設計ドキュメント

このリポジトリの単一の設計ソース。新しく参加するとき（あるいは新しいセッションを開くとき）は、
まずこれを読めば足りるように書いてある。

最終更新: 2026-08-09

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

ASSESS も DECIDE も Actor 層経由にすれば、依存も認証も1系統で済む。
出力は必ず Zod で検証し、通らなければ受け取らない（最大2回リトライ）。

Agent SDK は Claude Code の OAuth をそのまま使うため Claude Max のサブスクリプション内で動く。
一方、Messages API に切り出した部分だけは API キーの従量課金になる。
定額で回すなら Claude Code 1本に寄せるのが唯一の選択肢。

`LlmPort` を挟んでおき、実測でコストや品質が問題になったら DECIDE だけ差し替える。

### 3.6 待機はプロセスではなく状態にする（中断可能性）

使用量上限やレビュー待ちで controller が常駐して落とせなくなるのは論外。

- reconcile はどのティックも**有限時間で必ず return する**。sleep して常駐しない
- 待ちは `WAITING_*` として DB に書き、プロセスは終了する
- 次のティックは cron か `ent watch` の次周回で来る。
  `ent run --once` を cron から叩く構成なら常駐プロセスがそもそも存在しない

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

**`github.pr.review_decision` を人間の承認の観測源にはできない。** GitHub は自分が作った
PR に Approve を押させないので、controller が Goal の所有者と同じアカウントで PR を作る限り
`reviewDecision` は `APPROVED` にならない。これを `type: human` の判定に使うと reconcile は
`WAIT(review_pending)` から抜けられず、§9 の完了判定に到達できない。
`.goals/assess-and-decide.yaml` の Goal で実際に踏んだ。`ApprovalPort` の実装は
review_decision 以外の signal を使う（§10）。

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

ESCALATE は reconcile が選ぶ行動、BLOCKED は Goal の状態。
ESCALATE の結果として Goal は BLOCKED か WAITING_HUMAN に遷移する。

Claude Max には5時間ローリングの使用量上限と週次上限がある。
何時間も走る controller はいずれ必ず当たるので、クラッシュではなく
`WAITING_EXTERNAL(usage_limit)` に落ちて、リセット時刻まで寝て自動再開する。
リセット時刻が取れなければ指数バックオフ。

### 4.5 データモデル

以下は DB のテーブル定義であり、`src/domain/` の型とは1対1に対応しない。
例えば Fact は実装上 `evidence: { source, detail }` を入れ子で持ち、`observedAt` も持つ。

```
Goal          id, name, desired_state, status, policies, budget,
              lease_owner, lease_until, resume_after
Criteria      goal_id, description, verification_spec, status, approved
StateSnapshot goal_id, observed_at, facts[], unobserved[]
Fact          key, value, confidence, source, evidence
Unresolved    snapshot_id, key, reason, detail   観測できなかった対象
Plan          goal_id, version, created_reason
Task          plan_id, intent, actor_type, status, worktree, attempts, artifacts
Run           task_id, actor, command, exit_code, log_ref, tokens, cost, status
Verification  criteria_id, result, reason, evidence, verified_at
Event         type, source, payload, processed_at
Decision      goal_id, reconcile_seq, observed_digest, chosen_action, rationale
```

**結論が出なかった対象も永続化する。** ここを落とすと §3.1 が避けたかった
「Fact の不在に畳まれる」問題が DB 層で再発し、ASSESS が取りこぼしを読めなくなる。
観測側は `Unresolved` の行として、検証側は `Verification.result` を
`passed` / `failed` / `unresolved` の3値にして持つ（`unresolved` のときだけ `reason` が埋まる）。

`Verification` 行と `criteria.<id>.passed` の Fact は同じ結果の二重表現になるが、
前者が criteria 単位の索引、後者が ASSESS に渡る観測値という役割分担にする。

**`Decision` を必ず残す。** L5 の改善レイヤーは後回しにするが、
そこに食わせる履歴の形式だけは最初から確定させておく。

`Goal` の `lease_owner` / `lease_until` が「1 Goal につき reconcile は同時に1つ」を担保する。
行ロックではなく期限付きの所有権にすることで、プロセスがクラッシュしても自動で解放される。

```sql
UPDATE goals
   SET lease_owner = :worker_id,
       lease_until = :now_plus_5min
 WHERE id = :goal_id
   AND (lease_until IS NULL OR lease_until < :now);
-- 更新行数が 0 なら他のワーカーが処理中。今回のティックはスキップ
```

### 4.6 ファイル配置

```
.goals/<slug>.yaml            人間が編集。Git 管理。宣言部のみ
.goals/.state/goals.db        SQLite。機械のみが書く。gitignore
.goals/.state/runs/<run-id>/  Agent の生ログ・diff。DB にはパスだけ持つ
.goals/.state/worktrees/<slug>/ Actor が編集する作業ツリー
```

人間が編集する宣言部と、機械が書き換える実行時状態を混ぜない。
同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
`ent show <slug>` が両者をマージした1枚を標準出力に吐くので、参照時は1ファイルに見える。

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
   「この event_id は処理済みか」はインデックス付きの参照で解くのが自然

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
  このどちらを承認の signal にするかは未決（§10）

### 入れない

- Notion 連携（読み取り・書き戻しとも。環境ができてから足す）
- Slack 連携（同上）
- Web UI（CLI と生成レポートのみ）
- GitLab / Linear / Jira の Adapter 実装（インターフェースだけ切る）
- 複数 Actor の並列実行（インターフェースは複数対応、実装は逐次1本）
- Codex CLI の実装（`kind` の型だけ用意）
- L5 改善レイヤー（History は貯めるだけ、学習はしない）
- 複数 Goal の同時実行

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
| DB | `node:sqlite`（Node 標準） | 同期 API でコードが素直。Node 22.5 以降の標準で、`mise.toml` が Node 24 を固定しているため常に使える。better-sqlite3 + Drizzle の採用予定を取り下げた（下記） |
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
実装だけ差し替えれば済む。

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
  usd: 20                         # 任意。API キー経由の実行にのみ適用
```

Claude Max（OAuth）経由の実行は課金が発生しないので `usd` の対象外だが、
**トークン使用量は `Run.tokens` に必ず記録する**。あとから単価をかければ
「従量課金だったらいくらだったか」を出せる。Messages API に切り出したときはそのまま
実費計算へ移行できるし、L5 でコスト効率を評価する材料にもなる。

その他の制御。

- 同一 Task の再試行上限。達したら別 Actor か Replan、それも尽きたら ESCALATE
- 同じギャップが N 回連続で解消されなければ ESCALATE（ループ検知）
- 人間承認を必須にする操作: main への直接 push、force push、merge、デプロイ、
  シークレット操作、外部への送信
- 自己ホスト時の追加: `src/controller/**` と `.goals/**` への変更、worktree 隔離の強制

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
実際の GitHub と Claude Code に対して回す。ただし §9 の完了条件のうち確認できたのは
9項目中4つで、残りは Phase 3 で自己ホストしながら埋める。

1本目を終えて分かったのは、reconcile を「決める」までで純粋に保てることだった。
ACT の実行と write-ahead は reconcile の外側に置ける。reconcile が Port の注入だけで動くので、
収束のテストが実際の Claude Code も DB も使わずに書ける。ここでの reconcile は
`src/reconcile/` の決定コアを指す。lease の取得と write-ahead（§3.6）はその外側のシェルが持つ。

3本目で分かったのは、**時刻をどの層が作るかを決めておく必要がある**ことだった。
Store が `new Date()` を呼ぶと、`now` を注入されて動く `tick()` と時間軸が分かれる。
実際、経過時間が数時間ずれて予算超過と判定された。Store は時刻を作らず引数で受け取る。
例外は lease の期限判定で、これはプロセスの生死を測るものなので実時計でよい。

4本目で分かったのは、**外部 SDK の挙動は型定義からもドキュメントからも決まらない**
ことだった。使用量上限の判別（§10-3）は型 → ドキュメント → issue → 実装の順に読んで初めて確定した。
あわせて、ドキュメントだけで書いた段階のコードには3つの誤りが残っていた。
拒否ルールのパターン形式、`permissionMode` の選び方、そして「サブスクリプションの上限」と
「一時的な 429」が同じ値で区別できないこと。いずれも実際に Agent を起動するまで
表面化しない種類の誤りで、Port を足すときは実装まで読みに行く。

### Phase 3 は Goal 5本に割った

Phase 3 の範囲は §9 の残り5項目と §7 の自己ホスト用の制約で、Phase 2 と同じく
1つの Goal には大きすぎる。

| 順 | Goal | 範囲 | 状態 |
|---|---|---|---|
| 1 | `.goals/record-the-tick.yaml` | 1ティックの記録。観測対象の指定、LlmPort の生ログとトークン、Verification、`ent show` | 完了 |
| 2 | `.goals/open-pr-and-detect-approval.yaml` | PR の作成と通知、`ApprovalPort`（§10-4） | 完了 |
| 3 | `.goals/sleep-and-stop.yaml` | `resume_after` を読む（§10-5）、ループ検知（§10-2）、中断と使用量上限の実測 | 完了 |
| 4 | `.goals/guard-the-controller.yaml` | 自己ホストの安全装置。`protected_paths`（§10-8）と controller 側の関門（§10-6） | 完了 |
| 5 | `.goals/list-goals.yaml` | 自己ホストで1周。**controller に実装させた** | 完了 |

1本目で分かったのは、**実際に回すまで配管は繋がっていないと見なすべき**だった。
`Store.setObserveTarget()` に本番の呼び出し元が無く、`github.*` を1つも観測して
いなかった。テストは Port を注入するので、この種の断線を通してしまう。

3本目で分かったのは、その一般形だった。`git branch --list --format=%(refname:short)` を
シェル経由で流していたため括弧が解釈され、**worktree の作成が Phase 2 からずっと
失敗していた**。ACT はどのティックでも起動していない。§9 の「実装」に付いていた
チェックは、実 Actor を起動して初めて成立した。

5本目で分かったのは、**VERIFY が worktree ではなく controller 自身のリポジトリを
見ていた**ことだった。Actor は worktree の中で実装するのに、`mise run test` は
`repoRoot` で走る。criteria が確かめるのは「その変更」であって controller が
動いているコードではない。worktree 隔離が実際に効くようになって初めて表面化した。

あわせて、`publish` が PR の存在を見て push を止めていたため、2ティック目以降の
Actor の commit が remote に届いていなかった。この誤りは2本目で書いたテストが
仕様として固定しており、テストが緑でも壊れていた。

### 自己ホストには制約が要る

自分自身を書き換えさせる以上、暴走すれば被害は自分に返ってくる。

- worktree 隔離を必ず使う。controller 本体を動かしているコードと Agent が編集するコードを
  物理的に分ける
- `src/controller/**` と `.goals/**` への変更は human approval を必須にし、
  制御ループ自体を Agent に書き換えさせない

後者は `policies.protected_paths` として宣言し、controller が ACT の外側で
`Run.artifacts` を検査する。Agent 側の `disallowedTools` は残したまま二重にする。
片方は Agent の設定、もう片方は controller の判定で、破れ方が違う。

実際に「`src/controller/index.ts` にコメントを1行足す」と指示したところ、Agent は
worktree 内でそれを実行し、controller が検知して `WAITING_HUMAN` で止めた。
**Agent 側の設定だけでは止まらない**ことが実地で確認できた。

---

## 9. MVP 完了条件

Goal の記述と承認を除いて、以下を人手の介入なしで1回通せたら MVP 完了とする。
**9項目すべてを Phase 3 で確認した。MVP は完了している。**
自己ホストが通れば他の GitHub リポジトリでも通るが、逆は言えない。

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
| 実物をそのまま通した | Goal の登録、実装、検証、PR と通知、完了判定、暴走しない |
| Port の1つだけ差し替えた | いつでも殺せる（LlmPort を固定）、上限で寝て起きる（`query()` を差し替え） |

「上限で寝て起きる」は Agent SDK が上限時に流すメッセージを再現したもので、
本物の使用量上限に当たったわけではない。store・controller・状態機械・`PortError` の
判定はすべて本物を通している。

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

設計上の大きな未確定は残っていない。以下は Phase を回しながら埋める。

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
   DECIDE が guard として `WAIT(usage_limit, resumeAfter)` を返す。
   なおこれらはドキュメントに記載が無く、根拠は Claude Code の実装読解にある。
   SDK が変われば黙って壊れるので、Port を触るときに読み直す
4. ~~**人間の承認をどの signal で検知するか**~~ — Phase 3 の2本目で確定した。
   signal は2つあり、どちらか一方でも成立すれば承認とみなす。
   GitHub のレビュー承認（他人が Approve を押す。仕事で使うときの本来の経路）と、
   PR コメントの定型文 `/ent approve <criterion-id>`。§4.3 が言うのは
   「`review_decision` *だけ* には頼れない」で、経路そのものが誤りではない。
   1人で開発しているあいだ成立しないだけになる。
   レビュー承認は PR 全体に対するものなので `type: human` の criteria すべてを満たす。
   作成者自身の Approve は数えない。変更要求が最新として残っていれば、どちらの経路でも
   承認しない。定型文は行全体で照合する。引用やコード例の中の同じ文字列を承認と読むと、
   捏造した承認が作れてしまう
5. ~~**`resume_after` を誰が読むか**~~ — Phase 3 の3本目で確定した。`tick` が入口で
   判定し、過ぎるまで何もせずに return する。lease も取らない。取ると、寝ているだけの
   Goal が他のワーカーを塞ぐ。解釈できない値は「起きてよい」と読む。壊れた値のせいで
   Goal が永久に止まる方が、1ティック早く起きるより悪い
6. ~~**`require_human_approval` を誰が止めるか**~~ — Phase 3 の4本目で確定した。
   controller が ACT の外側で `Run.artifacts` を検査し、worktree の外に出た編集と
   保護パスへの編集を見つけたら `ESCALATE(protected_path_touched)` にする。
   Agent 側の `disallowedTools` は残して二重にする。片方は Agent の設定、
   もう片方は controller の判定で、破れ方が違う。ただし検査できるのは
   `Run.artifacts`（Edit / Write / NotebookEdit が触ったパス）だけで、
   Bash 経由の書き込みは artifacts に現れない。**そこは依然として素通りする**
7. **Notion / Slack を足す時期** — 実環境ができてから
8. ~~**`require_human_approval` にパス条件をどう載せるか**~~ — Phase 3 の4本目で確定した。
   enum には載せず、`policies.protected_paths`（glob の配列）を別に持つ。
   enum の6値は「操作の種類」で、パスは「対象」なので軸が違う。1つの enum に混ぜると
   controller 側の照合が分岐だらけになる。
   **Goal YAML のスキーマ変更の移行方針は未決のまま。** Phase 3 で2回
   （`budget.max_unchanged_reconciles` と `policies.protected_paths`）変更し、
   どちらも既存 YAML 8〜9本を手で書き直した。`version: 1` は literal で固定したままで、
   Goal が増えたときに同じやり方は続けられない
9. **VERIFY をどこで流すか** — Phase 3 の5本目で `repoRoot` から Goal 専用の worktree に
   変えたが、規則が「worktree があればそちら」という暗黙のものになっている。
   Goal YAML から指定できる方がよいかは決めていない。1ティック目は worktree が
   無いので `repoRoot` を見る、という非対称も残る
10. **トークンから金額をどう出すか** — `Run.tokens` は4種類の合計で、単価が違う。
    合計1つから正確な金額は出ない。内訳は生ログにあるので、§7 の「従量課金だったら
    いくらだったか」を出すには、そこから読む口が要る

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
