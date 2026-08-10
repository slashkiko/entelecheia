import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import { worktreeNameFor } from "../act/index.js";
import { type ClaudeOptions, claudeActor, claudeLlm } from "../adapters/claude.js";
import { githubApproval, githubCodeProvider, githubCodeWriter } from "../adapters/github.js";
import {
  commandRunner,
  findGitRoot,
  ghAuthToken,
  gitBranch,
  gitWorktree,
  localRepo,
  pendingApproval,
  STATE_IGNORE_LINE,
  stateDirIgnored,
} from "../adapters/local.js";
import type { DoctorGoal, DoctorProbes } from "../cli.js";
import type { ControllerDeps } from "../controller/index.js";
import { errorMessage } from "../domain/error-message.js";
import type { Goal } from "../domain/goal.js";
import { loadGoalFile } from "../domain/goal-loader.js";
import { PortError } from "../domain/port-error.js";
import type { CodeProviderPort } from "../observe/index.js";
import type { CodeWriterPort } from "../publish/index.js";
import type { Store } from "../store/index.js";
import type { ApprovalPort } from "../verify/index.js";

/**
 * 合成ルート。**どの Port にどの Adapter を挿すかを決める唯一の場所**にあたる。
 *
 * `tests/architecture.test.ts` は `src/adapters/**` を import してよいファイルを
 * 1本に絞っている。Port 注入が意味を持つのは実装を選ぶ場所が1箇所しか無いときだけで、
 * ここが増えると、テストで差し替えたつもりの Port が本番では別経路から直接入ってくる
 * 状態を作れてしまう（design.md §3.3）。
 *
 * **その1本が `src/cli.ts` だったので、cli.ts に配線が溜まった。** 引数の解釈も
 * ユースケースも出力の整形も同じファイルに同居し、1,779 行になっていた。ルールが
 * 求めているのは「実装を選ぶ場所が1箇所」であって「その1箇所が CLI であること」では
 * ないので、合成ルートだけをここへ出す。cli.ts は Adapter を知らなくなり、
 * ここは引数の形も出力の形も知らない。
 *
 * `.goals` 側のパスの規則（`stateDir` / `worktrees` / `runs`）は design.md §4.6 が正で、
 * ここはそれを組み立てるだけにする。
 */

/**
 * ティックに渡す Port 一式。
 *
 * 通常のティックと `--dry-run` の両方から呼ぶ。以前は呼び出し側それぞれが
 * 同じ組み立てを書いていて、片方にだけ Port を足すと dry-run が本番と違う
 * 配管を見ることになった。dry-run の用途が「配管が繋がっているか」なので、
 * そこがずれると道具の意味が無くなる。
 */
export function tickPorts(
  goal: Goal,
  store: Store,
  repoRoot: string,
  stateDir: string,
): Omit<ControllerDeps, "store"> {
  const worktrees = join(stateDir, "worktrees");
  return {
    owner: `${hostname()}:${process.pid}`,
    leaseSeconds: 300,
    code: codeProvider(goal),
    writer: codeWriter(goal),
    branch: gitBranch(worktrees),
    local: localRepo(verifyRoot(stateDir, goal)),
    command: commandRunner(verifyRoot(stateDir, goal)),
    // 承認はレビュー承認と PR コメントの定型文の2つで検知する（design.md §10-4）。
    // PR がまだ無い Goal では常に未承認になる。捏造した承認を作らない。
    approval: approval(goal, store.getState(goal.goal.id)?.prNumber ?? null),
    worktree: gitWorktree(repoRoot, worktrees),
    worktreeRoot: worktrees,
    actor: claudeActor(claudeOptions(stateDir)),
    llm: claudeLlm({
      ...claudeOptions(stateDir),
      // 呼んだ直後に書く。ティックの最後にまとめて書くと、途中で kill された
      // ぶんのトークンが消える（design.md §7）。
      onCall: (call) => {
        store.recordLlmCall(goal.goal.id, call);
      },
    }),
    now: () => new Date(),
  };
}

/**
 * 関門の基準にする HEAD を読む（`GoalState.guardBaseSha`。design.md §10-6）。
 *
 * `ent start` の1箇所からしか呼ばないが、`localRepo` を選ぶ判断はここに置く。
 * cli.ts に `localRepo(repoRoot)` を1本残すと、Adapter を選ぶ場所が2つになる。
 */
export async function repoHeadSha(repoRoot: string): Promise<string> {
  return (await localRepo(repoRoot).snapshot()).headSha;
}

/**
 * `.gitignore` に書く1行。実体は `src/adapters/local.ts` にあり、
 * `stateDirIgnored` が無視できているかを判定するときの基準と同じものになる。
 *
 * `ent init` が書く側で、この2つがずれると「書いたのに無視できていない」状態を作る。
 * cli.ts からは Adapter を直接見せず、合成ルート経由で渡す。
 */
export { STATE_IGNORE_LINE };

