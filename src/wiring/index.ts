import { accessSync, constants, existsSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import { type ActorPort, worktreeNameFor } from "../act/index.js";
import { type ClaudeOptions, claudeActor, claudeLlm } from "../adapters/claude.js";
import { type CodexEffort, type CodexOptions, codexActor, codexLlm } from "../adapters/codex.js";
import { githubApproval, githubCodeProvider, githubCodeWriter } from "../adapters/github.js";
import { loadGoalFile } from "../adapters/goal-file.js";
import {
  commandRunner,
  findGitRoot,
  ghAuthToken,
  gitBranch,
  gitDefaultBranch,
  gitRemoteRepository,
  gitWorktree,
  localRepo,
  pendingApproval,
  STATE_IGNORE_LINE,
  stateDirIgnored,
} from "../adapters/local.js";
import { reviewRunLog } from "../adapters/review-run.js";
import type { ControllerDeps } from "../controller/index.js";
import type { LlmPort } from "../decide/index.js";
import type { ActionAgent } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import type { Goal } from "../domain/goal.js";
import type { LlmCall } from "../domain/llm-call.js";
import { PortError } from "../domain/port-error.js";
import { type ActorKind, type ActorRole, EFFORT_VOCABULARY } from "../domain/run.js";
import type { CodeProviderPort } from "../observe/index.js";
import type { CodeWriterPort } from "../publish/index.js";
import type { Store } from "../store/port.js";
import { openStore } from "../store/sqlite.js";
import type { DoctorGoal, DoctorProbes } from "../usecase/doctor.js";
import type { InitProbes } from "../usecase/init.js";
import type { PlanProbes, RepositoryResolution } from "../usecase/plan.js";
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
export interface AgentFactories {
  claudeActor(options: ClaudeOptions): ActorPort;
  claudeLlm(options: ClaudeOptions): LlmPort;
  codexActor(options: CodexOptions): ActorPort;
  codexLlm(options: CodexOptions): LlmPort;
}

export interface TickPortOptions {
  env?: Record<string, string | undefined> | undefined;
  agentFactories?: AgentFactories | undefined;
}

const DEFAULT_AGENT_FACTORIES: AgentFactories = {
  claudeActor,
  claudeLlm,
  codexActor,
  codexLlm,
};

export function tickPorts(
  goal: Goal,
  store: Store,
  repoRoot: string,
  stateDir: string,
  options: TickPortOptions = {},
): Omit<ControllerDeps, "store"> {
  const worktrees = join(stateDir, "worktrees");
  const onCall = (call: LlmCall): void => {
    // 呼んだ直後に書く。ティックの最後にまとめて書くと、途中で kill された
    // ぶんのトークンが消える（design.md §7）。
    store.recordLlmCall(goal.goal.id, call);
  };
  const env = options.env ?? process.env;
  const factories = options.agentFactories ?? DEFAULT_AGENT_FACTORIES;
  const actor = routedActor(stateDir, env, factories);
  const llm = selectedLlm(stateDir, env, onCall, factories);
  return {
    owner: `${hostname()}:${process.pid}`,
    leaseSeconds: 300,
    code: codeProvider(goal),
    writer: codeWriter(goal),
    branch: gitBranch(worktrees),
    local: localRepo(verifyRoot(stateDir, goal)),
    command: commandRunner(verifyRoot(stateDir, goal)),
    // レビュー役の結論は、この controller が起動した Run の生ログから読む
    // （design.md §4.6 の `runs/<run-id>/log.jsonl`）。Run を選ぶ材料は
    // 実行時状態の側にあるので、Store から取る。
    review: reviewRunLog({ listRuns: () => store.listRuns(goal.goal.id) }),
    // 承認はレビュー承認と PR コメントの定型文の2つで検知する（design.md §10-4）。
    // PR がまだ無い Goal では常に未承認になる。捏造した承認を作らない。
    approval: approval(goal, store.getState(goal.goal.id)?.prNumber ?? null),
    worktree: gitWorktree(repoRoot, worktrees),
    worktreeRoot: worktrees,
    actor,
    llm,
    // DECIDE が ACT に名指してよい provider。人間が環境変数で opt-in したものだけを
    // 渡す（`DecideDeps.availableActors`）。`ent doctor` がログイン前提を確かめる
    // 集合と同じものにしてある。片方だけ広いと、doctor が見ていない provider が走る。
    availableActors: selectedActorKinds(env),
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
 * 実装を選ぶだけで、包み直す必要が無い2つ。
 *
 * `openStore` — 実行時状態の置き場を開く。いまの実装は SQLite（`src/store/sqlite.ts`）。
 * `Store` は使う側が所有する Port（`src/store/port.ts`）なので、どの実装を挿すかを
 * 決めるのは Adapter と同じくここ1箇所にする。
 *
 * `STATE_IGNORE_LINE` — `.gitignore` に書く1行。実体は `src/adapters/local.ts` にあり、
 * `stateDirIgnored` が「無視できているか」を判定するときの基準と同じものになる。
 * `ent init` が書く側で、この2つがずれると「書いたのに無視できていない」状態を作る。
 *
 * `loadGoalFile` — `.goals/<slug>.yaml` を読む（`src/adapters/goal-file.ts`）。
 * 検証そのものは `parseGoal`（ドメイン）が持ち、ここが選ぶのは読み方だけになる。
 *
 * どれも cli.ts からは Adapter / 実装を直接見せず、合成ルート経由で渡す。
 */
export { loadGoalFile, openStore, STATE_IGNORE_LINE };

/**
 * 対象リポジトリの git ルート。git のワークツリーの中でなければ null。
 *
 * `ent init` と `ent doctor` の両方が使う。判定そのものは git に聞く
 * （`src/adapters/local.ts` の `findGitRoot`）ので、Adapter を選ぶ判断はここに置く。
 */
export function gitRootOf(repoRoot: string): string | null {
  return findGitRoot(repoRoot);
}

/**
 * `ent init` が外の世界に聞くこと。
 *
 * `.gitignore` に書く1行と、それを「無視できているか」判定する
 * `stateDirIgnored` の基準は同じ文字列でなければならない。実体は
 * `src/adapters/local.ts` にあるので、選ぶのはここになる。
 */
export function initProbes(): InitProbes {
  return { gitRoot: gitRootOf, stateIgnoreLine: STATE_IGNORE_LINE };
}

/**
 * `ent plan` が外の世界に触る口。
 *
 * planner の LLM は `agentSelectionFrom(env, "plan")` に通すので、`ENT_PLAN_ACTOR` /
 * `ENT_PLAN_MODEL` / `ENT_PLAN_EFFORT` が効き、無ければ共通の `ENT_ACTOR` などへ落ちる。
 *
 * **トークンの記録は状態 DB に入れない。** `llm_calls.goal_id` は
 * `NOT NULL REFERENCES goals(id)` で、plan の時点では Goal の行がまだ1つも無い。
 * 入れるために架空の Goal を作ると、どの YAML も宣言していない Goal が `ent list` に
 * 出る。代わりに生ログ（`runs/plan-<時刻>/log.jsonl`）に残す。
 */
export function planProbes(
  repoRoot: string,
  stateDir: string,
  overrides: RepositoryOverrides = {},
): PlanProbes {
  const goalsDir = join(repoRoot, ".goals");
  const llm = selectedLlm(stateDir, process.env, () => {}, DEFAULT_AGENT_FACTORIES, "plan");
  return {
    planner: { propose: async (prompt) => llm.chooseAction(prompt) },
    repository: () => resolveRepository(repoRoot, overrides),
    existingGoals: () =>
      existsSync(goalsDir)
        ? loadGoalSummaries(goalsDir).map((goal) => ({
            slug: goal.slug,
            dependsOn: goal.dependsOn,
          }))
        : null,
    writeGoalFile: (slug, body) => {
      const path = join(goalsDir, `${slug}.yaml`);
      // `wx` にする。存在すれば書かずに落ちる。呼ぶ前に衝突は弾いてあるが、
      // その判定と書き込みの間に人間が同じ id を置く経路まで塞ぐのは、
      // ファイルシステム側でしかできない。
      writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
      return `.goals/${slug}.yaml`;
    },
    now: () => new Date(),
  };
}

/** `--repo` / `--default-branch` で宣言部の値を上書きする口。省略時は git に聞く */
export interface RepositoryOverrides {
  /** `owner/name` の形。`ent plan --repo` がそのまま渡す */
  repo?: string | undefined;
  defaultBranch?: string | undefined;
}

/**
 * 宣言に書く対象リポジトリを決める。**ネットワークには聞かない。**
 *
 * 順は「明示のフラグ → git」。どちらでも決まらなければ、何を足せば決まるかを
 * 名指しして断る。既定値へ倒さないのは、既定が `master` のリポジトリで
 * `main` と書いた宣言が静かに通り、最初のティックで初めて外れるため。
 */
function resolveRepository(repoRoot: string, overrides: RepositoryOverrides): RepositoryResolution {
  const fromFlag = overrides.repo === undefined ? null : splitRepo(overrides.repo);
  if (typeof fromFlag === "string") {
    return { kind: "unresolved", reason: fromFlag };
  }
  const remote = fromFlag ?? gitRemoteRepository(repoRoot);
  if (remote === null) {
    return {
      kind: "unresolved",
      reason:
        "Could not read the target repository from git remote origin (only github.com remotes are read). " +
        "Pass it explicitly: ent plan --repo <owner>/<name>",
    };
  }

  const defaultBranch = nonEmpty(overrides.defaultBranch) ?? gitDefaultBranch(repoRoot);
  if (defaultBranch === null) {
    return {
      kind: "unresolved",
      reason:
        "Could not read the default branch. refs/remotes/origin/HEAD is only set by git clone, " +
        "so it is often absent (git remote set-head origin -a writes it). " +
        "Pass it explicitly: ent plan --default-branch <name>",
    };
  }

  return { kind: "resolved", owner: remote.owner, name: remote.name, defaultBranch };
}

/** `owner/name` を割る。割れなければ、打ち直せる形をエラー文字列で返す */
function splitRepo(value: string): { owner: string; name: string } | string {
  const [owner, name, ...rest] = value.trim().split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "") {
    return `--repo takes <owner>/<name>: ${value}`;
  }
  if (rest.length > 0) {
    return `--repo takes <owner>/<name>, not a URL or a path: ${value}`;
  }
  return { owner, name };
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
    actorKinds: () => selectedActorKinds(process.env),
  };
}

/**
 * `.goals/*.yaml` を1本ずつ読む。1本落ちても残りは読む。どれが落ちたかが要るので。
 *
 * 読めた分は `goal.depends_on` も写す。doctor が「依存先が実在するか」と
 * 「循環していないか」を見る材料になる。**読む口だけを足す。** 落ちた分の
 * `dependsOn` は空にするが、`error` が付いているので読む側が依存の検査から外せる。
 *
 * `parseGoal` が `goal.id` とファイル名の一致を強制しているので
 * （`src/domain/goal-parse.ts`）、ここで返す slug は `depends_on` に書く id と
 * 同じものになる。
 */
function loadGoalSummaries(goalsDir: string): DoctorGoal[] {
  return readdirSync(goalsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const slug = basename(name, extnameOf(name));
      try {
        const goal = loadGoalFile(join(goalsDir, name));
        return { slug, error: null, dependsOn: [...goal.goal.depends_on] };
      } catch (error) {
        return { slug, error: errorMessage(error), dependsOn: [] };
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
  return withGithub(
    goal,
    // 数から外す workflow は宣言部にある（`repository.ci.exclude_workflows`）。
    // 書いていなければ空で、除外なしの挙動そのままになる。
    (options) =>
      githubCodeProvider({
        ...options,
        excludeWorkflows: goal.repository.ci?.exclude_workflows ?? [],
      }),
    () => {
      const fail = offline();
      return { getPullRequest: fail, getLatestCiRun: fail, getIssue: fail };
    },
  );
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
    throw new PortError("unavailable", "GITHUB_TOKEN is not set");
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
function claudeOptions(
  stateDir: string,
  selection: Extract<PhaseAgentSelection, { actor: "claude-code" }>,
): ClaudeOptions {
  return {
    query,
    runsDir: join(stateDir, "runs"),
    model: selection.model,
    effort: selection.effort,
  };
}

function codexOptions(
  stateDir: string,
  selection: Extract<PhaseAgentSelection, { actor: "codex" }>,
): CodexOptions {
  return {
    runsDir: join(stateDir, "runs"),
    model: selection.model,
    effort: selection.effort,
  };
}

/**
 * agent を選べる単位。
 *
 * `decide` はティックの中の判断、`plan` は `ent plan` の分解、残りは Actor の役割に
 * なる。**`plan` を `ActorRole` に足さない。** あちらは「worktree の中で何かを書くか
 * 読むか」の分担で、宣言を書く planner はそこに属さない（design.md §10-12）。
 */
export type AgentPhase = "decide" | "plan" | ActorRole;

export type PhaseAgentSelection =
  | { actor: "claude-code"; model?: string | undefined; effort?: EffortLevel | undefined }
  | { actor: "codex"; model?: string | undefined; effort?: CodexEffort | undefined };

/**
 * phase 固有の指定を読み、無ければ既存の共通指定へ落とす。
 *
 * `ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT` は互換性のため残す。たとえば DECIDE だけ
 * Codex にする場合は `ENT_DECIDE_ACTOR=codex` を重ねればよい。空文字は未指定として
 * 共通値へ落とし、typo は黙って捨てない。
 */
export function agentSelectionFrom(
  env: Record<string, string | undefined>,
  phase: AgentPhase,
): PhaseAgentSelection {
  const prefix = `ENT_${phase.toUpperCase()}_`;
  const actorKey = `${prefix}ACTOR`;
  const modelKey = `${prefix}MODEL`;
  const effortKey = `${prefix}EFFORT`;
  const phaseActor = nonEmpty(env[actorKey]);
  const actor = actorKindFrom(
    phaseActor ?? env.ENT_ACTOR,
    phaseActor === undefined ? "ENT_ACTOR" : actorKey,
  );
  const model = nonEmpty(env[modelKey]) ?? nonEmpty(env.ENT_MODEL);
  const phaseEffort = nonEmpty(env[effortKey]);
  const effortValue = phaseEffort ?? env.ENT_EFFORT;
  const effortSource = phaseEffort === undefined ? "ENT_EFFORT" : effortKey;

  if (actor === "codex") {
    return { actor, model, effort: codexEffortFrom(effortValue, effortSource) };
  }
  return { actor, model, effort: effortFrom(effortValue, effortSource) };
}

function selectedLlm(
  stateDir: string,
  env: Record<string, string | undefined>,
  onCall: (call: LlmCall) => void,
  factories: AgentFactories = DEFAULT_AGENT_FACTORIES,
  purpose: LlmCall["purpose"] = "decide",
): LlmPort {
  // phase 名と purpose を別々に受け取らない。生ログの置き場所（`<purpose>-<時刻>`）と
  // 環境変数の接頭辞（`ENT_<PHASE>_`）が食い違うと、どのログがどの設定で走ったのかを
  // 外から辿れなくなる。
  const selection = agentSelectionFrom(env, purpose);
  return selection.actor === "codex"
    ? factories.codexLlm({ ...codexOptions(stateDir, selection), onCall, purpose })
    : factories.claudeLlm({ ...claudeOptions(stateDir, selection), onCall, purpose });
}

/** role ごとの Adapter を1本の ActorPort に束ねる。 */
function routedActor(
  stateDir: string,
  env: Record<string, string | undefined>,
  factories: AgentFactories = DEFAULT_AGENT_FACTORIES,
): ActorPort {
  const byRole: Record<ActorRole, ActorPort> = {
    implement: selectedActor(stateDir, agentSelectionFrom(env, "implement"), factories),
    review: selectedActor(stateDir, agentSelectionFrom(env, "review"), factories),
    investigate: selectedActor(stateDir, agentSelectionFrom(env, "investigate"), factories),
  };

  return {
    kind: byRole.implement.kind,
    kindFor: (role) => byRole[role].kind,
    run: async (invocation) => {
      // DECIDE が provider を名指ししていれば、その組で1回だけ Adapter を作る。
      // Adapter は起動オプションを閉じ込めただけのクロージャなので、毎回作っても
      // プロセスは増えない。名指しが無いティックは従来どおり role 別の既定で走る。
      const chosen = invocation.agent;
      if (chosen === undefined) {
        return byRole[invocation.role].run(invocation);
      }
      return selectedActor(stateDir, decidedSelection(chosen), factories).run(invocation);
    },
  };
}

/**
 * DECIDE が返した組を、Adapter を選ぶ形に直す。
 *
 * effort の語彙は provider ごとに違うので、ここでも provider を見てから検証する。
 * 採用の時点（`askLlm`、`src/decide/index.ts`）で同じ検証を通しているが、
 * **通した値しか来ないことを前提にしない。** Decision は DB から読み直されて
 * ここへ来ることがあり、そちらは採用時の検証を通っていない。
 *
 * エラーの source には `ACT.agent.effort` を書く。環境変数の綴りを出すと、
 * 環境変数を1つも設定していない人間が `ENT_EFFORT` を探しに行くことになる。
 */
function decidedSelection(agent: ActionAgent): PhaseAgentSelection {
  const key = "ACT.agent.effort";
  if (agent.actor === "codex") {
    return { actor: agent.actor, model: agent.model, effort: codexEffortFrom(agent.effort, key) };
  }
  return { actor: agent.actor, model: agent.model, effort: effortFrom(agent.effort, key) };
}

function selectedActor(
  stateDir: string,
  selection: PhaseAgentSelection,
  factories: AgentFactories = DEFAULT_AGENT_FACTORIES,
): ActorPort {
  return selection.actor === "codex"
    ? factories.codexActor(codexOptions(stateDir, selection))
    : factories.claudeActor(claudeOptions(stateDir, selection));
}

function selectedActorKinds(
  env: Record<string, string | undefined>,
): Exclude<ActorKind, "human">[] {
  // `plan` も入れる。doctor のログイン検査が見るのは「この実行で使いうる実行主体」で、
  // `ENT_PLAN_ACTOR=codex` だけを立てた環境では Codex のログインだけが要る。
  const phases: readonly AgentPhase[] = ["decide", "plan", "implement", "review", "investigate"];
  return [...new Set(phases.map((phase) => agentSelectionFrom(env, phase).actor))];
}

/**
 * providerを選ぶ。未指定時は既存のClaude Codeを保ち、Codexはopt-inにする。
 */
function actorKindFrom(value: string | undefined, key = "ENT_ACTOR"): Exclude<ActorKind, "human"> {
  const raw = nonEmpty(value) ?? "claude-code";
  if (raw === "claude-code" || raw === "codex") {
    return raw;
  }
  throw new Error(`${key} is invalid: ${raw} (claude-code / codex)`);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * ENT_EFFORT を EffortLevel に直す。
 *
 * 知らない値を黙って捨てると「指定したのに効いていない」に気づけないので throw する。
 */
function effortFrom(value: string | undefined, key = "ENT_EFFORT"): EffortLevel | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) {
    return undefined;
  }
  if (!EFFORT_LEVELS.includes(raw as EffortLevel)) {
    throw new Error(`${key} is invalid: ${raw} (${EFFORT_LEVELS.join(" / ")})`);
  }
  return raw as EffortLevel;
}

function codexEffortFrom(value: string | undefined, key = "ENT_EFFORT"): CodexEffort | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) {
    return undefined;
  }
  if (!CODEX_EFFORT_LEVELS.includes(raw as CodexEffort)) {
    throw new Error(`${key} is invalid: ${raw} (${CODEX_EFFORT_LEVELS.join(" / ")})`);
  }
  return raw as CodexEffort;
}

/**
 * SDK の `EffortLevel` の全値。
 *
 * **値そのものはドメインが持つ**（`EFFORT_VOCABULARY`、`src/domain/run.ts`）。
 * 同じ語彙を DECIDE の受け取り側も見るようになったので、2箇所に書くと
 * 片方だけ直したときに「プロンプトは受け付けると言うのに採用されない」状態を
 * 作れる。ここに残すのは、その語彙が **SDK の型と一致しているかの検査**になる。
 *
 * `readonly EffortLevel[]` と書くと片方向しか守れない。SDK からメンバーが
 * **消えた**ときは型エラーになるが、**増えた**ときは足りない配列もそのまま
 * 代入でき、妥当な値を「不正」として弾く。この関数の JSDoc は「知らない値を
 * 黙って捨てると気づけないので throw する」と書いているので、弾く側の
 * 取りこぼしも同じだけ困る。下の検査で増えた側も落ちるようにする。
 */
const EFFORT_LEVELS = EFFORT_VOCABULARY["claude-code"] satisfies readonly EffortLevel[];

const CODEX_EFFORT_LEVELS = EFFORT_VOCABULARY.codex satisfies readonly CodexEffort[];

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

/** `CODEX_EFFORT_LEVELS` も同じ検査に掛ける。増えた側で落ちる理由は上と同じ。 */
const _codexEffortLevelsAreExhaustive: never[] = [] as Exclude<
  CodexEffort,
  (typeof CODEX_EFFORT_LEVELS)[number]
>[];
void _codexEffortLevelsAreExhaustive;
