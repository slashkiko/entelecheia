import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActorInvocation,
  NOT_OBTAINED,
  PULL_REQUEST_SECTION,
  renderPullRequestText,
} from "../act/index.js";
import type { ActorRole } from "../domain/run.js";

/**
 * 役割ごとに Actor へ渡す指示。**provider によらず1組しか無い。**
 *
 * 以前は Claude Adapter と Codex Adapter がそれぞれ自分の複製を持っていた。
 * 中身は同じではなく、Claude 側にだけ semantic-review の読み替え表と判定の
 * 対応表と出力の契約があった。つまり provider を替えるとレビューの契約ごと
 * 替わっていて、外からは「同じレビュー役」に見える。分かれてよいのは
 * **skill の渡し方だけ**なので、それを引数（`SkillDelivery`）に落とす。
 */

/** どの役割でも同じ末尾。承認と公開は controller の側に残す。 */
const COMMON_TAIL = `Do not create PRs and do not post comments. The controller does that, push included.
Writing the approval phrase (/ent approve) is not permitted for any reason.`;

/**
 * レビュー役に読ませる skill を入れた plugin の置き場所。
 *
 * パスは `import.meta.url` から引く。cwd 基準にすると、ent は対象リポジトリの
 * ルートで叩かれる CLI なので（`repoRoot = process.cwd()`、src/cli.ts）、
 * 対象リポジトリ側の `plugins/` を見に行って外れる。`src/adapters/` からも
 * `dist/adapters/` からも、2つ上がリポジトリのルートになる。
 */
export const REVIEW_PLUGIN_DIR = fileURLToPath(
  new URL("../../plugins/ent-review", import.meta.url),
);

/** skill の名前。SKILL.md の `name` と、その置き場所のディレクトリ名を兼ねる。 */
export const REVIEW_SKILL_NAME = "semantic-review";

const REVIEW_SKILL_DIR = join(REVIEW_PLUGIN_DIR, "skills", REVIEW_SKILL_NAME);

/**
 * レビュー役へ `semantic-review` をどう届けるか。
 *
 * - `tool`: skill として渡し、Agent 自身に読ませる。Claude Code は SDK にも
 *   CLI にも「この plugin を読め」と1回の起動に対して言う口がある
 * - `inline`: 本文をプロンプトに差し込む。Codex CLI 0.147 には、repo の中の
 *   skill を指す口がフラグにも `-c` の config にも無い。残るのは
 *   `$CODEX_HOME/skills` と marketplace の plugin で、どちらもホスト側に
 *   状態を置く形になり、`--ephemeral` / `--ignore-user-config` と噛み合わない
 *
 * **観点そのものはどちらも同じ文章になる。** 渡し方が違うだけで、レビューが
 * 見るものを provider で変えない。
 */
export type SkillDelivery = "tool" | "inline";

/**
 * `inline` のときに差し込む本文。SKILL.md と `references/` の全ファイルを読む。
 *
 * **`references/` を列挙するのは、SKILL.md がそれらを名指しで読ませるため。**
 * 「Always read references/criteria.md」と書いてあるのに本文が無いと、観点の
 * 定義と偽陽性の規則が丸ごと落ちる。ファイルを足したときに黙って落ちないよう、
 * 名前を書き並べずディレクトリを読む。
 */
function reviewSkillDocuments(): { path: string; body: string }[] {
  const references = readdirSync(join(REVIEW_SKILL_DIR, "references"))
    .filter((name) => name.endsWith(".md"))
    .sort();
  return [
    { path: "SKILL.md", body: readFileSync(join(REVIEW_SKILL_DIR, "SKILL.md"), "utf8") },
    ...references.map((name) => ({
      path: `references/${name}`,
      body: readFileSync(join(REVIEW_SKILL_DIR, "references", name), "utf8"),
    })),
  ];
}

/** skill をどう与えるかを述べる節。読み替えの表はこの後ろに続く */
function skillSection(delivery: SkillDelivery): string {
  if (delivery === "tool") {
    return `Invoke the \`${REVIEW_SKILL_NAME}\` skill with the Skill tool and follow its points and output
format.`;
  }
  const documents = reviewSkillDocuments()
    .map((document) => `<document path="${document.path}">\n${document.body}\n</document>`)
    .join("\n\n");
  return `The \`${REVIEW_SKILL_NAME}\` skill is inlined below, because this run has no way to load it as a
skill. Read it as if you had opened those files; the links between them point at the same
texts. Follow its points and output format.

${documents}`;
}