/**
 * 対象リポジトリの git ルート。git のワークツリーの中でなければ null。
 *
 * `ent init` と `ent doctor` の両方が使う。判定そのものは git に聞く
 * （`src/adapters/local.ts` の `findGitRoot`）ので、Adapter を選ぶ判断はここに置く。
 */
export function gitRootOf(repoRoot: string): string | null {
  return findGitRoot(repoRoot);
}

/** 実際のファイルと環境変数を読む口。テストからは差し替える */
export function doctorProbes(repoRoot: string, stateDir: string): DoctorProbes {
  return {
    githubToken,
    loadGoals: async () => loadGoalSummaries(join(repoRoot, ".goals")),
    stateWritable: async () => isWritable(stateDir),
    nodeVersion: () => process.version,
    gitRepository: async () => gitRootOf(repoRoot) !== null,
    // 無視できているかの判定は git にさせる。否定パターンも祖先の .gitignore も
    // 自前では読めない（src/adapters/local.ts の stateDirIgnored）。
    stateIgnored: async () => stateDirIgnored(repoRoot),
  };
}

/** `.goals/*.yaml` を1本ずつ読む。1本落ちても残りは読む。どれが落ちたかが要るので */
function loadGoalSummaries(goalsDir: string): DoctorGoal[] {
  return readdirSync(goalsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const slug = basename(name, extnameOf(name));
      try {
        loadGoalFile(join(goalsDir, name));
        return { slug, error: null };
      } catch (error) {
        return { slug, error: errorMessage(error) };
      }
    });
}

function extnameOf(name: string): string {
  return name.endsWith(".yml") ? ".yml" : ".yaml";
}

/**
 * 書けるかどうかを、書かずに判定する。
 *
 * まだ存在しないディレクトリは「作れるか」を最も近い既存の祖先で見る。
 * 試しに作ってみると doctor が副作用を持つ。
 */
function isWritable(dir: string): boolean {
  let candidate = dir;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return false;
    }
    candidate = parent;
  }

  try {
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub に繋ぐ。トークンが無ければ throw する Port を返す。
 *
 * 捏造した観測を返すより、落として unobserved に残した方が状態が正しく残る
 * （design.md §3.1）。
 */
function codeProvider(goal: Goal): CodeProviderPort {
  return withGithub(goal, githubCodeProvider, () => {
    const fail = offline();
    return { getPullRequest: fail, getLatestCiRun: fail, getIssue: fail };
  });
}

/**
 * トークンがあれば実装を、無ければ代わりを返す。
 *
 * 同じ判定が3箇所にあった。トークンが無いときの `PortError` の文言と kind も
 * 2箇所に書き写されていて、`ent doctor` の助言がそれと一致していることが
 * 前提になっている。ずれると、doctor が「トークンを入れろ」と言っているのに
 * Port は別の理由を名乗る、という状態になる。
 */
function withGithub<T>(
  goal: Goal,
  make: (options: { owner: string; repo: string; token: string }) => T,
  offlineValue: () => T,
): T {
  const token = githubToken();
  if (token === null) {
    return offlineValue();
  }
  return make({ owner: goal.repository.owner, repo: goal.repository.name, token });
}

/** トークンが無いときに呼ばれたら throw する口 */
function offline(): () => Promise<never> {
  return async (): Promise<never> => {
    throw new PortError("unavailable", "GITHUB_TOKEN が設定されていない");
  };
}

/**
 * GitHub の書き込み側。read と分けてある（design.md §4.1）。
 *
 * トークンが無ければ呼ばれた時点で throw する。publish はそれを握って
 * skipped の理由に変えるので、通知に失敗してもティックは最後まで回る。
 */
function codeWriter(goal: Goal): CodeWriterPort {
  return withGithub(goal, githubCodeWriter, () => {
    const fail = offline();
    return { findPullRequest: fail, createPullRequest: fail, addComment: fail };
  });
}

/**
 * 人間の承認。PR コメントの `/ent approve <criterion-id>` を signal にする。
 *
 * PR もトークンも無ければ、常に未承認を返す Port にする。
 * 「確かめられなかった」を「承認された」と読まないため（design.md §3.1）。
 */
function approval(goal: Goal, prNumber: number | null): ApprovalPort {
  if (prNumber === null) {
    return pendingApproval();
  }
  return withGithub(goal, (options) => githubApproval({ ...options, prNumber }), pendingApproval);
}

/**
 * 検証コマンドとローカル観測を流す場所。
 *
 * Goal 専用の worktree があればそちらを使う。無ければ controller のリポジトリ。
 *
 * **見るのは実装役の作業ツリーに固定する。** `investigate` の作業ツリーで criteria を
 * 検証すると、実装が1つも入っていない作業ツリーの結果を実装の検証結果として読む。
 * `review` は実装役と同じ木を見るので（`worktreeNameFor`）、ここでは分岐しない。
 * `local.*` も同じ場所を観測するので、未 commit の関門（design.md §10-11）が
 * 突き合わせる `local.branch` も実装役のブランチになる。
 *
 * 名前の規則は `worktreeNameFor` が正で、ここで組み立て直さない。2箇所に書くと、
 * 規則が変わったときに検証だけ別の作業ツリーを見ていても誰も気づけない。
 *
 * repoRoot 固定にしていたところ、自己ホストで回して初めて破綻した。Actor は
 * worktree の中で実装するのに、VERIFY は controller 自身のリポジトリで
 * `mise run test` を流す。実装しても criteria は落ちたままになり、
 * ループが収束しない。criteria が確かめるのは「その変更」であって、
 * controller が動いているコードではない。
 *
 * 1ティック目はまだ worktree が無いので repoRoot を見る。そこで観測される
 * のは「着手前の状態」で、Gap が出るのは正しい。
 */
function verifyRoot(stateDir: string, goal: Goal): string {
  const worktree = join(stateDir, "worktrees", worktreeNameFor(goal.goal.id, "implement"));
  return existsSync(worktree) ? worktree : process.cwd();
}

/**
 * 一度読んだトークンを覚えておく置き場。`null` は「まだ読んでいない」。
 *
 * `githubToken()` は doctor と `tickPorts` から複数回呼ばれる。毎回
 * `gh auth token` を起動すると、1ティックで何度も外部プロセスが立つ。
 *
 * **「読めなかった」も覚える。** 中身を `string | null` にすると、
 * 外部プロセスが立つ高い経路（gh が未インストール・未ログイン）だけが毎回
 * やり直しになり、避けたかった場合に限ってキャッシュが効かない。
 */
let cachedGithubToken: { value: string | null } | null = null;

/**
 * controller が使う GitHub のトークン。無ければ null。
 *
 * 読む順は `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`。gh は README が挙げている
 * 前提そのものなので、依存は増えない。**`process.env` には書き戻さない。**
 * 書き戻すと、`withheldEnv` が Actor と検証コマンドから落としている当のキーが
 * controller のプロセスに生えて、落とす対象が増える。
 *
 * **空文字を設定してあれば「トークンは無い」と読み、gh も呼ばない。**
 * 未設定（`undefined`）と空文字を区別するのはここだけで、意味が逆になる。
 * 前者は「指定していない」なので gh に落ちてよいが、後者は「渡さないと決めた」に
 * あたる。区別しないと、GitHub を観測させたくない場面——テストと、対話ログイン
 * した gh がたまたま同じマシンにある CI——で、黙って実物のトークンが使われる。
 */
function githubToken(): string | null {
  if (cachedGithubToken !== null) {
    return cachedGithubToken.value;
  }

  // 空文字はキャッシュしない。外部プロセスも立たないので覚える意味が無く、
  // テストが同じプロセスで環境変数を差し替える経路も塞がない。
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv === "") {
    return null;
  }

  const token = fromEnv === undefined ? ghAuthToken() : fromEnv;
  cachedGithubToken = { value: token };
  return token;
}

