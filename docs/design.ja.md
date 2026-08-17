# entelecheia 設計ドキュメント

このリポジトリの単一の設計ソース。新しく参加するとき（あるいは新しいセッションを開くとき）は、
まずこれを読めば足りるように書いてある。

*[English](design.md) | 日本語*

> [!NOTE]
> **本文中の issue と PR の番号は、移行前のリポジトリを指す。** 履歴を書き換えてここへ移して
> あるので、このリポジトリの issue と PR は0件になる。`issue #58` や `PR #34` のように書いて
> あるものはここでは解決せず、issue が立ち始めれば1から採番されるので、同じ番号がいずれ
> 無関係なものに割り当たる。リンクではなく、移行前の記録に付いた符号として読む。

最終更新: 2026-08-12。この更新で入ったのは次の11件になる。

- **タスク分解の粒度を決めた。** 分解した1本ごとに Goal を立てる方針にして、順序の宣言
  `goal.depends_on` を入れた。分解を機械にやらせる場合の宣言部の書き手も決めた。実装は保留
- **実装と食い違っていた記述を揃え、2つ実装を変えた。** `/ent approve` は
  PR の作成者が書いても承認として数え、その代わり Agent の中の `gh` を未認証にする（§10-4）。
  合成ルートを保護パスの下限に足した（§7）
- **レビュー役にだけ semantic-review の skill を渡した。** 宣言部を goalId で、
  読んだ commit を `reviewed_sha:` で名指しさせる（§4.2・§4.3）
- **commit の主体を Actor から controller に移した**（§10-11）。落ちた検証コマンドの出力を
  evidence に残すようにした（§4.5）
- **Codex CLI Adapterとphase別のprovider・model・effort選択を追加した。** Actorの使用量上限を
  Runからguardの待機判断へ伝播する（§3.5・§4.2）
- **publish を宣言で止める口を足した。** `policies.publish` の `push_branch` /
  `open_pull_request` を `auto` / `manual` で宣言する。止めたことは `ent run` の出力の
  `publishHold` に構造で出す（§7）
- **レビュー役の本文を `--report` の宛先に出すようにした**（§4.3）。`verdict` の1語だけを
  Fact にする経路はそのままで、畳まれていた本文を `## Review role message` の節として
  本文の後ろに足す。PR コメントには出さない
- **状態 DB の観測を、バイト列から Goal ごとの論理ダイジェストへ移した**（§10-6）。射影から
  落とした Run の不変列は `ownRunDrift` が突き合わせる。`depends_on` の Goal の `status` も
  射影に入れた。同一ディレクトリの並列を塞いでいた誤検知は外れたが、実プロセス2本での
  確認は済んでいない（§5）
- **「落ちている job が1つも無い」を criteria に書けるようにした**（§4.3）。
  `github.ci.failed_job_count` は head sha に紐づく全 workflow run を横断して数える。
  恒久的に落ちる workflow は `repository.ci.exclude_workflows` で数から外し、外した分は
  `github.ci.excluded_workflows` に出す（README の「恒久的に落ちる workflow を数から外す」）
- **未解決のレビュースレッドの件数を観測するようにした**（§4.3）。
  `github.pr.unresolved_threads` だけは GraphQL から取る。数え切れなければ Fact を作らず、
  引き継いだ件数は `expireStaleFacts` が条件付きで落とす
- **`changes_requested` を受け取ったティックで `WAIT` に居着かないようにした**（§4.3）。
  レビュー役の結論が読んだ commit のままなら待って変わるものが無いので、DECIDE の
  選択肢から `WAIT` を外す。選択肢を消す側は今ティックの観測（`observedFacts`）だけで判定する

---

## 1. 何を作るのか

プロジェクトの完了状態（Desired State）を宣言すると、現在状態を観測し、
ギャップが埋まるまで Claude Code または Codex を起動する controller。

Kubernetes の controller が `replicas: 3` に収束させるのと同じ構造を、
ソフトウェア開発のタスクに持ち込む。人間が書くのは「どうなってほしいか」だけで、
Goal内のタスク分解、Actor roleの選択、実装手順はcontrollerが決める。
分解が成り立っているのは1つの Goal の内側だけで、Goal をまたぐ分解——1つの粗いタスクを
N 本の Goal に割ること——はいまも人間が行う（順序の宣言 `goal.depends_on` までは入っている。
§10-12）。phaseごとに使うActor実装・model・effortは、起動時の環境変数で人間が既定を選び、
未指定時は既定のClaude Codeへ落ちる。ティックごとの上書きはDECIDEが返すが、
名指しできるのは人間が既に選んだproviderの中だけになる（§3.5 / §4.2）。

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

したがって実装コストは L1 と L2 に集中させ、L3 は Claude Code または Codex の
Actor Adapter へ委譲する。

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
承認用の別 UI は要らない。この前提が効くのは人間が書いているあいだだけで、分解を機械に
やらせる経路（§10-12）を入れると、機械が書いた分にはこのゲートが掛からない。

### 3.3 Adapter は1実装だけ作り、境界だけ先に切る

Notion のページと GitHub Issue を同じ Task に正規化しきれない問題は、
Merge.dev が長年苦戦している領域。最初から全プロバイダを抽象化すると破綻する。

1環境で動くものを作ってから抽象を抽出する。ただし Provider のインターフェースは
最初から切っておき、1実装に癒着していないかだけレビューする。

**どの Port にどの Adapter を挿すかを決めるのは1箇所だけにする。** その1箇所が
`src/wiring/index.ts`（合成ルート）で、`tests/architecture.test.ts` が
「`src/adapters/**` と `src/store/sqlite.ts` を import してよいのはここだけ」を
機械で固定する。ここが増えると、テストで差し替えたつもりの Port が本番では
別経路から直接入ってくる状態を作れる。

かつてその1箇所は `src/cli.ts` だった。ルールが求めているのは「実装を選ぶ場所が
1箇所」であって「その1箇所が CLI であること」ではないのに、`cli.ts` に固定したまま
Port を足し続けたので、引数の解釈もユースケースも出力の整形も同じファイルに集まり、
1,779 行になった。合成ルートを外に出したので、CLI は Adapter を知らずに済むように
なった。いまは引数の解釈が `src/cli/parse.ts`、出力の整形が `src/cli/present.ts`、
`agent-context` が出す CLI の構造が `src/cli/agent-context.ts`、各サブコマンドの
中身が `src/usecase/**` に分かれていて、`src/cli.ts` に残るのはサブコマンドごとの
手順と終了コードの契約だけになる。

### 3.4 webhook は MVP では不要

Kubernetes の controller も watch だけで動くわけではなく、必ず periodic resync を持つ。
reconcile は「今の状態を見て差分を埋める」冪等な関数で、
起動トリガーが webhook かタイマーかは本質ではない。

- **GitHub**: REST/GraphQL を 30〜60 秒間隔でポーリング。conditional request（ETag）を使えば
  レート制限はほぼ消費しない
- **Slack**（将来）: Socket Mode なら WebSocket の outbound 接続なので受信口が要らない

レビュー承認の検知が1分程度遅れて困る場面はない。
設計上は `EventSource` インターフェースだけ切っておき、後から webhook に差し替える。

### 3.5 providerとモデルはphaseごとに選ぶ

controllerの判断用LLMを呼ぶのはDECIDEのうちGapが残っている経路だけで、実装・レビュー・
調査の呼び出しはActor roleとして分ける。どちらもPortとAdapterを経由し、phaseごとに
providerを選んでもcontroller本体へprovider固有の分岐を漏らさない。DECIDEの出力は必ず
Zodで検証し、通らなければ受け取らない（最大2回リトライ）。

ASSESS は Fact だけを読む純関数で、LLM を呼ばない。DECIDE も、完了判定と停止条件は
**guard**（LLM を呼ばずに決める純ロジック。`src/decide/`）が持つ。
待ちは両方にまたがる。Gap が無いのに unresolved が残る場合の `WAIT` は guard が決め、
Gap が残る場合の `WAIT`（レビュー待ちなど）は LLM も選べる。ただし
**いつまで寝るかは常に guard が決める**（§10-3）。LLM に委ねるのは Gap の埋め方だけになる。

既定はClaude Agent SDKで、Claude Codeの保存済み認証を使う。2026-08-11にCodex CLI
Adapterを追加した。共通の`ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT`に加えて、
`DECIDE`、`IMPLEMENT`、`REVIEW`、`INVESTIGATE`ごとの同名上書きを受け取る。
たとえば`ENT_DECIDE_ACTOR=codex`と`ENT_REVIEW_MODEL=<model>`を同時に指定できる。
同じphaseのprovider・model・effortは1組として選び、ACTのRunには実際に使ったproviderを残す。
effortの語彙はproviderごとに検証する。Claude Codeは`low / medium / high / xhigh / max`、
Codexは`none / minimal / low / medium / high / xhigh`で、片方だけの値を他方へ黙って渡さない。

環境変数が決めるのは既定で、**ティックごとの上書きはDECIDEが持つ**。`ACT`に
`agent`（`actor`は必須、`model`と`effort`は任意）を添えて返せば、そのRunだけが
名指しされた組で走る。誰にやらせるかはGapの埋め方の一部なので、停止条件と違って
LLMに委ねてよい側になる。ただし語彙の検証は起動前に行い、providerに無いeffortを
名指した出力は採用しない——起動してからAdapterで落とすと、ACTが1回失敗したのと
同じだけ予算が減る。**DECIDE自身のproviderはこの経路では選べない。** `agent`を
返す時点でDECIDEは走り終えており、自分を起動し直す道が無い。

**名指しできるのは、環境変数で既に選ばれているproviderだけ**になる。Codexを明示
opt-inにしてあるのは権限制御が同じではないからで（後述）、LLMの出力1つでそこを
迂回できるなら宣言した意味が消える。`ent doctor`がログイン前提を確かめる集合と
同じものを渡してあるので、doctorが見ていないproviderが走ることも起きない。
1つも渡されていない呼び出しでは`agent`を選択肢に出さず、返ってきても採用しない
——**省略を「制限なし」と読まない。**

`model`と`effort`を省いた`agent`は、名指しされたproviderの既定で走る。そのphaseの
環境変数からは引き継がない。引き継ぐと、Claude向けに書いた`ENT_IMPLEMENT_EFFORT`が
Codexの実行へ渡ることになり、「片方だけの値を他方へ黙って渡さない」に反する。

Codexには公式のTypeScript SDK（`@openai/codex-sdk`）もあり、その実体はCodex CLIを起動して
JSONL eventを交換するラッパーになる。ただし現行SDKの公開オプションからは、隔離契約に使う
`--ephemeral`、`--ignore-user-config`、`--ignore-rules`を渡せない。この3つを外してSDKへ
置き換えると、host固有のsession・設定・rulesが実行契約へ混ざるため、Codex Adapterは
`codex exec`を直接起動する。SDKが必要な起動制約を公開した時点で置き換えを再評価する。

### 3.6 待機はプロセスではなく状態にする（中断可能性）

使用量上限やレビュー待ちで controller が常駐して落とせなくなるのは論外。

- reconcile はどのティックも**有限時間で必ず return する**。sleep して常駐しない
- 待ちは `WAITING_*` として DB に書き、プロセスは終了する。**例外は依存待ち**（§10-12）で、
  lease を取らない以上その場では書けないため状態に残らず、`ent run` の `skipped` にしか
  出ない。`resume_after` の待ち（§10-5）は、待ちに入った時点の `WAITING_EXTERNAL` が
  DB にあるのでここに含まれる
- 次のティックは cron の次周回で来る。`ent run <slug>` を cron から叩く構成なら
  常駐プロセスがそもそも存在しない（`ent watch` は未実装。§6）

副作用の前に意図を書く **write-ahead** を徹底し、任意の瞬間に kill されても
次ティックで回収できる crash-only 設計にする。

```
1. 観測と検証を組み立てる（まだ書かない）
2. Run(status: starting) を commit          ← ここで kill されても
3. 選択した Actor を起動                     次ティックが orphan として回収
4. Run(status: completed|failed) を commit
5. snapshot / verifications / Decision を書く
```

**ACT より前に書くのは Run(starting) だけにする。** write-ahead の本体はここで、
Actor を起動した事実が残っていないと orphan を回収できない。ACT の途中で
kill されると残るのはこの行だけになり、次ティックはその回収から始める。

観測を先に書かないのは lease のため。ACT は分単位で、そのあいだに lease を
奪われうる。先に書くと、奪われたと分かった時点では既に他のワーカーが回している
Goal の行を汚した後になる。組み立ては観測した直後に行い、`observedAt` も観測した
時刻のままにして、**書き込みだけを ACT の後へ寄せる**。書く直前にもう一度 lease を
確かめ、失っていれば snapshot / verifications / Decision / status を1つも書かずに降りる。
Run(starting) の行は既に書いてあるので残る。それが write-ahead の要点にあたる。

Decision を最後に置く理由は別で、ACT のあとに関門（保護パス・未 commit）が
差し替えうるため。1ティックにつき1行だけ書く。

SIGTERM を受けたら走行中の Actor に伝播して kill し、Run を `interrupted` で確定し、
lease を解放して終了する。Ctrl+C が効かない状態は作らない。

---

## 4. アーキテクチャ

### 4.1 論理リソースと Adapter

本書では **Provider** をインターフェース、**Adapter** をその1実装の意味で使う。
`CodeProvider` に対する GitHub Adapter、という関係になる。

**§3.5 の「provider」だけは別の軸を指す。** あちらは Actor と LLM のベンダ
（`claude-code` / `codex`）で、この節の分類でいえば Adapter の側にあたる。
語が重なっているので、読むときは節で見分ける。

**Port** はこれらとは別の粒度で、reconcile の各段階が依存する関数の口を指す。
`observe()` が受け取る `CodeProviderPort` のように、Provider の全体ではなく
その段階が実際に呼ぶメソッドだけを並べる。テストで差し替える単位でもある。

**実行時状態の置き場（`Store`）も同じ扱いにする。** 口は `src/store/port.ts`、
いまの実装は SQLite（`src/store/sqlite.ts`）で、実装を選ぶのは §3.3 の合成ルート
1箇所だけになる。かつては口の宣言そのものが SQLite 実装のファイルにあり、
`src/controller/index.ts` がそこを名指しで import していた。内側が外側を参照する
唯一の経路で、しかも `src/store/` は `src/adapters/` の下に無いので、
「Adapter を import してよいのは合成ルートだけ」というテストの網にも掛からなかった。
いまは `src/store/sqlite.ts` の import も同じテストが合成ルート1本に絞っている（§3.3）。
Goal の実行時状態そのもの（`GoalState` / `GoalListItem`）と、1ティック分の観測
（`Snapshot`）は保存の都合ではなく Goal の語彙なので、`src/domain/` が持つ。

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

`claude-code` と `codex` の2実装が、3つのroleをすべて持つ。Codexは
`implement=workspace-write`、`review/investigate=read-only` に固定する。
`codex exec` はClaude Agent SDKと同じcommand単位のallow/denyを受け取らないため、
Codex Adapterは明示opt-inとし、sandbox・資格情報除去・事後のgit関門を重ねる。

`ActorRole` の実体は `src/domain/run.ts` の `actorRoleSchema` にある。`ActorPort`は
`kindFor(role)`で実際のproviderを返し、role別routerが選んだ値をwrite-aheadのRunに残す。
roleは次の5箇所を通る。

- **role が Agent の許可・拒否ツールを決める**（`src/adapters/claude.ts` の `ACTOR_TOOLS`）。
  編集のツール（Edit / Write / NotebookEdit）を持つのは `implement` だけで、`review` と
  `investigate` は読むためのツールと Bash だけを持つ。**指示ではなく権限で分ける。**
  intent は LLM が生成するもので、「書いた」ことは確かめられても「従った」ことは
  確かめられない（§3.2）。編集のツールは許可リストから外すだけでなく拒否リストにも
  入れる。許可リストから外すだけでは、設定の読み込み順や既定値が変わったときに
  素通りしうる。`policies.require_human_approval` から来る拒否は role によらず
  そのまま落とす（レビュー役だからといって merge や force push を許さない）。
  プロンプトも role ごとに分ける。権限だけ分けて文面が同じだと、レビュー役は編集を
  試みて拒否され続け、ターンをそこに使い切る
