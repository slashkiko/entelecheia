import { z } from "zod";

/**
 * OBSERVE が返しうる観測キーの一覧。
 *
 * Phase 0 で最初に詰まったのがここだった。テストは `local.head_sha` を要求するのに
 * Port の型は `headSha` で、対応表がコードにもドキュメントにも無かった。
 * Goal YAML だけを渡された実装者は当てられない。
 *
 * キーを Goal YAML 側に書かせる案もあったが、観測キーは Goal ごとに変わらず
 * OBSERVE の実装が決めるものなので、レジストリはコード側に置く。
 * Goal YAML は `verification: { type: fact, key: ... }` でここを参照するだけにし、
 * 実在しないキーは Zod が弾く。
 *
 * 命名規則:
 * - ドット区切りの小文字 snake_case
 * - 第1セグメントは観測元（`local` / `github` / `review`）。`review` だけは外部の
 *   サービスではなく、controller 自身が起動した Actor の実行が出どころになる
 * - 第2セグメント以降は論理リソース（`pr` / `ci` / `issue`）とその属性
 * - Port の camelCase フィールド名はここで snake_case に変換される
 */
export const observedFactKeySchema = z.enum([
  // LocalRepoPort.snapshot()
  "local.branch",
  "local.head_sha",
  "local.dirty",

  // CodeProviderPort.getPullRequest()
  "github.pr.number",
  "github.pr.state",
  "github.pr.head_sha",
  "github.pr.mergeable",
  "github.pr.review_decision",
  "github.pr.requested_reviewers",
  /**
   * PR のタイトルと本文。
   *
   * 他の `github.pr.*` と違い、完了判定のためではなく**レビュー役に渡すため**に
   * 観測する。レビュー役の Actor には資格情報を渡していない（`WITHHELD_ENV`）ので
   * `gh` は未認証で、「宣言部の制約が PR 本文に反映されているか」のような観点は
   * 向こう側では永久に確かめられない。足りないのは資格情報ではなく、controller が
   * 既に読んでいる情報を渡す口になる。読むのは controller、渡すのはその結果だけ、
   * という分担は変えない。
   *
   * 本文は空でありうる。GitHub は本文の無い PR に `null` を返すので、Fact の値も
   * `string | null` になる。**`null` は「本文が空だと観測できた」であって
   * 「取れなかった」ではない。** 取れなかったティックは Fact を作らず、
   * `unobserved` に理由付きで残る（design.md §3.1）。
   */
  "github.pr.title",
  "github.pr.body",
  /**
   * 未解決のレビュースレッドの件数（issue #64 の案1）。
   *
   * `github.pr.review_decision` では自動レビュー bot の指摘を拾えない。bot の
   * レビューはたいてい COMMENTED で出るので、`reviewDecisionOf` の導出（承認でも
   * 変更要求でもない）では `REVIEW_REQUIRED` のまま動かない。件数があれば
   * Goal YAML が `verification: { type: fact, key: github.pr.unresolved_threads,
   * equals: 0 }` と書けて、bot の指摘が収束条件になる。
   *
   * **`0` も観測できた結果として Fact にする。** ここが収束条件そのものなので、
   * 0 を falsy として落とすと `equals: 0` は永久に成立しない。逆に「件数を
   * 確かめられなかった」を 0 と読むと、指摘を残したまま収束する。後者は
   * Port が null を返し、observe が Fact を作らないことで表す（§4.3）。
   *
   * 引き継ぎにも注意が要る。件数を読めなかったティックでは、前ティックの値が
   * VERIFIED のまま残らないように `expireStaleFacts`（`src/reconcile/index.ts`）が
   * 落とす。詳しくは design.md §4.3。
   *
   * **criteria に書く前に、誰がこのキーを 0 にするのかを決めること。**
   * このリポジトリには、レビュースレッドを解決する（`isResolved` を false → true に
   * する）書き込み経路が無い。GitHub 側の書き込みは GraphQL の
   * `resolveReviewThread` mutation にしか無く、controller はそれを呼ばないし、
   * Actor には資格情報を渡していない（`WITHHELD_ENV`）。つまり
   * `{ key: github.pr.unresolved_threads, equals: 0 }` は、**いまのところ Actor が
   * 自力では満たせない criterion**になる。実質は人間のゲートだが、`type: human` と
   * 違って `WAITING_HUMAN` にはならない。Gap が残り続けたまま ACT の予算を消費し、
   * 最後は `max_unchanged_reconciles` の `loop_detected` で止まる。人間が受け取る
   * 停止理由が「レビューの解決待ち」を指さない、ということになる。
   *
   * この前提が変わりうる点を1つ**確かめていない**。指摘された行が後続のコミットで
   * 変わり、GitHub がそのスレッドを outdated にしたとき、`isResolved` が自動で
   * true になるのかどうかは検証していない。自動で true になるなら Actor が
   * コードを直すだけで件数が減りうるが、**確かめていないので前提にしない。**
   */
  "github.pr.unresolved_threads",

  // CodeProviderPort.getLatestCiRun()
  "github.ci.status",
  /**
   * head sha に紐づく**最新の workflow run 1本**の結論。
   *
   * **新しい Goal の criteria には使わない。** workflow を複数持つリポジトリでは、
   * lint の run が落ちていても test の run が後から success で終われば
   * `equals: success` が通る（issue #58）。「この head sha で落ちている job が
   * 1つも無い」を書きたいなら `github.ci.failed_job_count` を使う。
   * `repository.ci.exclude_workflows` の除外が効くのもそちらだけになる。
   *
   * 既存の Goal がこのキーで書かれているのは、`failed_job_count` より先に
   * あったからで、意味が正しいからではない。消さないのは、回っている Goal の
   * 判定を後から変えないため。
   */
  "github.ci.conclusion",
  "github.ci.failed_jobs",
  /**
   * head sha に紐づく**全 workflow run**を横断して数えた、落ちている job の数。
   *
   * `github.ci.conclusion` とは見ている範囲が違う。あちらは最新の run 1本の結論で、
   * workflow を複数持つリポジトリでは lint の run が落ちていても test の run が
   * 後から success で終われば `equals: success` が通る（issue #58）。
   * 「この head sha で落ちている job が1つも無い」は
   * `{ key: github.ci.failed_job_count, equals: 0 }` の側で書く。
   *
   * `github.ci.failed_jobs` があるのに数を別に持つのは、`verification.type: fact` の
   * `equals` が `string | number | boolean` しか受けず、「配列が空」を書けないため。
   *
   * **0 は観測できた 0 で、未観測ではない。** 1件以上のときだけ push する
   * `failed_jobs` の形をここで真似ると `equals: 0` が永久に届かない。逆に、まだ
   * 回っている run が1本でもあるあいだは Fact にしない。実行中の run の
   * `conclusion` を Fact にしないのと同じ規則で、push した直後の「いま 0 件」を
   * 掴ませないため。
   */
  "github.ci.failed_job_count",
  /**
   * `repository.ci.exclude_workflows` で数から外した workflow と、実際に外した run の数
   * （`[{ name, runs }]`）。**宣言があるときだけ観測に出る。**
   *
   * このキーが Fact として出ているかどうかが、そのまま「除外したかどうか」になる。
   * `failed_job_count=0` を出しておいて何を外したかを言わないと、「落ちている job が
   * 1つも無い」と「外した上で1つも無い」が同じ見た目になる。**issue #58 が直そうと
   * したのは、まさにその読み違いだった。**
   *
   * `runs: 0` は「書いたのに何も外していない」。typo かもしれないし、今回は起動
   * しなかった workflow かもしれない。観測の側から区別できないので、弾かずに数を出す。
   */
  "github.ci.excluded_workflows",

  // CodeProviderPort.getIssue()
  "github.issue.number",
  "github.issue.state",
  "github.issue.labels",
  "github.issue.linked_pr",

  // レビュー役の Actor の Run から作る（design.md §4.2 の `role: review`）。
  //
  // 第1セグメントが観測元の規則からは外れて見えるが、外れていない。出どころは
  // GitHub でもローカルの git でもなく、この controller が起動した Actor の実行
  // そのものになる。`github.pr.review_decision` とは別物で、あちらは GitHub 上の
  // 人間（または bot）のレビュー、こちらは controller が回したレビュー役の結論。
  //
  // 作る側は `ReviewPort`（`src/observe/index.ts`）になる。`role: review` で
  // 走った Run の生ログから最終メッセージを読み、observe がそれを Fact にする。
  // **Actor が言った文字列はまだ Fact ではない。** 形が読めなければ Fact を
  // 作らず、理由を付けて unobserved に残す（design.md §3.1）。レビューを
  // 回していないティックで値を捏造しないのも同じ規則で、Port が null を返す
  // あいだは Fact も unobserved も作らない。
  //
  // 参照する側は Goal YAML の
  // `verification: { type: fact, key: review.verdict, equals: approved }` で、
  // Fact が無い間は Gap が残るので COMPLETE には届かない。レビューを完了条件に
  // するかどうかは criteria が決めるのであって、guard には条件を足さない。
  /** レビュー役の結論。`approved` か `changes_requested` */
  "review.verdict",
  /**
   * その結論がどの commit を読んだ結果か。
   *
   * verdict だけでは、いつの時点のコードのレビューか分からない。実装が進んだ
   * あとの Fact をそのまま完了判定に使わせないために、対にして残す。
   */
  "review.reviewed_sha",
]);
export type ObservedFactKey = z.infer<typeof observedFactKeySchema>;