const IMPLEMENT_PROMPT = ({ intent }: ActorInvocation): string =>
  `${intent}

Work only inside the current directory. When you are done, state what you did in one paragraph.

${COMMON_TAIL}`;

/**
 * レビュー役の指示。
 *
 * 権限だけ分けてプロンプトが同じだと、レビュー役は編集を試みて拒否され続け、
 * ターンをそこに使い切る。読む側に何を求めるかを先に書いておく。
 *
 * 結論を1語に寄せるのは、`review.verdict`（src/domain/fact-keys.ts）に落とす
 * ときに、読み手が本文を解釈しないで済むようにするため。どの commit を読んだか
 * まで言わせるのは、実装が進んだあとの結論をそのまま完了判定に使わせないため。
 * ただし**ここで言わせた文字列はまだ Fact ではない。** Fact にするのは
 * 観測側の仕事で、確かめられなければ作らない（design.md §3.1）。
 *
 * ## 観点は skill が持ち、契約はこちらが持つ
 *
 * 何を見るかは `semantic-review`（`plugins/ent-review/`）に置いてある。あれは
 * ent の外でも使う汎用の skill で、**GitHub の PR を読む前提で書かれている。**
 * ent のレビュー役はそうではない——作業ツリーの中で HEAD を読み、`gh` には
 * 資格情報を渡しておらず、ネットワーク越しに何かを取りに行く口も持たない。
 * その差は下の読み替えの表で吸収し、**skill 側には ent の語彙を入れない。**
 * 別リポジトリへ切り出すときにコピーだけで済む形を保つ。
 *
 * ## PR のタイトルと本文は controller が渡す
 *
 * **レビュー役が自分で PR を読むことはできない**（資格情報を渡さない設計は
 * 変えない）が、controller は OBSERVE で PR を読んでいる。その結果だけを
 * `ActorInvocation.pullRequest` で受け取り、`renderPullRequestText` が組み立てた
 * 節をここに載せる。渡す口が無かったころは「宣言部の制約が PR 本文に反映されて
 * いるか」という観点が毎回「未取得」で終わっていた。
 *
 * **読み替えの表もそれに合わせて直す。** 渡す口だけ足して表を残すと、同じ
 * プロンプトが「PR は読めない」と「これが PR のタイトルと本文だ」を同時に述べる。
 * ただし**「宣言された意図」の一次情報は `.goals/<id>.yaml` のまま**にする。
 * PR 本文を意図の基準にすると、宣言部と食い違う本文を根拠に approved が出せる。
 * 本文はレビューの**対象**であって、判定の基準ではない。
 *
 * 出力の契約もこちらが持つ。skill の出力形式（末尾が `<sub>` のフッタ）に
 * 手を入れる必要は無い。観測側が求めているのは「`verdict:` の行が本文中に
 * ちょうど1つ」と「`reviewed_sha:` のラベル行」で、どちらも最終行である必要は
 * 無いため、skill の本文の**後ろに2行足す**だけで噛み合う
 * （`soleVerdictIn` / `soleShaIn`、src/observe/index.ts）。
 *
 * `INSUFFICIENT_CONTEXT` を `changes_requested` に寄せるのは、確かめられな
 * かったものを `approved` に倒せないため。ここで生む Gap は次のティックの
 * 実装役に渡るが、`.goals/**` は保護パスなので宣言部そのものは直せない。
 * その場合は保護パス違反か budget の枯渇で人間が呼ばれる——**黙って
 * 回り続けはしない。** 宣言部を `ent start` より前に commit しておけば起きない。
 */