- **role がClaude Code Agentに見せるskillを決める**（`src/adapters/claude.ts`の`SKILLS_FOR`）。
  Claude Codeのレビュー役にだけ`semantic-review`を渡す。実装役に渡すと「観点を満たすように書く」
  余地ができ、§3.1 が criteria で避けている構図がレビュー側で再発する。
  **`settingSources: []` は解かない。** ホストの `~/.claude` とリポジトリの `.claude` を
  読ませない判断はそのままで、controller が名指しした plugin（`plugins/ent-review/`）
  だけが Agent から見える。skill の一覧に出るのはその1件になる。
  中身は ent の外でも使う汎用の skill で、**Goal も criteria も verdict も知らない。**
  PR の差分ではなく作業ツリーの HEAD を見ること、意図の一次情報が `.goals/<goal.id>.yaml` で
  あること、本文の後ろに `reviewed_sha:` と `verdict:` の2行を足すことは、すべて
  `REVIEW_PROMPT` の側に書く。観点は skill が持ち、契約は controller が持つ。
  **PR のタイトルと本文は、意図の一次情報ではなくレビューの対象として渡す**（§4.3）。
  そのために `ActorInvocation` が `goalId` を運ぶ——宣言部は作業ツリーに commit 済みで
  入っているので、**どのファイルを読めばよいかだけを渡せば意図が届く**
  （`intent` に載るのは constraints だけで、`desired_state` は載らない）
  Codexのreview roleにはこのClaude pluginを渡さず、Codex向けのrole別promptと
  `reviewed_sha:` / `verdict:`の出力契約で同じ観測境界へ接続する
- **worktree の名前が (goal.id, role) から決まる**（`worktreeNameFor`）。
  **`review` は `implement` と同じ作業ツリーを見て、`investigate` だけが分かれる。**
  当初は3つとも分けていたが、分けると**レビューの対象が実装に永久に追いつかない**。
  レビュー役の作業ツリーは base から切られるので実装役の commit が1つも入らず、
  `review.reviewed_sha` は base のまま動かない。`local.head_sha` は実装役の作業ツリーから
  観測する（§10-9）ので、Actor が1回 commit した時点で二度と一致しない。「読んだ commit が
  実装の HEAD と一致するときだけ結論を使う」という照合（§4.3 の `review.reviewed_sha`）が、
  常に不一致に倒れる。
  さらに1ティック目は `verifyRoot` が repoRoot に落ちるので、実装が1行も無い状態で
  レビュー役が先に走ると、**人間のブランチをレビューした approved が sha 一致で通る**。
  分けた当初の理由——レビュー役の checkout や clean で実装側の差分が消える——は
  **同時に走らせる場合の話**で、1ティックで起動する Actor は1体（§5）なので起きない。
  残る「レビュー役が破壊的な git を打つ」経路は、拒否リストで role ごとに塞ぐ
  （`git checkout` / `restore` / `clean` / `reset` / `stash` を、編集のツールを持たない
  役割から落とす）。**`implement` は `goal.id` のまま据え置く。**
  既存の worktree と PR のブランチが `entelecheia/<goal.id>` にあり、規則を変えると
  走行中の Goal が別ブランチに乗り換えて、それまでの差分が PR から消える
- **第2引数に既定値を置かない。** `verifyRoot`（§10-9）と未 commit の関門（§10-11）は
  観測した `local.branch` を `worktreeBranchFor(worktreeNameFor(...))` と突き合わせて
  観測の出自を判定する。保護パスの関門（§10-6）も同じ関数から検査する木を決める
  （あちらは走った role の木と実装役の木の両方を見る。`review` は実装役と同じ木なので
  1つに畳まれる）。候補のブランチが2本ある以上、呼び出し側が「どちらの作業ツリーの
  話か」を毎回書かなければ、`investigate` の作業ツリーの汚れを実装の書き残しと読んでも
  型でもテストでも気づけない。role を書いていない入力（既存の Decision と既存の Run）に
  実装役を当てるのは、読む側の仕事にする（`DEFAULT_ACTOR_ROLE`）
- **どの役割として走ったかを Run に残す**（§4.5）。write-ahead の `starting` 側に書く。
  確定側に回すと、途中で kill された Run の role が空のまま残る（§3.6）

**検証コマンドと `local.*` の観測先は `implement` の作業ツリーに固定する**（§10-9）。
`investigate` の作業ツリーで criteria を検証すると、実装が1つも入っていない作業ツリーの
結果を実装の検証結果として読むことになる。PR に載るのも実装役のブランチになる。

### 4.3 OBSERVE が取得するもの

```
PR        number, state, mergeable, head_sha, review_decision, requested_reviewers,
          title, body, unresolved_threads
Review    state (APPROVED / CHANGES_REQUESTED / COMMENTED), author, submitted_at
CI        workflow_run の status と conclusion、失敗時は失敗ジョブ名とログ URL、
          落ちている job の数（failed_job_count）と数から外した workflow
          （excluded_workflows）
Issue     number, state, labels, linked_pr
local     current_branch, HEAD sha, worktree に未コミット変更があるか
```

CI の失敗内容まで取るのが要点。「CI が落ちた」だけでは次の ACT に渡す材料がない。
失敗ジョブ名とログがあれば、そのまま Claude Code に渡して修正させられる。

**PR の `title` と `body` は完了判定のためではなく、レビュー役に渡すために取る。**
レビュー役の Actor には資格情報を渡していない（§7 の `NEUTRALIZED_ENV`、§10-4）ので
`gh` は未認証で、「宣言部の制約が PR 本文に反映されているか」のような観点は向こう側で
確かめようがなく、毎回 `not obtained` で終わっていた。足りないのは資格情報ではなく、
controller が既に読んでいる情報を渡す口になる。`act` が今ティックの観測から
タイトルと本文（`github.pr.title` / `github.pr.body`）を取り出し（`pullRequestTextFrom`）、
レビュー役のプロンプトに載せる（`renderPullRequestText`）。**読むのは controller、
書くのも controller、Actor へ渡すのはその観測結果だけ**という分担は変えていない。

渡すのは**今ティックの観測が作った Fact だけ**にする。持ち越しを混ぜた集合を渡すと、
GitHub を読めなかったティックにも前回のタイトルと本文が届き、観測の失敗が古い値で
埋まって見えなくなる。渡っていないことと本文が空であることも、プロンプトの文面で
分ける。前者は `not obtained`、後者は `(the body is empty)` と書かせる。空であることは、確かめられ
なかったのではなく観測できた結果にあたる（§3.1）。本文の中に `verdict:` /
`reviewed_sha:` の行があると、レビュー役が引用したときに結論の行が2つになって観測が
pending に落ちる（この節の下、`ReviewPort` の段落）ので、渡す側で印を付けて潰す。

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

`review.verdict` と `review.reviewed_sha` はレジストリにあるが、上の表には無い。
出どころが外部のサービスではなく、この controller が起動したレビュー役の Actor の
実行そのものだからで、`github.pr.review_decision`（GitHub 上の人間または bot の
レビュー）とは別物になる。`verdict` と対で `reviewed_sha` を置くのは、「通った」だけでは
いつの時点のコードのレビューか分からず、実装が進んだあとの Fact をそのまま完了判定に
使うことになるため。Goal YAML が
`verification: { type: fact, key: review.verdict, equals: approved }` と書けば、
Fact が無い間は Gap が残り COMPLETE には届かない（§3.1）。guard に
「レビューを通れ」という条件は足していない。完了判定の境界（§7）を動かさずに済む
形を選んである。

**実装役が走ったティックでは、この照合を通さない。** OBSERVE はティックの先頭にあり
（§3.6）、commit と publish はその後ろに来る（§10-11）ので、VERIFY が読む
`local.head_sha` は ACT より前の観測になる。実装役が commit を積むと、ティックが
終わる時点の HEAD は誰も読んでいない commit なのに、観測時点どうしの一致が
「現在の HEAD へのレビュー」として残る。実際、実装が入ったティックだけ
`review.verdict == approved` の criterion が `passed` になり、次のティックで `failed` に
戻った。そこで、実装役が走ったティックはレビュー系の criteria を判定せず、`pending`
として `unresolved` に積む（`pendingReviewCriteria`、`src/domain/verification.ts`）。
**不合格にはしない。** ACT のあとの HEAD を誰かが読んだかどうかは、そのティックでは
確かめようがなく、確かめられないものを不合格として記録すると、観測の穴が実装の不備と
して PR に出る（§3.1）。

あわせて、そのティックで作った `criteria.<id>.passed` の Fact は落とす。Fact は次の
ティックへ引き継がれるので、残すと誰も読んでいない commit への合格が VERIFIED のまま
生き続ける。落とすのは `criteria.<id>.passed` だけで、観測そのもの
（`review.verdict` / `review.reviewed_sha`）は残す。鮮度の判定そのもの
（`judgeReviewVerdict`）は触っていない。順序の問題であって、判定ロジックの問題ではない。

実装役が走らなかったティックは、押す木を書く役割がいないので通常は HEAD が動かず
（レビュー役は同じ木を読むだけ、`investigate` は別の木を使う）、これまでどおり判定する。
ただし controller の commit（§10-11）は role で分岐しないので、前のティックの未 commit
差分が残ったまま機械側の criteria が通ると、実装役が走っていなくても HEAD が動く経路が
残る。そこは塞いでいない。

作る側は `ReviewPort`（`src/observe/index.ts`）になる。`role: review` で走った Run の
生ログ（§4.6 の `runs/<run-id>/log.jsonl`）から最終メッセージを読み、observe が
それを Fact にする。`ObserveTarget` ではなく Port を足す形にしたのは、
`ObserveTarget` を組み立てる `observeTargetOf` が `src/controller/index.ts`
（`PROTECTED_PATH_FLOOR` の中）にあるためで、「どの Run を読むか」は Port の側で解決する。
**レビュー役が言った文字列は、まだ Fact ではない。** `verdict:` の行は行全体で照合し
（§10-4 と同じ理由。本文の途中に現れた同じ文字列を結論として拾うと、捏造した承認が
作れる）、行が無い・2つ以上ある・2値のどちらでもない・読んだ commit の sha が
決まらないときは、どちらのキーも Fact にせず `pending` として `unobserved` に残す。
`shape_mismatch` にはしない。あちらは guard が即 ESCALATE する「待っても直らない」失敗で、
レビュー役は毎回同じ出力を返すとは限らない。レビュー役を1度も起動していない
ティックでは、Fact も `unobserved` も作らない。

**畳んだ本文そのものは、`--report` の宛先に出す（§9 の「PR と通知」、issue #59）。**
上の経路が残すのは `verdict` の1語と sha の2つだけで、`approved` に添えられた理由も
留保も `runs/<run-id>/log.jsonl` に沈む。`approved` は「何も言うことが無い」ではないので、
`publish` が `ReviewPort.latest()` をもう一度読み、`## Review role message` の節として
宛先の本文の**後ろ**に足す。後ろに置くのは、criteria の表の位置を宛先を問わず
同じに保つため——前に割り込ませると、長い本文を読み飛ばさないと pass 状況に届かない。
本文は要約せず、改行も表もコードブロックも落とさない（`flatten` も `oneLine` も通さない）。

**ここで本文を Fact にはしない。** 出すのは人間が読む宛先だけで、observe の側は
上の照合を通ったものしか Fact にしない。載せるのも `--report` の宛先だけで、
PR コメントには出さない（`--report` の本文と PR コメントの本文は一致しなくなる）。
`--report` を付けないティックでは生ログを開かない——使わない本文のために毎ティック
開くのは、失敗する口を1つ増やすだけになる。読めなかったときは理由を、本文が残って
いない Run では読んだ Run の id を節に出す。**黙って落とすと、この節が直そうとしている
壊れ方をもう1つ作ることになる。** 読み取りが失敗しても `publish` は throw しない
（§9）。新しい Port も Adapter も作らず、`ControllerDeps` が `ObserveDeps` を継承して
いることを使って、既にある `ReviewPort` を `PublishDeps` の任意の依存として受け取る。

PR コメントに出さないのは、人間が購読している場所に毎ティック 14,000 字が積まれると
読むのをやめるためになる。**この理由は `--report` の2つの宛先で効き方が違う。**
`--report stdout` は1回叩いて1回出すので積み上がらないが、`--report <path>` は追記
（`src/cli/present.ts`）で、追記なのは cron から回したときに最後の1ティックしか
残らないのを避けるための選択になる。しかも `ReviewPort.latest()` が返すのは直近の
**完了した**レビュー役の Run なので、次のレビューが終わるまで毎ティック同じ本文が返る
（`WAIT(human_review_pending)` が続く区間がこれにあたる）。**PR コメントを退けた理由は、
ファイルの宛先ではそのまま再現する。** 前ティックと同じ Run なら節を畳む形は取れるが、
publish は前ティックに何を出したかを持っていないので `PublishTarget` を足すことになる。
いまは足していない。

`latest()` が null を返す条件も、見た目より広い。`latestReviewRun()`
（`src/adapters/review-run.ts`）は `status: "completed"` の Run だけを候補にするので、
レビュー役が `interrupted` や `failed` でしか終わっていない Goal でも null になる。
**「1度も起動していない」との区別は Port の戻り値に載っていない。**

sha を読む経路は2本ある。**先に見るのは `reviewed_sha:` の名指しで、いまはこちらが
通常の経路になる。** 名指しが1つだけあればそれを採り、2つ以上あって値が食い違えば、
数え直さずに `pending` に落とす——どれを読んだかを2通り述べた出力は、数えても
決まらない。名指しが1つも無いときだけ、本文中の 40 桁を数える側へ落ちる。同じ sha を
何度述べても1つと数え、違う sha が並んでいたら、どれを読んだ結果なのか決められないので
`pending` にする。

数える側が**当初の既定**で、名指しを見る経路はその手前に後から足したものになる。
読む側を先に足したのは、当時のプロンプトが言うのが「読んだ commit の sha を述べる」
ことだけで、**数えるだけの規則が落とす出力——差分の比較元を完全形で併記する、
`git log` の出力を1行引用する。どれも指示に従った書き方になる——を拾える形が、
読む側にしか置けなかった**ため（`src/adapters/claude.ts` は
`PROTECTED_PATH_FLOOR` の中にあり、Actor には触れない）。

いまはプロンプトの側でも名指しを要求している。レビュー役に `semantic-review` の
skill を渡した（§4.2）ときに、あの出力形式が本文に base と head の2つの sha を
並べるため、数えるだけの規則では毎回落ちるようになったからで、**人間が
`REVIEW_PROMPT` を書き換えて足した。** 読む側の規則はそのまま残す。名指しが
無い出力——プロンプトを差し替える前の Run、skill を使わなかった Run——を、
待っても直らない失敗として扱う理由が無い。要求する側と拾う側の両方があり、
片方が欠けても安全側（Fact を作らず `pending`）に倒れる。

起動する側は DECIDE のプロンプトになる。選べる行動に `role: review` の ACT を1つ足し、
`review.reviewed_sha` が `local.head_sha` と一致しているあいだは——実装が1行も
進んでいないということなので——その選択肢を理由付きで外す。判定を guard に足さないのは、
レビューをいつ回すかを決定論に置くと「レビューを通れ」という条件を完了判定の手前に
足したのと同じになるため。外したはずのレビュー役を LLM が返し続け、再試行を使い切った
場合だけ `ESCALATE(review_not_converging)` で止める（`invalid_decision` に畳まない）。