/**
 * 名前で参照する必要があるキー。
 *
 * OBSERVE が作り、VERIFY が突き合わせ、DECIDE が起動の可否を見る——この3つが
 * 同じ文字列を別々に書いていると、片方の綴りを直しただけで照合が黙って
 * 成立しなくなる。「レビュー済みの commit が HEAD と同じか」という判定は
 * 3箇所とも同じ2つのキーを読むので、レジストリ側から名前を配る。
 */
export const REVIEW_VERDICT_KEY = "review.verdict" satisfies ObservedFactKey;
export const REVIEW_REVIEWED_SHA_KEY = "review.reviewed_sha" satisfies ObservedFactKey;
export const LOCAL_HEAD_SHA_KEY = "local.head_sha" satisfies ObservedFactKey;

/**
 * レビュー役に渡す PR の本文。OBSERVE が作り、`act` が読んで Actor へ載せる。
 *
 * 名前で配るのは `REVIEW_VERDICT_KEY` と同じ理由になる。作る側（observe）と
 * 読む側（act）が別々に文字列を書いていると、片方の綴りを直しただけで
 * レビュー役への受け渡しが黙って止まる。止まっても Fact は作られ続けるので、
 * 「渡っていない」ことに気づく手段がプロンプトの目視しか無くなる。
 */
export const GITHUB_PR_TITLE_KEY = "github.pr.title" satisfies ObservedFactKey;
export const GITHUB_PR_BODY_KEY = "github.pr.body" satisfies ObservedFactKey;

/**
 * レビュー役が返してよい結論。ここに無い語は Fact にしない。
 *
 * `src/adapters/claude.ts` のレビュー役のプロンプトが求める2値と同じもの。
 * あちらは Agent への指示で、こちらは観測側の受け入れ条件になる。指示に
 * 従わなかった出力を「だいたい approved」と読むと、捏造した承認ができる。
 */
export const REVIEW_VERDICTS = ["approved", "changes_requested"] as const;

/**
 * VERIFY が criteria の結果を書き出すキー。
 *
 * criteria の id は Goal ごとに違うので列挙できない。
 * Goal YAML の `verification: { type: fact }` からここを参照させると
 * criteria 同士が循環しうるため、参照できるのは observedFactKeySchema 側だけにしてある。
 */
export function criterionFactKey(criterionId: string): string {
  return `criteria.${criterionId}.passed`;
}