/**
 * Agent SDK の query() をそのまま渡す。認証は Claude Code の OAuth に任せる。
 *
 * モデルと effort は環境変数で上書きできる。1ティックごとに使用量を消費するので、
 * 試走を安いモデルで回せる口が要る（design.md §7）。指定が無ければ Claude Code の既定。
 */
function claudeOptions(stateDir: string): ClaudeOptions {
  return {
    query,
    runsDir: join(stateDir, "runs"),
    model: nonEmpty(process.env.ENT_MODEL),
    effort: effortFrom(process.env.ENT_EFFORT),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * ENT_EFFORT を EffortLevel に直す。
 *
 * 知らない値を黙って捨てると「指定したのに効いていない」に気づけないので throw する。
 */
function effortFrom(value: string | undefined): EffortLevel | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) {
    return undefined;
  }
  if (!EFFORT_LEVELS.includes(raw as EffortLevel)) {
    throw new Error(`ENT_EFFORT が不正: ${raw}（${EFFORT_LEVELS.join(" / ")}）`);
  }
  return raw as EffortLevel;
}

/**
 * SDK の `EffortLevel` の全値。
 *
 * `readonly EffortLevel[]` と書くと片方向しか守れない。SDK からメンバーが
 * **消えた**ときは型エラーになるが、**増えた**ときは足りない配列もそのまま
 * 代入でき、妥当な値を「不正」として弾く。この関数の JSDoc は「知らない値を
 * 黙って捨てると気づけないので throw する」と書いているので、弾く側の
 * 取りこぼしも同じだけ困る。下の検査で増えた側も落ちるようにする。
 */
const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/**
 * EFFORT_LEVELS に足りない値があればビルドが落ちる。
 *
 * `never[]` への代入は「余りが無い」ときだけ通る。SDK に値が増えるとここで
 * 余りが出て、代入できなくなる。
 */
const _effortLevelsAreExhaustive: never[] = [] as Exclude<
  EffortLevel,
  (typeof EFFORT_LEVELS)[number]
>[];
void _effortLevelsAreExhaustive;