**選択肢を出すのは、criteria がレビューの結論を求めている Goal だけになる。** Gap は
LLM を動機づけるだけで起動を絞りはしないので、無条件に出すと `review.verdict` を
1文字も書いていない Goal でもレビュー役が起動できる。予算1回分の話にとどまらない。
レビュー役の Run が1つできると、その最終メッセージが読めなかったティックは
`review.*` が `pending` として `unresolved` に積まれ、Gap がゼロの Goal では
guard の3番目（§7）が WAIT を返して LLM が呼ばれない。もう一度レビューを回すという
選択そのものができず、`latest()` は同じ Run を返し続けるので pending は自力で消えない。
criteria に書いた Goal は verdict が欠ければ Gap が立って回復できるので、
**書いていない Goal だけが COMPLETE に届かなくなる**という逆転になる。起動の口を
criteria に閉じておけば、その Run が最初から存在しない。ここも guard の判定ではなく、
LLM に見せる選択肢の範囲になる。

**同じ手で `WAIT` も外す**（issue #61）。レビュー役が `changes_requested` を返し、その
結論が読んだ commit（`review.reviewed_sha`）がまだ実装役の HEAD（`local.head_sha`）の
ままなら、待って変わるものが何も無い。指摘を直せるのは実装役だけで、人間の承認も CI も
この状態を先へは進めない。それでも DECIDE は `WAIT` を選び続けていた——1つの Goal を
収束させる間、19 ティック中6ティックがそれで、動いたのは人間が criterion を1本
足したときだけになる。**実質のハンドルが「criteria を足すこと」になっていた。**

外し方はレビュー役と同じ3つで揃える。プロンプトからは JSON の書式ごと落とし
（「人間を待つべきだと判断したら WAIT を選ぶ」という誘い文句も一緒に落とす。形だけ
消して誘い文句を残すと、残った方が読まれる）、外した理由と commit の sha を書き、
**同じ条件を受け取り側にも置く。** 外したはずの WAIT を返し続けて再試行を使い切ったら
`ESCALATE(invalid_decision)` で止まる。新しい `ESCALATE` の理由は足さないし、
`review_not_converging` にも数えない。あちらが指すのは「実装が進まないままレビューだけを
回そうとしている」で、止めた理由を読む人間には別のものとして届く必要がある。
reason は見ない。待つ相手を人間から CI に付け替えても、実装が1行も進んでいない事実は
変わらない。guard には足さない（レビュー役と同じ理由。§7 の完了判定の境界を動かさない）。

**`local.head_sha` は今ティックの OBSERVE が作った Fact からしか読まない**（§10-11 が
`local.dirty` について書いているのと同じ規則）。VERIFIED であることは「このティックで
確かめられた」ことを意味しない。reconcile は前ティックの Fact を土台にするので、
`LocalRepoPort` が落ちたティックには前ティックの head が VERIFIED のまま残る。
しかもこの穴は構造的になる。1ティックは OBSERVE → ACT の順なので、実装役が走った
ティックの `reviewed_sha` と `local.head_sha` は同じ sha を指し、**次のティックで local の
観測さえ落ちれば、繰り越した head は必ず reviewed_sha と一致する。** そのティックで
選びたいのは `WAIT(observation_failed)` なのに、それが消える。DECIDE には引き継ぎ込みの
`facts` と今ティックの `observedFacts` の両方を渡し、**選択肢を消す側だけ**を後者に限る
（`ReconcileResult.observedFacts`）。2つの材料で出どころが違うのは腐り方が違うため。
「commit X を読んだレビューがこう結論した」は後から変わらないが、「X がまだ HEAD だ」は
Actor が push するたびに変わる。同じ規則をレビュー役を外す判定にも適用する。片方だけ
今ティックに寄せると、`local.head_sha` の出どころが判定ごとに違う状態が残る。

`github.pr.review_decision` は REST の `pulls/{n}` と `pulls/{n}/reviews` から導出する。
GraphQL なら1回で取れるが、ETag による conditional request（§3.4）が効くのは REST の
GET だけなので、レビュアーごとに最後の1件を見て組み立てる。変更要求を承認より優先する。
`github.issue.linked_pr` は「その Issue 自身が PR である」場合しか埋まらない。
相互参照された PR は timeline API が要るので、まだ観測しない。

`github.pr.unresolved_threads` だけは GraphQL の `pullRequest.reviewThreads` から取る。
上の「ETag が効くのは REST の GET だけなので REST から組み立てる」という**判断のほうの
例外**になる。REST にはスレッドの解決状態を表すフィールドが無く、GraphQL の
`reviewThreads.isResolved` にしか出ないので、ETag を諦めて GraphQL を選ぶしかない。
そのぶんこの読み取りは毎ティック実際に飛ぶ（§3.4 が「ETag を使えばレート制限はほぼ
消費しない」と書いているのは REST の話で、ここは当てはまらない）。

> [!NOTE]
> このキーの `unresolved` は GitHub のレビュースレッドの解決状態を指す。
> §3.1 の `Unresolved`（結論が出なかった検証対象）とは別物になる。

読み取りに失敗したときは throw せず件数を `null` にし、**Fact を作らない**。数え切れなかった
ぶんを 0 と読むと、bot の指摘を残したまま
`verification: { type: fact, key: github.pr.unresolved_threads, equals: 0 }` が成立してしまう。

**ただし「Fact を作らない」だけでは収束の側に倒れない。** そう言えるのは1ティック目までになる。
reconcile は前ティックの Fact を土台にして今ティックの観測で上書きするので、上書きの来ない
キーは前ティックの値が VERIFIED のまま残る。ティック N で 0 を観測し、ティック N+1 で bot が
新しいスレッドを立て、同じティックで GraphQL が落ちれば、引き継がれた 0 で criterion が
passed になる。しかもこの読み取りは `unobserved` を積まないので、WAIT でも止まらない。
スレッドが 100 件を超えたあと（`totalCount` は解決済みも数えるので、未解決が 100 件無くても
到達する）は読み取りが恒久的に `null` になるので、この経路も恒久化する。

そこで `expireStaleFacts`（`src/reconcile/index.ts`）に条件付きの失効を1本置く。
**「`github.pr.number` は今ティックで観測できたのに `github.pr.unresolved_threads` は
観測できなかった」ときだけ、引き継いだ件数を落とす。** PR そのものを読めなかったティックでは
落とさない（`github.ci.*` の失効と同じく、確かめられなかったことを「変わった」と読まない）。
そのティックは `github.pr` が `port_failed` で `unobserved` に残るので、待つ理由はそちらにある。
**「Fact が無ければ criterion は埋まらないので収束の側に倒れない」が成立するのは、この失効と
組にしたときになる。**

`github.ci.*` の失効を head_sha の変化で判定しているのに、こちらを sha で判定できないのは、
紐づく先が違うからになる。CI の conclusion は head sha に紐づき、同じ sha なら不変なので、
sha が動かない限り引き継いで安全になる。未解決スレッドの件数は sha に紐づかない。
**bot は新しいコミットが無くてもスレッドを立てられる**ので、同じ sha のまま件数だけが変わる。
1時間前の件数を今の件数として使うのは、§3.1 が禁じている「捏造した観測」にあたる。

**残件: 読み取りの失敗が、観測の側に一切残らない。** §3.1 は「確かめられなかった」を
`unobserved` に積むと決めているが、このキーは Fact も `unobserved` も作らずに落ちる。
失効のおかげで criterion が通らないことは保たれるが、**なぜ埋まらないのかがどこにも残らない**。

**それでも、いま `port_failed` を積むのは正しくない。** DECIDE は `unresolved` を criteria との
関係で絞らないので、1件でも積めば Gap がゼロの Goal はすべて `WAIT(observation_failed)` に
なり、このキーを1文字も参照していない Goal まで完了できなくなる。`shape_mismatch` として
積めば guard が即 ESCALATE するので、影響はさらに広い。足りないのは観測側の積み方ではなく、
**DECIDE 側の「そのキーを参照している criterion にだけ効く `unresolved`」という概念**になる。
そこを先に足さない限り、このキーだけを §3.1 に寄せることはできない。

失効を足したぶん、この残件の痛みは増している。恒久的な失敗——token に GraphQL の権限が無い、
GitHub がフィールドを変えた、スレッドが 100 件を超えた——では Goal は正しく収束しなくなるが、
その理由はどこにも残らず、`max_unchanged_reconciles` の `loop_detected` として上がる。
**人間が受け取る停止理由が、実際の原因を指さない。**

**`github.pr.review_decision` *だけ* を人間の承認の観測源にはできない。** GitHub は自分が
作った PR に Approve を押させないので、controller が Goal の所有者と同じアカウントで PR を
作る限り `reviewDecision` は `APPROVED` にならない。これを `type: human` の唯一の判定に使うと
reconcile は `WAIT(review_pending)` から抜けられず、§9 の完了判定に到達できない。
`.goals/assess-and-decide.yaml` の Goal で実際に踏んだ。

経路そのものが誤りではない。`ApprovalPort` はレビュー承認と PR コメントの定型文の
2つを signal にする（理由と判定順は §10-4）。2つ目は作成者自身が書いても成立するので、
1人運用でもここで承認待ちは解ける。

### 4.4 状態機械

```
Goal のライフサイクル

  DRAFT → AWAITING_CRITERIA_APPROVAL → ACTIVE
                                        ⇅
                    WAITING_HUMAN / WAITING_EXTERNAL / BLOCKED
                                        ↓
                      COMPLETED | FAILED | ABANDONED

待機の種類（いずれも reconcile は即 return する）

  WAITING_HUMAN(reason: human_review_pending)  人間の承認待ち
  WAITING_EXTERNAL(reason: ci_running)      CI 完了待ち
  WAITING_EXTERNAL(reason: usage_limit)     選択したLLM/Actorの使用量上限。resume_after を持つ
  BLOCKED(reason: budget_exhausted)         予算・回数・時間の上限に到達
```

`human_review_pending` の旧名は `review_pending` になる。**enum からは消さない。**
decisions テーブルは読むたびに `actionSchema.parse` を通るので、消すと過去の Decision 行が
読めなくなる。遷移先も `WAITING_HUMAN` のまま変えない。

ここに並ぶのは `WAIT` の reason だけになる。`ESCALATE` から `WAITING_HUMAN` へ落ちる理由
（`protected_path_touched` / `uncommitted_changes` / `push_branch_declared_manual` /
`open_pull_request_declared_manual`）は §7・§10-6・§10-11 の側にある。

**依存待ち（§10-12）はこの一覧に無い。** `goal.depends_on` が揃わないティックは lease を
取らずに `tick` の入口で return するので、Goal は ACTIVE のまま状態を1つも動かさない。
理由は `ent run` の `skipped` にしか出ない（§3.6 の例外）。

`AWAITING_CRITERIA_APPROVAL` は MVP では実装しない。§3.2 のとおり、Goal YAML の
レビューがそのまま承認ゲートを担うので、`ent start` は `DRAFT` から `ACTIVE` に直行する。
型には残してあるが、この値を書き込むコードは無い。

ESCALATE は reconcile が選ぶ行動、BLOCKED は Goal の状態。
ESCALATE の結果として Goal は BLOCKED か WAITING_HUMAN に遷移する。

**終端状態からは戻さない。** `nextStatus` と `tick` に加えて、`ent start` も
終端の Goal を ACTIVE に戻さない。COMPLETED を後から取り消せると、
§9 の完了判定そのものが意味を失う。やり直すなら DB の状態を明示的に戻す。

LLM/Actor providerには時間枠や契約に応じた使用量上限がある。
何時間も走る controller は上限に当たりうるので、クラッシュや即時再試行ではなく
`WAITING_EXTERNAL(usage_limit)` に落ちて、リセット時刻まで寝て自動再開する。
リセット時刻が取れなければ指数バックオフ。
DECIDEだけでなくActorの実行中に上限へ達した場合も、失敗分類、トークン、生ログをRunへ残し、
guardが当該ACTを`WAIT(usage_limit)`へ差し替える。これにより次ティックの別providerのDECIDEが、
同じACTを即座に再試行する経路を作らない。

### 4.5 データモデル

以下は DB のテーブル定義であり、`src/domain/` の型とは1対1に対応しない。
例えば evidence は、DB では `evidence_source` / `evidence_detail` の2列に開き、
型では `evidence: { source, detail }` として入れ子で持つ。

```
Goal          id, name, desired_state, status, lease_owner, lease_until,
              resume_after, activated_at, reconciles, pr_number, issue_number,
              abandon_reason, guard_base_sha
StateSnapshot goal_id, observed_at
Fact          snapshot_id, seq, key, value, observed_at, confidence, evidence
Unresolved    snapshot_id, seq, key, reason, detail      観測できなかった対象
Verification  goal_id, reconcile_seq, criterion_id, result, reason,
              evidence, detail, verified_at
Decision      goal_id, reconcile_seq, observed_digest, action, rationale,
              decided_by, decided_at
Run           goal_id, intent, actor, role, worktree, attempt, status, started_at,
              finished_at, exit_code, log_ref, tokens, artifacts, detail,
              error_kind, actor_resume_after
LlmCall       goal_id, purpose, tokens, log_ref, ok, called_at

Criteria      未作成。criteria は Goal YAML が正
Plan / Task   作らない。分解はサブ Goal の宣言が持つ（§10-12）
Event         未作成。webhook を入れる Goal で足す
```

`policies` と `budget`、`goal.depends_on` は Goal YAML が正で、DB には持たない。
宣言部と実行時状態を混ぜないという §4.6 の分け方に従う（依存の判定は、依存先 Goal の
`status` を読むだけで足りる。§10-12）。

`Plan / Task` だけは「まだ作っていない」ではなく**作らないと決めた**もので、
`Criteria` や `Event` とは意味が違う。分解した1本ごとに Goal を立てる方針を採ったので
（§10-12）、Plan にあたるものはサブ Goal の宣言そのものになる。DECIDE が選ぶ行動としての
`REPLAN`（§1 / §5）は残るが、その結果を DB の別の層には持たない。

`LlmCall` は当初この一覧に無かった。DECIDE を Actor 層経由に寄せた（§3.5）結果、
Run を作らない LLM 呼び出しが生まれ、そのトークンを §7 のとおり残す場所が要るようになった。

**結論が出なかった対象も永続化する。** ここを落とすと §3.1 が避けたかった
「Fact の不在に畳まれる」問題が DB 層で再発し、ASSESS が取りこぼしを読めなくなる。
観測側は `Unresolved` の行として、検証側は `Verification.result` を
`passed` / `failed` / `unresolved` の3値にして持つ（`unresolved` のときだけ `reason` が埋まる）。

**`failed` の中身も残す。** `evidence.detail` に終了コードだけを入れていたころ、
criteria が一度だけ落ちて次のティックで通る、という揺れを追えなかった。同じ
worktree で手で流すと全件通り、残っていたのは `exit_code=1` だけだった。
§3.1 が守っているのは「確かめられなかったこと」で、落ちていたのは**確かめた結果が
不合格だったときの中身**になる。いまは落ちたときだけ出力の末尾を載せる
（`describeCommandResult`。上限 2000 文字、切ったことを本文に書く）。生ログでは
ないので、数十MBを SQLite に押し込まない（§4.6）。

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