const REVIEW_PROMPT = (
  { intent, goalId, pullRequest }: ActorInvocation,
  delivery: SkillDelivery,
): string =>
  `${intent}

You are running as the review role. **Do not modify files.**
Editing is not available to you, so any attempt is refused. Only read, and run commands
to confirm.

Work only inside the current directory.

## What to use

${skillSection(delivery)}

The skill is written on the assumption that it reads a GitHub Pull Request, but **here you do
not fetch the PR yourself.** The substitutions below take precedence over what the skill says.

| The skill's assumption | Substitution here |
| --- | --- |
| The target is a GitHub Pull Request | The HEAD of the current worktree, and its diff from the base |
| The PR title and body are the "declared intent" | The "declared intent" stays the desired_state, acceptance_criteria and context in \`.goals/${goalId}.yaml\`. The PR title and body are in the section below, observed and passed down by the controller, and are read as **the object of review, not the basis of intent** |
| Read tickets and discussions with gh or connectors | Unavailable. Confirm from inside the repository and the section below only, and write "${NOT_OBTAINED}" for whatever you could not get |
| Post it as a PR comment | Do not post. Return the body only |

\`gh\` has no credentials, and nothing can be fetched over the network. Do not try.
What can be confirmed about the PR is limited to what the section below carries.

## Steps

1. Run git rev-parse HEAD to confirm the commit you read
2. Read \`.goals/${goalId}.yaml\`. This is the primary source of the intent.
   Read the in-repository files listed in context.references as well.
   **If you cannot read it, do not evaluate point A, make the assessment
   INSUFFICIENT_CONTEXT, and write "the declaration could not be read" as the first
   must-fix item**
3. Read "${PULL_REQUEST_SECTION}" below. If it was passed down, check there whether the
   constraints in the declaration are reflected in the body. If it was not passed down,
   do not evaluate that point and write "${NOT_OBTAINED}"
4. Read the diff, and the places that diff can break. Run tests to confirm when needed
5. Write the review body with ${REVIEW_SKILL_NAME}'s points and output format
6. Append exactly these two lines to the end of the body

reviewed_sha: <the 40-hex sha confirmed in step 1>
verdict: <either approved or changes_requested>

The assessments map to verdicts as follows.

| semantic-review assessment | verdict |
| --- | --- |
| ALIGNED | approved |
| MISALIGNED | changes_requested |
| INSUFFICIENT_CONTEXT | changes_requested |

Do not write a line beginning with \`verdict:\` anywhere else in the body. Unless there is
**exactly one in the whole body**, it is not read as the conclusion. \`reviewed_sha:\` is
held to one for the same reason.

Do not write "no problem" about anything you could not confirm.

${renderPullRequestText(pullRequest ?? null)}

${COMMON_TAIL}`;

/**
 * 調べる役の指示。ツールはレビュー役と同じだが、結論の形が違う。
 *
 * レビュー役の文面を流用すると、調べただけの実行が `verdict:` の行を出す。
 * それを観測側が拾えば、レビューを回していないティックの approved になる。
 * 起動する側はまだ居ない（design.md §4.2）が、口を残す以上は分けておく。
 */
const INVESTIGATE_PROMPT = ({ intent }: ActorInvocation): string =>
  `${intent}

You are running as the investigate role. **Do not modify files.**
Editing is not available to you, so any attempt is refused.

Work only inside the current directory. State what you found and the evidence for it
(the files you read, the commands you ran and their output). Write that you could not
confirm what you could not confirm. Do not fill gaps with guesses.

${COMMON_TAIL}`;

/**
 * 役割ごとのプロンプト。
 *
 * 受け取るのは intent だけではなく invocation そのものにしてある。レビュー役が
 * 宣言部（`.goals/<goalId>.yaml`）を名指しするのに goalId が要り、役割ごとに
 * 何が要るかは今後も変わる。`delivery` を全役割の引数に置いてあるのは、
 * 役割で分岐せずに呼べるようにするためで、使うのはレビュー役だけになる。
 */
export const PROMPT_FOR: Record<
  ActorRole,
  (invocation: ActorInvocation, delivery: SkillDelivery) => string
> = {
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  investigate: INVESTIGATE_PROMPT,
};

export const JSON_ONLY = "Return only a JSON object. No preamble, no explanation.";

/** コードフェンスで囲まれていても読めるようにする */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body === "") {
    throw new Error("The LLM returned an empty output");
  }
  return JSON.parse(body) as unknown;
}