**ティックが走っているあいだは期限を延長し続ける。** ACT は選択した Actor の実行なので
分単位でかかる（§9 の実測では、1ティック目に 1,341,349 tokens を消費している）。
`leaseSeconds` は 300 なので、延長しないと ACT の途中で期限が切れる。cron から回す構成
（§3.6）では、そこで別プロセスが lease を奪い、同じ worktree（名前は (goal.id, role) から
決まる。実装役とレビュー役は同じ場所になる）で2つの ACT が並行する。稀な競合ではなく、実運用の既定の挙動になっていた。

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
.goals/.state/worktrees/<slug>/ 実装役とレビュー役が共有するworktree。実装役が書き、レビュー役が読む（§4.2）
.goals/.state/worktrees/<slug>-investigate/ 調べる役の worktree
```

人間が編集する宣言部と、機械が書き換える実行時状態を混ぜない。
同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
`ent get <slug>` が両者をマージした1枚を標準出力に吐くので、参照時は1ファイルに見える。
`.goals/<slug>.yaml` を機械が書く経路を入れるかは §10-12 で決めた。**書き手が増えても
宣言部と実行時状態を分ける線は動かない。動くのは「人間が編集」の側だけになる。**

`.goals/<slug>.yaml` のスキーマは `src/domain/goal.ts` にある。slug は `goal.id` と
一致させる（突き合わせは `src/domain/goal-parse.ts`）。ファイル名は Phase 番号ではなく
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
- ACT（選択した Actor の非対話実行、git worktree 隔離）
- VERIFY（`command` = 検証コマンド、`fact` = CI ステータスなど観測値との照合、`human` = 人間承認）
- 状態機械、ポーリング、write-ahead 永続化、予算とループ上限、使用量上限での自動待機
- 通知と承認は GitHub の PR コメント + CLI 標準出力で完結させる。
  承認の signal はレビュー承認と PR コメントの定型文の2つで、CLI 標準出力は通知だけを担う（§10-4）

### 入れない

- Notion 連携（読み取り・書き戻しとも。環境ができてから足す）
- Slack 連携（同上）
- Web UI（CLI と生成レポートのみ）
- GitLab / Linear / Jira の Adapter 実装（インターフェースだけ切る）
- 複数 Actor の並列実行（インターフェースは複数対応、実装は逐次1本）。
  役割が増えた（§4.2）が、**1ティックで起動する Actor は
  1体のまま**で、Decision も1ティックに1行のままにしてある。協働は同時ではなく
  ティックをまたいだ交代で成立させる。同じティックに2体を走らせると、Run の確定・
  lease・write-ahead の前提（§3.6 / §4.5）まで変わる。
  **ここで言う並列は1ティックの内側の話になる。** Goal単位のleaseがあるためデータモデル上は
  N本を別プロセスで扱える。同一ディレクトリでの並列実行を塞いでいた保護パスの関門は、
  状態DBの観測をGoalごとの論理ダイジェストに移したことで外れた（§10-6）。
  ただし**確かめたのはVitestの中で2本のティックを同じDBへ同時に流したところまで**で、
  `ent run`のプロセスを2本立てて回してはいない。gitのロック競合（初回の
  `git worktree add`が`.git/index.lock`を取る）とSQLiteのbusy競合は残る。
  README「複数のGoalを同時に回す」を参照
- ~~Codex CLI の実装~~（`ENT_ACTOR=codex`またはphase別指定で非対話JSONL Adapterを選ぶ）
- L5 改善レイヤー（History は貯めるだけ、学習はしない）

Notion と Slack を外したことで、MVP の外部依存が GitHub 1つになった。
既定の Claude Code 運用では GitHub token と Claude Code の OAuth だけで済み、
Codex を選ぶ場合は Codex CLI の保存済みログインも必要になる。
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
| Actor 実行 | `@anthropic-ai/claude-agent-sdk` / `codex exec --json` | 共通指定とphase別上書きから選ぶ。Codexは保存済み認証と非対話JSONLを使う |
| スキーマ | Zod | Agent 出力の検証ゲートと YAML バリデーションを同一定義で兼ねる |
| YAML | `yaml`（eemeli） | コメント保持のラウンドトリップ編集。機械が書き戻すなら必須 |
| DB | `node:sqlite`（Node 標準） | 同期 API でコードが素直。Node 22.13 以降はフラグなしで使える（22.5 で導入、それ以前は無い）。`mise.toml` が Node 24 を固定し、`engines` も `>=24` にしてあるため常に使える。better-sqlite3 + Drizzle の採用予定を取り下げた（下記） |
| CLI | `node:util` の `parseArgs`（Node 標準） | サブコマンドが少ない（採用時は4つ、いまは8つ）ので依存を足す価値が出ない。10 を超えたら citty か oclif に寄せる |
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
3. CLI のサブコマンドは `start` / `run` / `show` / `list` の4つ（当時の名前。`show` は
   いまの `get`）で、citty の型の恩恵より依存が1つ増えるコストの方が重い

結果として、controller の本体は zod と yaml の2つだけに依存する。
同じ理由で、プロセス実行も execa ではなく `node:child_process` にしてある。

外部依存は Port の実装側に寄せた。4本目で `@octokit/rest`（+ throttling / retry）と
`@anthropic-ai/claude-agent-sdk` が入っている。octokit は `src/adapters/` に閉じており、
Agent SDK は `src/wiring/index.ts`（§3.3 の合成ルート）が `query` を注入する1点だけが
外に出る。

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
mise run typecheck / lint / build / test / verify   アプリケーション側
mise run check                                      サプライチェーンと workflow（baseline 由来）
```

---

## 7. 暴走とコストの制御

自律実行させる以上、ここは機能要件と同格に扱う。予算と上限と承認ゲート、保護パスの選び方、
publish を宣言で止める口、資格情報と外部コマンドの4つを順に説明する。

### 予算と上限、承認が要る操作

以下は記述例。実際の値は Goal ごとに `.goals/*.yaml` で指定する。

```yaml
budget:
  max_actor_runs: 20              # 1 Goal あたりの Actor 起動回数
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
- **`max_wall_clock` が数えるのは、機械側が動けた実時間になる。** `WAIT` と、
  予算切れ以外の `ESCALATE` で待っていた分は引く（`waitedSeconds`）。待てと
  指示したのは controller の側で、次のティックが何をしても状態は変わらない。
  その時間を Goal の予算から引くのは筋が通らない。実際、`type: human` の
  criterion を1本だけ残して一晩承認を待った Goal が、承認が届いたあと
  それを観測する前に `budget_exhausted` で `BLOCKED` になった。`ent complete` は
  無い（§3.1）ので、その時点ではもう COMPLETED に到達できない（`budget` は Goal YAML が
  正なので、人間が上限を書き足せば ACTIVE に戻せる）。
  待ちの長さは Decision の履歴から導く。状態を1つ足して同期させると、
  そこを書き損ねたティックだけ上限が黙って効かなくなる。
  **材料が欠けたときは、どちらも上限が効く側に倒す。** `activated_at` を
  解釈できなければ経過時間を Infinity にして「上限に到達した」とし、`decided_at` を
  読めない Decision は待ちに数えない。0 秒として扱うと NaN との比較が常に false に
  なり、`max_wall_clock` だけが黙って無効化される。逆に読めない時刻を待ちに数えると、
  引いた分だけ上限が伸びる。どちらも停止条件が消えるので、人間を呼ぶ側に倒す
- 同一 Task の再試行上限。達したら別 Actor か Replan、それも尽きたら ESCALATE
- 観測が N 回連続で変わらなければ ESCALATE（ループ検知）。N は `budget.max_unchanged_reconciles`。
  判定の材料は Gap ではなく `Decision.observed_digest`（§10-2）
- 人間承認を必須にする操作: main への直接 push、force push、merge、デプロイ、
  シークレット操作、外部への送信
- 自己ホスト時の追加: `policies.protected_paths` に挙げたパスへの変更、worktree 隔離の強制

### 保護パスに何を並べるか

`protected_paths` に何を並べるかは、**「Agent がそこを書き換えたら他の統制を全部外せるか」**
で決める。制御ループ本体（`src/controller/**`）と Goal の宣言部（`.goals/**`）だけでは足りない。

このうち**どの Goal からも外せない下限**を `PROTECTED_PATH_FLOOR`（`src/domain/goal.ts`）
に置く。Goal が `protected_paths` を空にしても、スキーマが読み込みの時点で下限を混ぜる。
関門の適用範囲を Goal 側が決める形のままだと、関門を外したい Goal がいつでも外せる。
下限に入れるのは**書き換えられると関門そのものが働かなくなるもの**だけで、検証系
（`mise.toml` など）と依存（`package.json`）は入れない。あちらは Goal によっては
正当に触る対象になりうる。下の列挙は下限と、Goal ごとに足す分の両方を含む。
**下限の全量は `PROTECTED_PATH_FLOOR` を正とする。** 下の箇条書きは基準を説明するための
代表例で、網羅ではない。両方に同じ一覧を持たせると、片方だけ古くなったときに
どちらが関門の実体なのか読む側から分からなくなる。承認ゲートにも同じ形の下限があり、
`APPROVAL_GATE_FLOOR` が `secret_access` と `external_send` をどの Goal にも混ぜる。

- 関門そのもの（`src/domain/protected-paths.ts`）と、Agent の許可・拒否ツールを決める
  ファイル（`src/adapters/claude.ts`）。ここが開いていると、照合を常に false にするか
  拒否リストを空にするだけで残りが全部外れる。同じファイルが、役割ごとに見せる skill
  （`SKILLS_FOR`）と、レビューの結論の契約（`REVIEW_PROMPT` が求める `verdict:` と
  `reviewed_sha:` の2行。§4.3）も持つ。**Actor が自分に渡る観点と、自分の結論の
  読まれ方を書き換えられる**ようになるので、下限から外せない
- **guard が読む判断規則（`src/domain/guard-rules.ts`）。** 関門が差分を取る相手
  （`guardBaseOf`）、未 commit の関門が見る述語（`leavesWorkUncommitted` / `observedValue`）、
  寝ている間かの判定（`sleepingUntil`）、経過時間と連続失敗の数え方がここにある。
  書き換えれば関門は毎ティック空の差分を見るし、壁時計の停止条件も黙って無効化できる。
  もとは `src/controller/**` の中にあって下限に覆われていた。**依存を持たない規則だから
  という理由でドメインへ出すと、出した先が下限の外になる。** 下限はパスのリテラルなので、
  **リファクタで場所が動くと保護は付いてこない。** 移設のたびに下限も一緒に動かす。
  `tests/protected-floor.test.ts` が、規則がどのファイルで宣言されているかをソースから
  読んで、その置き場が下限にあることまで見る。
  1ファイルに集めてあるのは保護の単位と揃えるためで、語彙ごとに配ると下限に何本も
  足すことになり、しかも Goal が正当に触りうる語彙と同じファイルになる
- **合成ルート（`src/wiring/index.ts`）。** 規則を守っても、その規則へ渡る
  **入力**が開いていれば関門は無力になる。ここは `localRepo` / `commandRunner` /
  `gitWorktree` を注入する場所で、未 commit の関門と VERIFY が見る作業ツリーを決める
  `verifyRoot`（§10-9）も同じファイルにある。`guardBaseOf` を1文字も触らずに、
  関門が読む観測そのものを差し替えられる。**こちらは上とは逆で**、リファクタ前も
  同じコードが `src/cli.ts` にあって下限の外だった。移設で開いた穴ではなく、
  以前から開いていたものを移設のついでに閉じたことになる。
  `tests/protected-floor.test.ts` が、
  `tickPorts` と `verifyRoot` の置き場を `guard-rules.ts` と同じ方式で見る
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

### publish を宣言で止める

上の承認ゲート（`policies.require_human_approval`）が止めるのは **Agent** の操作になる。
書いたゲートは `DENIED_TOOLS`（`src/adapters/claude.ts`）の対応行を拒否パターンに変えるだけで、
**controller 自身の行動には1つも効かない**。push と PR 作成を行っているのは
controller の publish（§10-11）なので、「PR を勝手に立てるな」を宣言する口が無かった。
実際、Goal を回した次のティックで PR が立ち、人間が確認しようとした時点では
レビュアーへの通知も飛んでいた。取り消しても通知は戻らない。

**ゲートの意味は広げず、別の宣言にする。** `policies.publish` を新設し、
`push_branch` と `open_pull_request` をそれぞれ `auto` / `manual` で宣言する。
`require_human_approval` に `open_pull_request` を足す形は採らない。同じ列挙が
主体（Agent / controller）によって別の関門に効くことになり、しかも対応する
`DENIED_TOOLS` の行が無い値だけが Agent 側で素通りする。読み手からは、どの値が
どちらに効くのかを名前から見分けられない。

| 宣言 | 止める主体 | 効く先 |
|---|---|---|
| `policies.require_human_approval` | Agent | Actor に渡す拒否ツール（`deniedOperations`） |
| `policies.publish` | controller | `src/publish/index.ts` の push と PR 作成 |

値は「承認の要否」ではなく**実行主体**にしてある（`auto` = controller、`manual` = 人間）。
承認を検知して先へ進む仕組み（`/ent approve`、§10-4）は criteria にしか無く、publish には
無い。「承認待ち」と読める名前を付けると、どこかに承認する口があるはずだと探させることになる。

段を2つに分けたのは、戻せなさが違うため。push はブランチが remote に出るだけだが、
PR の作成はレビュアーへの通知を伴う。「ブランチは出してよいが PR は人間が立てる」を
書けるようにする。

**既定は `auto` で、下限（floor）は置かない。** `PROTECTED_PATH_FLOOR` と
`APPROVAL_GATE_FLOOR` が下限を持つのは、書き換えられると関門そのものが働かなくなる
ためで、こちらは止めなければ従来どおり動くだけになる。既定を `manual` に倒すと、
いま回っている Goal が全部止まる。

止めたティックは `ESCALATE(push_branch_declared_manual)` か
`ESCALATE(open_pull_request_declared_manual)` になり、状態は `WAITING_HUMAN` に移る。
**COMPLETE も上書きする。** PR が1本も無いまま「終わった」と言い切ると完了判定が
意味を失う。理由を段ごとに分けてあるのは、`ent list` が出すのが種別と理由だけだから
（`WAITING_HUMAN` には §10-6 の `protected_path_touched` など他の理由も畳まれる）。
人間が何をすれば進むのかは
`decision.rationale` に書く。

**その rationale が出るのは `ent get` と `ent list` までになる。** 判断の差し替え
（`publishHeldDecision`）は publish の**後ろ**にあるので、publish が進捗コメントに載せた
`decision` は差し替え前のものになる。§10-11 の `uncommitted_changes` は publish の前で
差し替わるため PR と `ent get` に同じ文字列が出るが、こちらはその規約から外れる。
**差し替えを前へ動かす形は採れない。** `open_pull_request` を止めるかどうかは
「push が通り、まだ PR が無い」を確かめたあと——publish の中——でしか決まらない。

代わりに、PR には `heldNotes`（`src/publish/index.ts`）が `> [!NOTE]` を書く。文字列は
rationale と別でも、**同じ事実を言う**——手で push しても controller には見えないこと、
宣言を `auto` に戻すか `ent abandon` で終端にすること。ここを「push していない」の1行に
留めると、人間が最も要る2つが PR の側から読めない。止めたことを知らせておいて
次にすることを書かない通知は、鳴っていないのとほぼ同じになる。

**ただし届くのは、既に PR がある Goal に限られる。** `push_branch: manual` は push の前に
返るので、最初からこの宣言を書いた Goal では PR が作られず、`heldNotes` の書き先が無い。
そちらは下の `open_pull_request` と同じで、`ent list` を読む以外に気づく経路が無い。

**`open_pull_request` を止めたティックは、PR の側に何も出ない。** この段で止まるのは
「差分があり、まだ PR が無い」ティックだけなので、書き込む先が1本も無い。読むのは
`ent get` と、次に出てくる `publishHold` になる。

**この段で止まった Goal は、どの通知にも出ない。** PR コメントが無く、`BLOCKED` にも
落ちず、壁時計も止まる。cron から回して stdout を誰も読まない構成では、止まったことに
気づく経路が `ent list` を定期的に読むこと以外に無い。`open_pull_request: manual` を
宣言する側は、その1本を用意しておく。

`open_pull_request` を止めた Goal は、**人間が PR を立てれば宣言を書き換えなくても進む**。
publish は作る前に必ず同じ head の PR を探すので（`findPullRequest`）、次のティックが
それを見つけて先へ行く。止めているのは「作る」ことだけで、既にある PR への進捗コメントは
止めない。

**`push_branch` にはその経路が無い。** publish が push の要否を決める材料は
`BranchPort.push` の結果しかないので、人間が手で押しても publish の判断には入らない
（remote そのものは `github.pr.head_sha` などで観測しているが、押すかどうかの判断は
それを読まない）。宣言を `auto` に戻すまで毎ティック同じ理由で `WAITING_HUMAN` に
落ち続け、そのあいだ reconcile の予算だけが減る。
`protected_path_touched` が worktree を掃除すれば解けるのとはここが違う。
**解けない関門であることを rationale に書く**（`publishHeldDecision`）。書かなければ、
押したのに止まり続ける理由を人間がコードから探すことになる。

**`BLOCKED` には落ちない。** 判断の差し替えは publish の後ろにあり、`held` があれば
DECIDE が何を選んでいても `ESCALATE(*_declared_manual)` で上書きする。`BLOCKED` になるのは
`ESCALATE(budget_exhausted)` だけなので（§4.4）、止めているあいだは上限に達しても
そちらが表に出ない。人間を呼ぶ理由としては `*_declared_manual` のほうが具体的なので
上書きの向きはこれでよいが、「止めているあいだは予算の枯渇が見えない」ことは
宣言を書く側が知っておく必要がある。

**進み続ける上限と、止まる上限がある。** 3つを一緒に扱わない。

| 上限 | 止めているあいだ | なぜ |
|---|---|---|
| `max_reconciles` | 進む | `saveSnapshot` が数えるのは publish より前で、止めても1ティックは1ティック |
| `max_actor_runs` | 進む | ACT は publish より前になる。止めているのは push と PR 作成だけで、Actor は走る |
| `max_wall_clock` | **止まる** | `waitsForOthers` が `budget_exhausted` 以外の `ESCALATE` を待ちに数える |

壁時計だけは隠れるのではなく止まる。`*_declared_manual` は `ESCALATE` で、しかも
`budget_exhausted` ではないので、`waitedSeconds`（`src/domain/guard-rules.ts`）がその窓を
積み、`usageOf`（`src/controller/index.ts`）が `elapsedSeconds` から引く。止めていた分は
まるごと予算から外れるので、宣言を `auto` に戻したティックで壁時計が上限に達している
ことはない。**そこで表に出うるのは `max_reconciles` と `max_actor_runs` の側になる。**
待たせたのは controller の側なので引くのは筋が通っているが（§4.4）、「止めていれば
時間は減らない」ことは、`max_wall_clock` を停止条件として当てにする側が知っておく。

**止めたことは機械可読で出す。** ティックを叩くのは人間だけではない。エージェントが
回している構成では、controller が作らなかった PR をそのエージェントが代わりに立てる。
そのためには「作らなかった」と「作るなら head と base はこれ」が、`decision.rationale` の
散文を読まずに分かる必要がある。`ent run` の出力に `publishHold` を足してある。

```json
{
  "publishHold": {
    "step": "open_pull_request",
    "reason": "declared_manual",
    "pushed": true,
    "branch": "entelecheia/<goal-id>",
    "base": "main"
  }
}
```

形は `--report` の `report`（`destination` / `written` / `error`）に揃えてある。どちらも
「その口を使ったティックにだけ載る publish の結果」で、行った先と結果を構造で返す。
**止めていないティックにはキーごと載せない。** 宣言を書いていない既存の `.goals/*.yaml` を
回している側の出力を1キーも変えない（`dryRun` と同じ扱い）。

`pushed` は `step` から導ける（`open_pull_request` の段に来るのは push が通ったあとだけ）が、
それでも別に持つ。remote に無いブランチを head にした PR は作れないので、代わりに立てる側は
ここを見てから動く。導出に頼らせると、publish の順序が変わったときに読む側が静かに間違う。

段と理由も分けてある。`step` に「宣言で止めた」まで畳むと、宣言以外の理由で止める形が
増えたときに読む側の分岐が壊れる。いま `reason` に入るのは `declared_manual` だけになる。

**保護パスの関門で止めたティックにはこのキーを出さない**（`blocksPush`）。あちらは push も
していないうえ、代わりに押してよい状態でもない。ここに出すと、controller が止めた関門を
叩いた側のエージェントが迂回する経路になる。それは関門が無いのと同じになる。

`--dry-run` にはこの停止は映らない。publish を回さないティックなので、`wouldTransitionTo` は
止める前の判断のまま返る。`push_branch` の側は宣言だけから決まるので予告もできるが、
そうすると同じ関門の判定が publish と preview の2箇所に分かれる。判定は publish に1本化して、
映らないことを `preview` の性質として書いてある。

### 資格情報と外部コマンド

**トークンは Agent に渡さない。** Bash を許している以上、`printenv` も
`echo $GITHUB_TOKEN` も実行できる。どちらも `secret_access` の拒否パターン
（`gh secret` / `gh auth token`）に一致しないので、拒否リストでは塞げない。
Agent SDK の `env` は「マージではなく置き換え」なので、`process.env` から
`GITHUB_TOKEN` / `GH_TOKEN` を落として渡す。push と PR は controller だけが行うので、
Actor 側にトークンが要る場面はそもそも無い。

**落とすだけでは足りない。** `gh` はトークンの環境変数が無ければ
`$HOME/.config/gh/hosts.yml` のログインに落ちる。`HOME` は渡すしかない
（`mise` も `pnpm` も動かなくなる）ので、除去リストの届かないところに認証が
残っていた。`NEUTRALIZED_ENV` が `GH_CONFIG_DIR` を実在しないディレクトリへ
向けて、Actor と検証コマンドの中の `gh` を未認証にする。**消す側だけでなく、
上書きして無効化する側も要る**（`src/domain/withheld-env.ts`。塞ぎたい経路は §10-4）。

**`gh` を塞いでも git 自身は塞がっていなかった。** Actor に渡すのと同じ環境
（トークンの環境変数は落とし、`GH_CONFIG_DIR` は無効化済み）のまま、private
リポジトリに対する `git ls-remote https://github.com/...` が非対話で通り、
`git credential fill` に `protocol=https` / `host=github.com` を流すと
トークンそのものが stdout に出た。出どころは system の gitconfig の
`credential.helper = osxkeychain` で、**system の設定なのでリポジトリ設定でも
ユーザー設定でも消せない。** 塞げるのは環境変数だけになる。取れれば PR コメントを
投稿でき、`/ent approve` の定型文を Actor が自分で書ける（§10-4）——`gh` を
未認証にした理由が、そのまま git にも当てはまっていた。

`NEUTRALIZED_ENV` が4つを重ねる。`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
`GIT_CONFIG_VALUE_0` の組は system / global / local のどれよりも**後**に読まれ、
`credential.helper` の空値は helper のリストを reset する。helper が消えると git は
端末と askpass に聞きに行くので、`GIT_TERMINAL_PROMPT=0` と
`GIT_ASKPASS=/usr/bin/false` で「聞けないので失敗する」に倒す。ssh 側は
`SSH_AUTH_SOCK` を落とすだけでは足りず（実測で `~/.ssh` の鍵のまま通った）、
`GIT_SSH_COMMAND=/usr/bin/false` で ssh を起動する側を潰す。

**閉じたのは、周囲の環境から黙って届く経路になる。** 名指しで書き戻す形
（`git -c credential.helper=osxkeychain`）は残る。§10-6 の (i) に置いた。

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
| 1 | `.goals/record-the-tick.yaml` | 1ティックの記録。観測対象の指定、LlmPort の生ログとトークン、Verification | 完了 |
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
要求していなかった**ことが原因になる。**いまはその前提そのものを置いていない。** 機械側の criteria
（`command` 型）が全部通ったティックで、controller が Actor の書いたものを commit する。
それでも commit されなかったティックは、「機械側にやることは残っていない」と言い切る
ティックで **今ティックの観測が worktree を見て作った** `local.dirty` を読み、
VERIFIED で汚れていれば `ESCALATE(uncommitted_changes)` にする（§10-11）。
確かめられなかったティックは違反にしない。

### 自己ホストには制約が要る

自分自身を書き換えさせる以上、暴走すれば被害は自分に返ってくる。

- worktree 隔離を必ず使う。controller 本体を動かしているコードと Agent が編集するコードを
  物理的に分ける
- 制御ループ自体を Agent に書き換えさせない。対象は `src/controller/**` と `.goals/**`
  だけでは足りず、関門そのものと検証系まで含める（選び方は §7）
- controller が持つ資格情報を Agent に渡さず、外部コマンドを argv 配列で叩く（同じく §7）

2つ目は `policies.protected_paths` として宣言し、controller が ACT の外側で
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

そのとき `/ent approve` を書いたのは PR の作成者本人にあたる。作成者を承認から外すと
この確認が再現できなくなるので、コメントの側は作成者を数える側で固定してある（§10-4）。

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

MVP を止める未確定は残っていない。**他のリポジトリで回す前に決める必要があるのは
§10-8 と §10-9 の2つ。** どちらも主題は Phase 3 で確定していて、隣にある問いが1つずつ
開いている。**取り消し線は「その項目の主題は確定した」を意味し、そのうえで一部が
開いているものに（一部）を付ける。**

- **§10-8（一部）** — `protected_paths` をどこに載せるかは確定した。開いているのは
  Goal YAML のスキーマを変えたときの移行方針の側になる
- **§10-9（一部）** — VERIFY を Goal 専用の worktree で流すことは確定した。開いているのは
  そのコマンドを controller の権限で実行している側になる

§10-12 が残す2つは、上の2件には数えない。1つは入った `goal.depends_on` の穴で、粗い
タスクを複数の Goal に割って回すときに効く。自己ホストはまだ `depends_on` を
使っていない。もう1つは、分解を機械にやらせる場合に criteria の変更を検知する
指紋で、経路そのものがまだ無い。

残りは他のリポジトリで回す前提を欠かないので、実運用で必要になった順に埋める。

### 10-1. ~~Goal YAML のスキーマ詳細~~

Phase 0 を1周して確定した。`src/domain/goal.ts` を参照。Phase 0 版からの差分は、
`repository` と `setup` を足し、`verification` を `command` の1形式から
`command` / `fact` / `human` の3形式に広げ、`adapters` / `goal.status` / `goal.source` を
削ったことになる。`context.references` は `title` / `path` のみを許し、URL は受け付けない。

### 10-2. 上限値の初期チューニング

`max_actor_runs` などの値は仮置きのままになる。

~~ループ検知の N が無い~~ — Phase 3 の3本目で `budget.max_unchanged_reconciles` を
足して確定した。材料は前ティックの Gap ではなく `Decision.observed_digest` にしてある。
2ティック続けて完全に一致することを実測しており、Gap を別に永続化しなくてよい。
今ティックの digest が直近の連続と違えば数え直す。「3回同じだったが今回は変わった」を
空回りと読むと、進んだ直後に止めてしまう。

判定順は `budget_exhausted` → `COMPLETE` → `WAIT` → `loop_detected` になる。
人間の承認を待つあいだも観測は変わらないので、Gap が無い場合より後に置く。

### 10-3. ~~使用量上限の検出方法~~

Phase 2 の4本目で確定した。Agent SDK の `rate_limit_event` が持つ
`rate_limit_info.status` が `rejected` なら上限で、応答ヘッダ
`anthropic-ratelimit-unified-status` から作られる。`resetsAt` は
**秒**（実装が `Date.now()/1000` と引き算している）。`assistant` メッセージの
`error: "rate_limit"` は上限と一時的な 429 の両方に付くので、単体では根拠にならず、
直前に `rejected` を見ているかで判断する。

上限を検知したあとの経路は、DECIDE と Actor で分ける。DECIDEのPortは
`PortError("usage_limit")`を投げ、DECIDEのguardが`WAIT(usage_limit, resumeAfter)`を返す。
ActorのPortは同じ分類をRunの`errorKind`と`resumeAfter`へ保存し、controllerのguardが
元のACTを`WAIT(usage_limit, resumeAfter)`へ差し替える。CodexではJSONLの`error`または
`turn.failed`を最終メッセージより優先し、stdoutとstderrを生ログへ残す。

Claude Agent SDKの使用量上限判定はドキュメントに記載が無く、根拠はClaude Codeの
実装読解にある。SDKが変われば黙って壊れるので、Claude側のPortを触るときに読み直す。

### 10-4. ~~人間の承認をどの signal で検知するか~~

Phase 3 の2本目で確定し、MVP レビューで**認可**を足した。誰が書いたかを見ていなかったので、
公開リポジトリでは通りすがりの1行で `type: human` の criterion が VERIFIED になった。
§9 の完了判定は人間の承認を根拠にしているので、ここが開いていると完了判定が成立しない。

**認可は `author_association` で見る。** signal の2経路（下記）はどちらも、`OWNER` /
`MEMBER` / `COLLABORATOR` のときだけ承認として数える。`CONTRIBUTOR`（過去にマージされた PR がある）は
書き込み権限とは別物なので含めない。関係が読めなければ承認しない側に倒す。
変更要求のほうは権限を問わず止める側に数える。承認を厳しくするのと拒否を厳しくするのは
別の話で、倒す向きが逆になる。

あわせて、**controller 自身の進捗コメントを承認として読まない**。`rationale` には
LLM が決めた `intent` がそのまま載るので、そこに定型文を書かせれば controller の
トークンで投稿されたコメントの中に承認の1行が成立する。Agent に `gh pr comment` を
禁じて塞いだ経路を controller が迂回する形だった。進捗コメントには HTML コメントの
目印を入れて除外し、`rationale` の改行も潰して二重にする。

**signal は2つあり、どちらか一方でも成立すれば承認とみなす。** GitHub のレビュー承認
（他人が Approve を押す。仕事で使うときの本来の経路）と、PR コメントの定型文
`/ent approve <criterion-id>` になる。§4.3 が言うのは「`review_decision` *だけ* には
頼れない」で、経路そのものが誤りではない。ここまでが signal **が2つであること**の定義で、
そこは Phase 3 の2本目から変わっていない（**誰の投稿を数えるかは MVP レビューで2度変えた。
下記**）。

**PR の作成者をどう扱うかは、2つの経路で逆にする。** レビュー承認は作成者自身の
Approve を数えない（GitHub 自体も自分の PR の Approve を許さない）。
**コメントの定型文は作成者も数える。** `GITHUB_TOKEN` は開発者自身のトークンなので
PR を立てるのもその人で、ここで作成者を除くと `/ent approve` の経路そのものが消える。
**1人で開発しているあいだ成立しないのはレビュー承認の側だけで、コメントの定型文は
1人でも成立する。** 自分のリポジトリなら `author_association` は `OWNER` になるので、
書き込み権限を確かめたうえでそのまま承認として数える。

一度は自己承認を塞ぐために作成者を除外したが、**塞ぎたかったのは「Agent が作成者
名義で定型文を書く」経路であって、人間の作成者ではなかった。** 承認できる人を
減らす形で塞ぐと、§9 の「完了判定」を通した手順そのものが再現できなくなる。

**その経路は資格情報を届かせない側で塞ぐ。** 拒否リストだけでは足りない。
コメント投稿を落とす `external_send` は `APPROVAL_GATE_FLOOR` にあって
どの Goal からも外せない（§7）が、中身は glob なので
`gh api -X POST`（`--method POST` の別綴り）にも `sh -c` 経由の間接呼び出しにも
一致しない。**書ける形を数え上げる統制は、1つ書き落とした時点で穴になる。**
しかも `WITHHELD_ENV` が落とすのはトークンの環境変数だけで、`HOME` は渡すしか
ないので、Actor の中の `gh` は controller を動かしている人間の認証で通っていた。
いまは `NEUTRALIZED_ENV` が `GH_CONFIG_DIR` を実在しないディレクトリへ向け、
**Actor と検証コマンドの両方で `gh` を未認証にする**
（`src/domain/withheld-env.ts`。VERIFY 側も塞ぐのは、Actor が書いたテストが
controller の権限で走るため。§10-9）。
そのうえで、controller 自身の進捗コメントは `PROGRESS_MARKER` が除外し、
role ごとのプロンプトにも「承認の定型文を書かない」を明記してある。

**残る前提は2つ。** 1つは、`gh` 以外の手段（生の HTTPS 要求）を書かれたら
届くこと。`Bash(curl *)` は拒否リストにあるが、これも書ける形の数え上げに
戻る。もう1つは、拒否リストもプロンプトも SDK の設定でしかないこと（§10-6）。
資格情報を渡さない側は SDK の外でも効くので、そこだけは層が違う。

**照合の規則は経路ごとに置く。** レビュー承認は PR 全体に対するものなので
`type: human` の criteria すべてを満たす。変更要求が最新として残っていれば、
どちらの経路でも承認しない。定型文は行全体で照合する。引用やコード例の中の
同じ文字列を承認と読むと、捏造した承認が作れてしまう。

### 10-5. ~~`resume_after` を誰が読むか~~

Phase 3 の3本目で確定した。`tick` が入口で判定し、過ぎるまで何もせずに return する。
lease も取らない。取ると、寝ているだけの Goal が他のワーカーを塞ぐ。解釈できない値は
「起きてよい」と読む。壊れた値のせいで Goal が永久に止まる方が、1ティック早く起きるより
悪い。

### 10-6. ~~`require_human_approval` を誰が止めるか~~

Phase 3 の4本目で確定し、MVP レビューで**検査の入力**を入れ替えた。
controller が ACT の外側で検査し、worktree の外に出た編集と保護パスへの編集を
見つけたら `ESCALATE(protected_path_touched)` にする。Agent 側の `disallowedTools` は
残して二重にする（理由は §8 の自己ホスト節）。

**検査の入力は自己申告ではなく git にする。** 当初の検査対象は
`Run.artifacts`（Edit / Write / NotebookEdit が触ったパス）だけだった。
Bash の `tool_use` は `file_path` を持たないので、`echo >` や `sed -i` で書いたファイルは
**原理的に artifacts へ現れない**。「Bash 経由なら外にも書ける」ことを
前提に置きながら、それを原理的に捕捉できないデータ源の上に検査を建てていた。
いまは **git が観測した変更**（`status --porcelain -uall` と base からの
`diff --name-only`）を主にする。自己申告ではなく「書けた結果」を見るのが、
Bash を許したまま取れる唯一の検査点になる。

**その base は `default_branch` ではない。** 関門が答えたい問いは
「Actor が何を書いたか」で、`repository.default_branch` が答えるのは
「リリース先との差は何か」になる。後者を前者に流用していたので、人間が
呼び出し側のブランチに書いたものまで Actor の編集として並んだ。ent は
`.claude/worktrees/<name>` のような呼び出し側の worktree から回し、Goal の宣言
（`.goals/<slug>.yaml`）と仕様テストはそこに書く。ent の worktree を
`main` から切ると、その宣言は base 側に入らないので `main...HEAD` に出る。
`.goals/**` は `PROTECTED_PATH_FLOOR` にあってどの Goal からも外せないため、
Actor が何もしていないティックでも `protected_path_touched` になった。

いまは `ent start` を叩いた時点の repoRoot の HEAD を
`GoalState.guardBaseSha` に記録し、worktree を切る元も関門が比べる相手も
そこに揃える。**切った元と比べる相手は同じでなければならない。**
ずれると、切った元に無いものを「Actor が書いた」と読むか、逆に Actor が
書いたものが差分から消える。PR の base（`publish`）は `default_branch` のまま。

**ブランチ名ではなく sha で持つ。** 3点表記（`base...HEAD`）は base が先に
進むだけなら分岐点が動かないが、分岐点の commit 自体を書き換えると
`merge-base` が消えて `guard_unavailable` になる。作業ブランチでは amend も
rebase も日常的なので、走行中に1回打つだけで関門が張れなくなる。
記録が無い Goal（この列より前に start した分）は `default_branch` に落とす。
走行中の worktree を別の commit へ切り直すと、それまでの差分が PR から消える。

**記録するのは、Run が1件も無い Goal に `ent start` を打ったときだけにする。**
条件を「記録がまだ無い」だけにすると、この列より前に start して worktree が
`default_branch` から切られている Goal に、いまの HEAD を基準として与えてしまう。
記録が commit id の形をしていなければ `default_branch` には落とさず
`guard_unavailable` に倒す。状態 DB は gitignore 済みで本体側の汚れの観測に出ないので、
検証しないまま読むとリテラル `HEAD` を1回書き込むだけで差分が恒久的に空になる。

**worktree の外も git で見る。** worktree の中で git を回しても、
`git worktree add` で分けた本体側の作業ツリーは観測できない。`Run.artifacts` も
Bash を拾わないので、`bash -c 'echo > ../../../../src/controller/index.ts'` は
どちらの入力にも現れなかった。隔離が守るはずの当のファイルが、隔離の検査から
漏れていたことになる。本体リポジトリ側でも `status --porcelain -uall` を回し、
絶対パスで返して `escaped_worktree` に落とす。

本体側は ACT の前後の差だけを違反として数える。自己ホストでは人間の編集中の
ファイルが最初から汚れているので、それを違反にすると関門が毎ティック鳴る。
比較はパスの集合ではなく**中身の指紋**で行う。パス名だけで比べていると、人間が
編集中のファイルを Actor が上書きしたときに前後で同じパスが並び、差が消える。
Actor は `git -C ../../../.. status` で汚れているファイルを読めるので、
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

**index の隠しビットは、拒否リストではなく観測する側で塞ぐ。** `git status
--porcelain -uall` は `assume-unchanged` と `skip-worktree` を尊重するので、
作業ツリーの中から `git -C ../../../.. update-index --assume-unchanged
src/controller/index.ts` を1回叩いてから本体側のファイルを書き換えると、
`git status` も `git diff` も空になり、**違反ゼロで通過する。** そのあと `tsc` は
index ではなくファイルシステムから読むので、改変された controller がそのまま走る。
下に挙げる (c) と (e) は「1度は人間に届く」を保証として残しているが、
この経路は一度も鳴らない。

そこで `changedPaths` と `repoDirtyState` が `git ls-files -v` を読み、
**隠しビットが立っているパスを、中身を見ないまま観測に足す**（`indexHiddenPaths`、
src/adapters/local.ts）。「編集された」ではなく「観測から外された」を違反として扱う。
本体側の値は**中身の指紋ではなく印**にしてある。指紋にすると、`assume-unchanged` を
立てて置いているファイル（この動詞の本来の用途）を人間が編集するたびに ACT の
前後で値が動き、(d) の誤検知が常態になる。印なら、差に出るのは ACT の窓の中で
ビットが立った/消えたときだけになる。代わりに、**以前から隠されていたファイルへの
書き込みは見えない。**

拒否リスト側にも同じ動詞（`git update-index` / `git rm --cached` / `git stash` /
`git push` / `git credential`）を足したが、**あれは数え上げなので閉じない。**
Claude Code 2.1.197 のバイナリから規則の解釈と照合を取り出して流したところ、
`Bash(git push *)` は `^git push( .*)?$` にあたる正規表現になり、
`git -C .. push origin HEAD:main` には一致しなかった。`git * <動詞>*` の綴りを
併記すると `-C` と `--git-dir=` の前置は拾えるが、`GIT_DIR=... git push` のように
環境変数を前置すると `git` で始まらなくなり、どちらの綴りからも外れる。
**拒否リストは二重化の片側でしかない**（§8 の自己ホストの節）。

違反の種別（`escaped_worktree` / `protected_path`）と ESCALATE の理由は別の層で、
種別がどちらでも理由は `protected_path_touched` になる。
検査できなかったら `ESCALATE(guard_unavailable)`。「触っていない」と
「確かめられなかった」を混ぜない（§3.1）。関門が動いていない状態で先へ進めるのは、
関門が無いのと同じになる。

**検査はティックごとに行う。** 違反した編集は worktree に残す（人間が判断できるように）
ので、そのティックの Run だけを見ていると、次のティックが保護パスに触れずに終わった
時点で汚れた worktree ごと push される。違反は1ティックの出来事ではなく、
worktree が汚れているあいだ続く状態として扱う。

**見るのは、そのティックで Actor が走った作業ツリー**（Run の `role`。§4.2）
**に加えて、必ず実装役の作業ツリー**。Actor を起動していないティック
（`ACT` 以外・dry-run）は実装役だけになる。
実装役を必ず混ぜるのは、**push するのが実装役の作業ツリーだから**（§10-11）。
走った role の木だけを検査していた頃は、レビュー役が走ったティックで
「検査した木」と「押す木」が別になっていた。自分の木を持つ役割（いまは
`investigate`）は編集のツールを持たないが Bash は持つので、`git -C <実装役の木>` で
書いて commit する経路は塞がっていない。その commit はその役割の `changedPaths` にも、
本体リポジトリ側の観測（worktree の置き場は除外される）にも出ないまま push される。
**守りたい不変条件は「押す木は必ず検査した木に含まれる」**で、そのために
push 側を Run に従わせるのではなく検査側を広げてある。
`review` は実装役と同じ木を見る（§4.2）ので、検査する木は1つに畳まれる。
逆向き——実装役のティックで `investigate` の木まで見る——はしない。
あちらが残した差分で実装が止まる理由が無い。
違反は worktree に残り続けるので、どちらの木でも毎ティック再検知される。

照合はシンボリックリンクを実体へ解決してから行い、大文字小文字は区別しない。
macOS も Windows も既定でパスの大小を区別しないので、`src/Controller/index.ts` と
書けば同じファイルに届くのに glob には一致しない、という抜け道ができる。

**ただし、本体リポジトリ側の相対パスは解決しない。** `origin: "repo_root"` で来る
もののうち、絶対パスは `repoDirtyState` の実パスになるが、残りは controller と
Adapter が自分で組み立てた表示用のキーになる（`.goals/.state/goals.db`、
`.git/hooks/**`、そしてファイルですらない `.git/config#core.hooksPath`）。
これらを worktree の root へ resolve して実体に解決していたので、**解決の結果が
Agent の握る FS に依存していた。** worktree の中に
`.goals/.state/goals.db -> ../../package.json` を1つ置けば、キーは `package.json` へ
解決されて `.goals/**` に一致しなくなり、状態 DB を直接書き換えても違反が出ない。
`guard_base_sha` を worktree の HEAD にすれば、以後どのティックでも差分が空になり、
関門は恒久的に目を潰される。symlink を置いたこと自体も、gitignore と
`isRuntimeState` の両方に隠れて見えない。表示用のキーは controller が作る文字列で
FS を引く必要が最初から無いので、解決せず文字列のまま glob に当てる
（`tests/protected-paths-symlink-bypass.test.ts`）。**この穴が出荷されたのは、
既存のテストが実在しないディレクトリを基点にしていて `realpathSync` が必ず
throw していたため。** 関門のテストは FS を実際に触る。

**関門が止めたティックは push も PR 作成も行わない。** 違反を含む worktree が
remote に出た時点で、通常の変更として流れる余地が生まれる。
そのうえで、**PR が既にあるなら、観測が前ティックと同じでもコメントを書く。**
観測ダイジェスト（`Decision.observed_digest`。この節で後に出てくる状態 DB の論理
ダイジェストとは別物になる）は Fact だけから作るので Decision を含まない。Actor が worktree の
外だけを書いたティックは観測が1文字も変わらないので、黙って飛ばすと隔離が
破れたことが PR に一度も出ないまま `WAITING_HUMAN` になる。
PR がまだ無いうちに違反したティックでは、PR を作らないので通知も残らない。
その場合に人間へ届くのは `ent get` と Decision の履歴だけになる。

**状態 DB だけは、ファイルではなく行を見る。** `.goals/.state/goals.db` は
関門が見る保護対象でありながら、**controller 自身の書き込み先**でもある。
ACT の窓——ベースラインを控えてから検査するまでの間——で、controller は必ず
この DB に書く。Run の write-ahead（`startRun`）と確定（`finishRun`）、そして
lease の延長になる。

かつてこれも `outOfSightState` が**ファイルのバイト列**で見ていた。SQLite は
WAL なので、その書き込みは普段 `goals.db-wal` に載るだけで `goals.db` の中身は
1バイトも動かない。動くのは **WAL が既定の閾値（1000 ページ）を越えたコミットで
自動 checkpoint が走り、WAL の内容が `goals.db` へ畳み込まれたとき**になる。
ティックの形が同じでも、そのプロセスがそれまでに書いた量が閾値を跨いだ回だけ
指紋が変わり、`ESCALATE(protected_path_touched)` になっていた。人間も Actor も
触っていないのに関門が鳴り、実装役の成果が publish されないまま worktree に残る。

**保護するかどうかは変えない。** `.goals/.state/**` は `PROTECTED_PATH_FLOOR` に
残る。外せば、DB を直接書き換えて状態を偽造されても関門が鳴らない。変えたのは
観測の作り方で、**バイト列ではなく、その Goal に属する行の内容**から決定的な
ハッシュを作る（`Store.guardDigest`。実装は `src/store/sqlite.ts` の
`guardDigestOf`）。checkpoint でも VACUUM でもページの再配置でも値は動かない。

**Goal ごとに閉じる。** 見るのはそのティックが回している Goal の行だけになる。
別の Goal の行がいくら増えても値が動かないので、同じディレクトリで2本目の ent が
別の Goal を回してもこちらの関門は鳴らない。行が `goal_id` を持つこと自体は
最初からそうなっており（`facts` と `unresolved` は `snapshots` 経由で辿れる）、
§4.5 のスキーマは変えていない。**行を分けるだけでは解けなかったのは、WAL が DB
ファイルに1つしか無いため**で、論理ダイジェストと組にして初めて Goal ごとに
閉じた観測になる。

**`depends_on` に挙げた Goal の `status` も射影に入れる。** 依存ゲート
（`dependencyGate`）はそこを直接読んで進むかどうかを決めるうえ、その呼び出しは
lease を取る前——どのティックの ACT の窓の外——にある。入れないと、依存先へ
`UPDATE goals SET status='COMPLETED'` を1行流すだけでゲートを開けられて、
どちらの Goal のダイジェストにも差が出なかった。見るのは `status` だけにする。
`reconciles` や lease や `pr_number` は、依存先を回す2本目の ent や人間の
`ent start` で動くので、入れると鳴りっぱなしになる。`status` はゲートを通る条件が
`COMPLETED`（終端）で、終端の Goal は誰も回さないため動かない。

**controller 自身が ACT の窓で書く分だけを射影から外す。** 外すのは2つで、
`goals` の lease 列（ティックのあいだ延長し続ける）と、そのティックで controller が
作った Run の行になる。落とすのは**渡した Run だけ**で、テーブルごとではない。
ACT の窓で誰かに Run を差し込まれれば鳴る。

**落とした Run の行は、別の関門が不変列だけ受け持つ**（`ownRunDrift`、
`src/controller/index.ts`）。controller が ACT の窓で書き換えるのは `finishRun` の
9列（`status` / `finished_at` / `exit_code` / `log_ref` / `tokens` / `artifacts` /
`detail` / `error_kind` / `actor_resume_after`）だけで、`intent` / `actor` / `role` /
`worktree` / `attempt` / `started_at` は `startRun` が1回書いたきり動かない。
行ごと落とすと、その不変列まで観測の外に出る。**とくに `role` が外に出ていると、
実装役が自分でレビューを承認できた。** 実装役の ACT の窓の中で
`UPDATE runs SET role='review' WHERE goal_id=? AND status='starting'` を流すと
（Run の id を知る必要すら無い）、次のティックで `latestReviewRun` がその Run を
「直近のレビュー役の Run」として選ぶ。`log_ref` は controller が正しく書いている
ので生ログの偽造も要らず、実装役が自分で書いた最終メッセージが `review.verdict` と
`review.reviewed_sha` の Fact になり、`judgeReviewVerdict` が criterion を passed に
する。だから ACT の後に、`startRun` へ渡した組と DB の行を突き合わせる。
行が `listRuns` から消えていること（`goal_id` の書き換え）も改竄として数え、
値がスキーマに載らず読めなければ `guard_unavailable` に倒す。
**ただし鳴るのは書き換えたティックだけで、書き換えられた行は DB に残る。**
次のティックではその Run が `ownRuns` から外れて射影の内側に入るので鳴り止み、
人間が掃除しなければ `role='review'` の行はそのまま残る（(h)）。

スキーマ（`sqlite_master`）も見る。
trigger を1つ仕込めば、行を1つも変えずに以降の書き込みへ副作用を付けられる。
**ファイルの存在と inode も見る。** 開いたままのコネクションは unlink された
ファイルを読み続けるので、行だけを見ていると、消されたことにも、同じパスへ別の
ファイルを置かれたことにも気づけない。存在だけでは後者が素通りするので、
inode を組で見る。

**バイト列を捨てて諦めたものは (h) に書いた。代わりに (g) が閉じた。**
論理ダイジェストは SQLite 経由で読むので、まだ WAL にしか無い行も見える。

**残る穴を8つ書いておく**（記号は動かさない。(g) は閉じたが、他の穴の呼び名が
ずれると過去のレビューが指す先が変わるので、消さずに取り消し線で残す）。

(a) repoRoot の外（`~/.zshrc` や `~/.claude/**`）は git で観測できないので見えない。

(b) git の観測に出ないものが2系統ある。gitignore されたパス（`.goals/.state/**`）と、
gitignore とは無関係に `git status` が原理的に出さないもの（`.git/hooks/**` と、
そもそもパスではない `core.hooksPath` の設定値）。前者は `--ignored` を付ければ出るが、
controller 自身が毎ティック書くので、自分の書き込みが毎回違反として並ぶ。
**どちらの系統も、実行に繋がる3つだけは ACT の前後で比べる**（MVP レビューの
SEC2 / SEC3）。`.git/hooks/**` と `core.hooksPath` は `outOfSightState` が名指しで
指紋を取り、`.goals/.state/goals.db` は controller が `Store.guardDigest` の論理
ダイジェストで見る。**加えて、レビュー役の完了した Run の生ログ
（`.goals/.state/runs/<id>/log.jsonl`）も同じダイジェストに載せる。** 行は
守っていたのに、行が指している先は誰も見ていなかった。実装役はそれを worktree の
外から上書きでき、`reviewRunLog` が読んだ本文はそのまま `review.verdict` と
`review.reviewed_sha` の VERIFIED な Fact になる。自分で commit して HEAD を
固定してから前のレビューのログに `verdict: approved` を書けば、次のティックで
criterion が緑になり、`reviewedHeadOf` が同じ commit の再レビューを止めるので
**本物のレビューはもう走らない**（`tests/state-db-review-log-digest.test.ts`）。
載せるのは実際に Fact の材料になる行だけで、読む対象が増えたらここも増やす。
残る穴は、この2つ以外の gitignore されたパスで、そこを書き換えられても検知しない。

(c) 本体側の違反は、同じファイルが次のティックまで**そのまま**なら、
その内容がベースラインに入るので鳴り止む。指紋で比べているので、同じファイルを
もう一度書き換えれば再び鳴る。鳴り止むのは「1回の改変を放置した場合」に限る。
それでも、止まった Goal を人間が掃除しないまま回し続ければ、改変された
controller のソースはディスクに残る。

(d) ACT 中に人間が repoRoot を編集すると差分に載り、`protected_path_touched`
として止まる。安全側だが誤検知になる。

(e) 本体側は未 commit の汚れしか見ない。worktree 側は commit 済みの差分まで
追うが、本体側のブランチは controller が動かさないので `status` だけにしてある。
`git -C ../../../.. commit` は拒否リストに無いので、本体側で書いてから commit
されると、汚れの集合から消えて検査の外に出る。`git stash` は拒否リストに載せたが、
あれは数え上げなので綴りを変えれば外れる（上の `-C` の話と同じ）。

(f) 状態 DB の改竄で見えるのは、そのティックが回している Goal の行と、
`depends_on` に挙げた Goal の `status` だけになる。それ以外の Goal の行を
書き換えられても、こちらのティックは気づかない。あちらのティックが自分の窓の中で
気づく余地はあるが、窓の外で起きた分は誰も見ない。これは Goal ごとに閉じた観測に
した代償で、同じディレクトリで別の Goal を回せることとは表裏になる。

**依存ゲートだけは、他の Goal の行を読む唯一の例外**になる。
`dependencyGate` は依存先の `status` を直接読み、しかもその呼び出しは lease を取る
前——どのティックの ACT の窓の外——にある。射影に入れたので、**どこかのティックの
ACT の窓の中で書き換えられた分は鳴る**。窓の外で書き換えられれば、こちらの
ベースラインにも検査にも同じ値が入るので、やはり誰も見ない。読む先を射影に
入れることと、窓の外を見られないことは別の話になる。

**誤検知は増やしていない。** ゲートを通る依存先は `COMPLETED`（終端）に限られ、
終端の Goal は `tick` が回さず、`ent start` も `ent abandon` も終端を理由に断る
（`src/cli.ts`）。射影に入れた `status` を正規の経路で動かせる者はいないので、
依存先を回す2本目の ent がいても鳴りっぱなしにはならない。lease や `reconciles`
まで入れると鳴るので、入れるのは `status` だけにしてある。

(g) ~~状態 DB の改竄も指紋で見るのは `goals.db` だけで、`goals.db-wal` は
見ていない~~（閉じた）。論理ダイジェストは SQLite 経由で読むので、まだ WAL に
しか無い行も見える。バイト列で見ていた頃は、SQLite 経由で書き換えられた行が
次の checkpoint まで `goals.db` に現れず、そのティックの差に出ないことがあった。

(h) 状態 DB について、「バイト列は違うが、この Goal の論理的な行は同じ」改竄は
通る。射影から外してあるのは `goals` の lease 列と、そのティックで controller が
作った Run の行の2つになる。

前者は lease を奪える（＝ティックを落とせる）が、状態の偽造にはならない。

後者は**可変列だけ**が残る。`finishRun` が書く9列——`status` / `finished_at` /
`exit_code` / `log_ref` / `tokens` / `artifacts` / `detail` / `error_kind` /
`actor_resume_after`——を書き換えられるので、予算の数え方（§7 の `max_actor_runs` /
`max_consecutive_failures`）を1件分ごまかせる。**不変列（`intent` / `actor` /
`role` / `worktree` / `attempt` / `started_at`）は `ownRunDrift` が突き合わせるので、
そのティックでは鳴る。** かつてここは行ごと落ちており、`role` を `review` へ
書き換えるだけで実装役が自分のレビューを承認できた（上の本文）。届く範囲は
「予算1件分」では済んでいなかった。

**ただし鳴るのは書き換えたティックだけになり、(c) と同じ形の穴が残る。**
そのティックは `ESCALATE(protected_path_touched)` で `WAITING_HUMAN` に落ちるが、
書き換えられた行は DB に残る。次のティックではその行が `ownRunIds` から外れて
射影の内側に入るので、前後で差が出ず鳴り止む。止まった Goal を人間が掃除しない
まま回し続ければ、`role='review'` の行はそのまま残り、次のティックの
`latestReviewRun` はそれを選ぶ。**関門が保証するのは「人間に1度届くこと」までで、
改竄を取り消しはしない。**（`tests/controller-state-db-writes.test.ts` の
「鳴るのは書き換えたティックだけになる」がこの2周を固定する。）

ファイルの側は、**存在と inode を見るので、消去（`rmSync`）と差し替え（unlink して
同じパスに別のファイルを置く形）は鳴る**。残るのは、開いたままのコネクションから
見える中身を変えない破損になる。

(i) 無効化した git の設定を、Actor がコマンドラインで名指しで書き戻せる。
`GIT_CONFIG_COUNT` の組は `-c` より先に読まれるので、
`git -c credential.helper=osxkeychain ls-remote <private repo>` は実測で通る
（§7 の資格情報の節）。`GIT_SSH_COMMAND` も `-c core.sshCommand=ssh` で戻せるし、
`GIT_CONFIG_COUNT=0 git ...` とインラインで置き直す形もある。**綴りを数え上げる
拒否リストでは塞げない**——`git` で始まらない形にできるうえ、helper の名前は
system の gitconfig を読めば分かる。塞げたのは周囲の環境から黙って届く経路で、
Actor が意図して書き戻す形は残る。ここから先は、keychain の資格情報を
そもそも読めない別ユーザ・別サンドボックスで Actor を動かす話になる。

(c) と (d) は逆向きのトレードオフで、どちらも検知を永続化するか
Actor プロセスと編集を紐付けないと同時には解けない。MVP では両方残す。

### 10-7. Notion / Slack を足す時期

実環境ができてから足す。

### 10-8. ~~`require_human_approval` にパス条件をどう載せるか~~（一部）

Phase 3 の4本目で確定した。
enum には載せず、`policies.protected_paths`（glob の配列）を別に持つ。
enum の6値は「操作の種類」で、パスは「対象」なので軸が違う。1つの enum に混ぜると
controller 側の照合が分岐だらけになる。

**Goal YAML のスキーマ変更の移行方針は未決のまま。** Phase 3 で2回
（`budget.max_unchanged_reconciles` と `policies.protected_paths`）変更し、
どちらも既存 YAML 8〜9本を手で書き直した。`version: 1` は literal で固定したままで、
Goal が増えたときに同じやり方は続けられない。

**同じ問題は宣言の値にもある。** レビューで `protected_paths` を広げたとき、
書き直したのは自己ホストで実際に回す2本だけで、完了済みの9本は `[]` のまま残した。
`[]` でも `PROTECTED_PATH_FLOOR`（§7）は掛かるので、関門が丸ごと外れた Goal は
無い。未決として残っているのは、**下限より広い分をどこに置くか**になる。
再実行しない Goal に手を入れても差分が増えるだけだが、「どの Goal がどこまで
守られているか」は YAML を1本ずつ読まないと分からない。既定値をどこに置くかは
まだ決めていない。

### 10-9. ~~VERIFY をどこで流すか~~（一部）

Phase 3 の5本目で `repoRoot` から Goal 専用の worktree に
変えたが、規則が「worktree があればそちら」という暗黙のものになっている。
Goal YAML から指定できる方がよいかは決めていない。1ティック目は worktree が
無いので `repoRoot` を見る、という非対称も残る。

**役割が増えても、見るのは実装役の作業ツリーに固定する**（§4.2）。`verifyRoot` は
場所の規則を直書きせず `worktreeNameFor(goal.id, 'implement')` を通す。2箇所に書くと、
規則が変わったときに検証だけ別の作業ツリーを見ていても誰も気づけない。
`investigate` の作業ツリーで criteria を検証すると、実装が1つも入っていない
作業ツリーの結果を実装の検証結果として読むことになる。

**より大きな未決は、検証コマンドを controller の権限で実行していること。**
worktree で `mise run test` を流すということは、worktree の `mise.toml` が
何を実行するかを決める、ということでもある。検証系を `protected_paths` に入れて
（§7）Agent に書き換えさせないようにしたが、これは「書き換えを検知して止める」
統制であって、実行そのものの隔離ではない。本筋はネットワーク遮断・トークン非注入の
サンドボックスで流すことで、MVP の範囲には入れていない。

### 10-10. トークンから金額をどう出すか

記録しているのは4種類の合計だけで、正確な
金額は出ない（§9 の実測を参照）。内訳は生ログにあるので、§7 の「従量課金だったら
いくらだったか」を出すには、そこから読む口が要る。

### 10-11. ~~「Actor が commit する」という前提を誰が確かめるか~~

確定した。
**いまはその前提そのものを置いていない。** 機械側の criteria が通ったティックで
**controller が commit する**（下の「前提を置くのをやめた」）。確かめる側の話は
その下に残す。commit されなかったときの受け皿として、いまも効いている。
**順序は、保護パスの関門 → controller の commit →（commit されなかったときだけ）
未 commit の関門になる。**

controller が ACT の外側で確かめ、**未 commit の変更が残っていることを確かめたら**
`ESCALATE(uncommitted_changes)` にする。確かめられなかったティックは違反にしない
（下の「材料」を参照。§10-6 の `guard_unavailable` とは倒す向きが逆になる。
あちらは関門そのものが動かなかったので止める側に倒すが、こちらは
材料が欠けたティックでは criteria も揃わず、止めるべき `COMPLETE` に届かない）。

**実際に踏んだのは次の経路になる。** push が送るのは commit 済みの差分だけ
（`git push -u origin HEAD:<branch>`）なのに、
VERIFY は worktree の**作業ツリー**を見る。Actor が実装を書いたまま commit しないと、
ローカルの criteria は全部 passed になるのに remote には何も出ない。controller からは
「ローカルは通っているのに PR だけが古い」に見え、`WAIT(review_pending)` を選んで
`WAITING_HUMAN` で止まった。人間が待っているのは実装が載った PR なので、
この待ちは永久に終わらない。

**これまでの断線と壊れ方が違う。** push も VERIFY も DECIDE も契約どおりに
動いていて、誰も誤った動きをしていない。足りなかったのは「Actor が commit する」
という前提をどこも要求していないことで、前提が満たされたかを確かめないまま
満たされていることにして先へ進む形になっていた。§3.1 が Fact について避けたかった
構図が、Fact ではなく前提の側で起きたことになる。

**関門を置くのは、書き残しを解消しないと分かっているティックに限る。**
その形は `COMPLETE` と `WAIT` と `VERIFY` の3つになる。前の2つは「機械側にやることは
残っていない」と言い切るティックで、前者は終端であとから取り消せず（§4.4）、
後者は次のティックまで機械側が何もしない。`VERIFY` は criteria のコマンドを流すだけで
worktree に1行も書かないので、やることは残っていても**残っているやることが書き残しを
解消しない**。判定は `leavesWorkUncommitted`（`src/domain/guard-rules.ts`）が正になる。
いずれのティックでも、worktree に
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
（`worktreeBranchFor`）と一致するときだけ見る。**役割が増えた（§4.2）ので、
突き合わせる相手は `worktreeNameFor(goal.id, 'implement')` の
ブランチだと明示する。** `local.*` を観測するのも criteria のコマンドを流すのも
実装役の作業ツリーで（§10-9）、push されるのもそのブランチになる。ここを
`investigate` 側に向けると、実装が1つも入っていない作業ツリーを見ることになり、
実装役が書き残したものは見落とす。人間に案内する worktree のパスも同じ役割に揃える。
「Run が1件でもあれば worktree を観測している」は代理にならない。`act` は
`worktree.ensure` より先に Run(starting) を
書くので、worktree を作れずに失敗した Run が1本あるだけで `verifyRoot` は
controller 自身のリポジトリに落ちたままになり、人間の編集を Actor の書き残しと読む。

**逆向きの誤検知を2つ避ける。** 実装の途中で作業ツリーが汚れているのは正常なので、
Gap が残っているティックは進む。ただし理由は「Gap があれば関門を通らない」では
**ない**。Gap があるティックは LLM に渡り、LLM は `WAIT` を返せて、その `WAIT` は
ここで止まる。関門を通らないのは `ACT` / `REPLAN` に落ちたティックで、
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
**この関門は publish の前で判断を差し替える**ので、`ent get` の `decision.rationale` と
PR の進捗コメントは同じ文字列を出す。ここが人間に届く唯一の説明になる。
publish の後ろで差し替える `policies.publish` の関門（§7）だけがこの規約から外れ、
PR に出す分を別に書いている。
push まで止めるのは保護パスの関門と `policies.publish.push_branch`（§7）の2つで、
こちら（未 commit の関門）は止めない。commit された分は remote に出てよい。

**その「出てよい」を実際に出せるようにするため、push の機会を Actor の実行から
外した。** この関門の解決手順は人間が commit することで（controller が commit するように
なったいまは、ここへ落ちるのは commit が成立しなかったティックに限る）、**その commit には
Run が付かない。** `publish` は「完了した Run が無いティックでは push しない」を条件に
していたので、人間が片付けた差分は remote に出ないまま残った。PR が立ったあとの
DECIDE は `WAIT(review_pending)` を選び続けて次の ACT も来ないため、ローカルは
全部緑なのに remote には仕様テストだけが載って CI が赤い状態で固まる
（`use-ent-in-any-repository` / PR #34 が実際にこれで止まった）。いまは Run の
有無と結果に関わらず push する。送るのは依然として commit 済みの差分だけなので、
失敗した Actor の書きかけは乗らない。押す先は `run.worktree` ではなく
`worktreeNameFor(goal.id, 'implement')` に固定する。Run が無いティックでは
`run.worktree` が読めないうえ、押す木を Run 側に従わせると、この関門や VERIFY が
見ている木と push 先がずれても誰も気づけない。

**`intent` に commit を含めるのは代わりにならない。** 原因を細くする向きとしては
正しいが、intent は LLM が生成するので「書いた」ことは確かめられても「従った」ことは
確かめられない（§3.2）。従わなかったティックは、やはり黙って `WAIT` に落ちる。
検証に還元できるのは controller 側の検知だけになる。

**これは実測で確かめた。** Actor の生ログを3本読み比べたところ、同じモデル
（`claude-opus-5[1m]`）・同じ `permissionMode`・どれも `subtype: success` で
打ち切られていないのに、**commit したティックとしなかったティックの両方が出た。**
commit した側は `git log -3 --format='%s%n%n%b---'` で既存のコミットメッセージの
書き方まで調べてから commit しており、誰にも言われずにそこまでやっている。
しなかった側は commit について何も述べていない。そのうちの1本は intent に
**「修正を push する」と明示されていた**。プロンプトの側も commit を求めておらず、
役割共通の末尾（`COMMON_TAIL`）が「push も含めて controller が行う」と書いている。
つまり commit していたのは指示されたからではなく Actor がそう判断したからで、
判断なので run ごとに変わる。**仕組みとして担保されていたことは1度も無かった。**

**前提を置くのをやめた。** 機械側の criteria が通ったティックで、controller が
Actor の書いたものを commit する（`WorktreePort.commit`）。判定は
`machineCriteriaSatisfied`（`src/domain/guard-rules.ts`）の純ロジックで、
保護パスの関門を通ったあと・publish の前に置く。関門が止めたティックでは
commit しない。違反した変更を履歴に載せると、あとから通常の変更として流れる
余地が生まれる（§10-6 が push を止めているのと同じ理由）。

**見るのは `command` 型の criteria だけにする。** `fact` 型には
`github.ci.conclusion` のように push されて初めて決まるものがあり、それを
commit の前提にすると「commit しないと CI が回らず、CI が通らないと commit
しない」で閉じる。`human` 型は定義上ここでは決まらない。実質は「push しなくても
確かめられる criteria が全部通ったら commit する」になる。`command` 型が1本も
無い Goal では commit しない。機械側で確かめたものが1つも無いのに commit すると、
Actor が書いただけのものが commit 済みとして push される。

**commit したティックでは未 commit の関門を見ない。** `local.dirty` は commit より
前の観測なので、読むと自分が片付けた汚れで自分を止めることになる。
何も commit されなかったとき（gitignore されたファイルだけが汚れている、commit
そのものが失敗した）は、これまでどおり関門が鳴る。**外したのではなく、鳴る条件が
1つ減っただけになる。**

**残る穴。** 検知するのは「commit されていない」までで、「commit された内容が
実装であること」は見ていない。Actor が空の commit を積めば関門は鳴らない。
そこは CI（`github.ci.conclusion`）と `type: human` の criterion が受け持つ。

### 10-12. タスク分解をどの粒度で持つか

方針を決めた。**分解した1本ごとに Goal を立て、
Goal 間に依存を宣言する。Goal の下に Task 層は切らない。**

**順序を宣言する側は入った。** `goal.depends_on`（`src/domain/goal.ts`）に id を
並べると、依存がすべて COMPLETED になるまで `tick` が回らない。判定は
`dependencyGate`（`src/domain/guard-rules.ts`）の純ロジックで、`resume_after` と
同じく **lease を取らずに** 入口で return する（理由は下の「依存の判定の置き場」）。

**分解そのものを機械が行う側も入った。ただしティックの外だけになる。**
`ent plan`（`src/usecase/plan.ts`）は分解したいことを散文で受け取り、planner を1回呼んで、
repoRoot の `.goals/` に N 本のサブ Goal の宣言を書く。順序は `depends_on` に入る。叩くのは
人間で、書くのは宣言部だけになる——実行時状態も Goal の行も、`DRAFT` すら作らない。
承認点は `ent start` のまま変わらない（§3.2）。

**ティックの中は何も変わっていない。** controller は書かれた順序に従うだけで、粗いタスクを
自分で割ることはしない。§1 が「タスク分解も controller が決める」に但し書きを付けているのは
ここが理由になる。Phase 2 を4本、Phase 3 を5本に割ったのは人間の判断になる（§8）。

**二択だった。** (a) サブ Goal + 依存の宣言、(b) Goal の下に Task 層（§4.5 の `Plan / Task`）。
**コストの差ではなく成果物の形の差で決めた。** どちらも `PROTECTED_PATH_FLOOR` の
中を触るので、**どちらも ent 自身には実装させられない**。(a) は `goalSchema`
（`src/domain/goal.ts`）に依存の宣言を足し、依存が揃うまで進めない規則を guard に
置く。(b) は `guardBaseOf`（`src/domain/guard-rules.ts`）が Task 単位の base を
返す形になる。`src/domain/goal.ts` と `src/domain/guard-rules.ts` はどちらも下限に
入っている（全量は定数を正とする。§7）ので、`close-the-review-findings.yaml`
（§9 の「完了後のレビュー」で見つかった指摘を閉じる Goal。実装は ent の外側で行うと
宣言してある）と同じく、ent の外側で人が書く作業になる。「片方だけ自己ホストできる」
という差は無い。

決め手は、**1つの粗いタスクに対して人間が何本の PR をレビューするか**にした。
(a) は N 本、(b) は1本になる。(b) を採ると、いま揃っている
1 Goal = 1 worktree = 1 PR = 1 lease が全部 Task 単位に割れる。`GoalState` が
`leaseOwner` / `prNumber` / `guardBaseSha` を Goal の行に持ち、関門も push 先も
そこに乗っているので、§5 の「1ティックで起動する Actor は1体、Decision は1ティックに
1行」まで見直しになる。関門が立っている土台なので、動かすなら分解より先に関門を
作り直すことになる。(a) はこの揃い方を1つも崩さない。

**その帰結として、`design`（あるいは `plan`）を `ActorRole` に足さない。**
(a) の分解の成果物はサブ Goal の宣言、つまり `.goals/*.yaml` になる。`.goals/**` は
`PROTECTED_PATH_FLOOR` にあるので、**Actor が書いた瞬間に関門が鳴る**。役割を
足しても、その役割が出すべき成果物を出せない。§4.2 の3つの role は「worktree で
何かを書く・読む」ための区分で、宣言部を書くことはそこに属さない。役割の宣言だけを
先に置くと、`review` が配線済みのまま起動されずに残っているのと同じ形になる。

分解を機械にやらせるなら、置き場は Actor ではなく controller 側になる
（**以下この経路を planner と呼ぶ。`ActorRole` ではない**）。Gap の
埋め方を LLM に委ねるのは §3.5 の境界の内側なので、`LlmPort` を1回呼んで
（トークンは `LlmCall` に残る）サブ Goal の宣言を repoRoot に書く形になる。
**worktree に書かせない。** 実装役の作業ツリーに `.goals/*.yaml` が現れると、
毎ティック `protected_path_touched` になる（§10-6 が1度踏んだ形と同じ）。
**その経路を採ると `.goals/*.yaml` は §4.6 の「人間が編集」から外れ、§3.2 の
「YAML のレビューが承認ゲート」も人間が書いた分にしか掛からなくなる。**

**ここは planner に書かせる側で決め、その半分は入った。**
`ent plan` で機械に書かせないのは `repository` / `policies` / `budget` の3つになる。
リポジトリの識別子は `git remote` から読む（捏造された owner は、最初のティックで
GitHub の 404 としてしか表面化しない）。関門を持つ2つは `ent init` の雛形と同じ値を写すので、
機械が書いた Goal だけが緩いところから始まることはない。そして集合まるごと——スキーマ、
既存の宣言との id 衝突、指す先の無い依存、集合と既存をまたぐ循環——を**1本も書く前に**
検証するので、落ちた集合は `.goals/` を半分書き換えた状態ではなく、そのままの状態を残す。

**まだ入っていないのは、ループを回している最中に planner が YAML を書き換える側になる。**
計画を直す必要が出るのは回している最中なので、それが無いと `REPLAN` は「もう一度考える」だけで
終わる。repoRoot 側の関門は ACT の前後の差だけを数える（§10-6）ので、DECIDE で書く分が
違反にならない読みになるが、**そこは経路を作るときに確かめる。** `ent plan` はその読みを
確かめていない。ティックの外で完結するので、見ている関門がそもそも無い。

**`ent plan` が使ったトークンは DB に持たない。** `llm_calls.goal_id` は
`NOT NULL REFERENCES goals(id)` で、plan の時点では Goal の行がまだ1つも無い。入れるために
架空の Goal を作ると、どの YAML も宣言していない Goal が `ent list` に出る。代わりに生ログ
（`runs/plan-<時刻>/log.jsonl`、§4.6）とコマンド自身の出力に残す。つまり**どの Goal の
budget にも数えられない**。§7 の会計に開けた穴で、抑えているのは「毎回人間が叩く」ことだけになる。

書ける範囲を宣言の一部に絞る——人間が書く分と planner が書く分を別のパスに
置く——案は**採らない**。関門はパスでしか効かない（`findViolations` が突き合わせるのは
git が観測した変更パスと glob）ので、同じファイルの中で「`desired_state` は書いてよいが
`acceptance_criteria` はだめ」を表現するには YAML の意味差分を取る別種の関門が要る。
それに見合う防御にならない。**criteria の完全性は元から絶対ではない**からで、
§7 が `tests/**` を下限に入れないと決めている以上、criteria の文字列を凍らせても
「確かめる中身」の側は開いている。planner には報酬信号も持続する目的関数も無く、
塞いでも得るものが薄い。

**守りたいのは偽装の防止ではなく、バーが動いたことに人間が気づけることになる。**
`acceptance_criteria` / `policies` / `budget` の指紋を `ent start` で1回だけ記録し
（置き方は `guardBaseSha` と同じ）、変わっていたら `AWAITING_CRITERIA_APPROVAL` に
落として人間に返す形が、いちばん安い。この状態は §4.4 が型に残したまま
「書き込むコードは無い」と書いているもので、受け皿がそのまま空いている。
LLM を呼ばないので決定論のままになる。ただし §4.4 の図に ACTIVE から戻る辺は無く、
`nextStatus` にもこの値を返す Action が無いので、辺を1本足すことになる。

**いまは作らない。** 実際に回してみて、planner が勝手に criteria を書き換える場面が
多いと分かってから入れる。理由が2つある。**1つは、捨ててしまえない側の理由。**
criteria が動いたことに気づけないと §3.2 の承認ゲートが形式だけになり、§4.5 の
Decision の履歴からも「収束したのか、バーが下がったのか」を区別できなくなる
（L5 が読むのはその履歴になる）。構造としては §10-11 の `intent` と同じで、
**確かめる対象を、確かめられる側が生成している**。悪意ではなく drift の話で、
ループの中から見れば「計画を改善する」と「達成できる基準に書き直す」は見分けが
つかない。**もう1つは、いま置けない側の理由。** 頻度が分からないうちに関門を先に
置くと、正当な計画の修正のたびに人間を呼ぶ側の失敗をする。

なお指紋が答えるのは「criteria が途中で動いたか」までで、**機械が新しく書いた
サブ Goal を誰が承認するか**は比べる相手が無いので答えられない。そちらは
`ent start` を打つ時点が人間の承認点になり、§3.2 のままになる。

**依存の判定の置き場は `tick` の入口にした**（§10-5 の `resume_after` と同じ位置）。
`ent start`
の入口で「ACTIVE にしない」形にすると、依存先をまだ start していない順序で宣言を
書けなくなる。分解したサブ Goal をまとめて登録する使い方がそれに当たる。
**lease は取らない。** 並べる本数を決めるのは呼び出し側なので（README「複数の Goal を
同時に回す」）、依存待ちの1本が枠を持ち続けると、進める側の Goal まで cron の1周で
回らなくなる。

**依存待ちのあいだも `activated_at` は立っている。** `ent start` は `DRAFT` から
`ACTIVE` に直行する（§4.4）。依存関門が`skipped`を返し続ける間は予算判定そのものへ
到達しないため、循環依存では`max_wall_clock`でも止まらない。依存が解消した次のティックでは、
依存待ちがDecisionの`WAIT`ではないため待機時間を差し引けず、`activated_at`からの時間を
含めて`max_wall_clock`を評価する。まとめて登録するときは、後続のGoalに長めの上限を書く。

**依存先が終端に落ちた場合は、待ちと分けて数える。** `dependencyGate` は
`pending`（まだ COMPLETED でない。待てば進む）と `unreachable`（`FAILED` /
`ABANDONED`。待っても解けない）を別に返す（この `pending` は依存の分類で、§3.1 の
`Unresolved` の `pending` とは別物になる。あちらは1回の観測・検証の結果、こちらは
Goal 間の順序を指す）。後者では次の一手——依存側をやり直すか
`depends_on` を書き換えるか——まで `skipped` に書く。**登録されていない依存は
`pending` に入れる。** `ent start` を打ち忘れただけかもしれないので、無いことを
「もう終わらない」とは読まない（§3.1）。

**依存の関門に残っている穴が2つ。** 1つは、止まった理由が状態に残らないこと。
lease を取らない
以上その場では書けないので、いまは `ent run` の `skipped` にしか出ない。§4.4 の
待機に理由を足して残す形にするかは決めていない。もう1つは循環で、`depends_on` に
自分自身を書くのはスキーマが弾くが、2本以上をまたぐ循環は Goal YAML 1本からは
見えないので、全員が `pending` のまま止まる。

**回す前に読む側は塞いだ。**
`ent doctor` に `dependencies` の検査があり、宣言を全部読める立場から循環と
「依存先の `.goals/<id>.yaml` が無い」を名指しして failed にする（`src/usecase/doctor.ts`）。
菱形（`alpha → base` と `bravo → base`）は閉じていないので循環として数えない。
**それでも実行時には依然として掛からない。** doctor は読むだけで、`dependencyGate` は
循環を今までどおり `pending` として返す。doctor を叩かずに `ent run` を回せば、
lease も取らず何も書かないティックが続き、`max_reconciles` にも `max_wall_clock` にも
当たらないまま止まり続ける。実行時に止めるなら `dependencyGate` に
`unreachable` をもう1種類足す話になるが、そこは `PROTECTED_PATH_FLOOR` の中で
ent 自身には書かせられない。**読むだけで足りる分を先に取ってある。**

Plan / Task テーブルは**作らないと決めた**（§4.5 の表もそう直した）。(a) では
Plan にあたるものがサブ Goal の宣言そのものになるので、DB に別の層を作る理由が無い。

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
- **ドキュメント**: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- **ドキュメント**: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
