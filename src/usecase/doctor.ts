import { describeCycles, findCycles } from "../domain/dependency-graph.js";
import { errorMessage } from "../domain/error-message.js";
import type { ActorKind } from "../domain/run.js";

/**
 * `ent doctor` の本体。回す前の前提が揃っているかを、**書かずに**調べる。
 *
 * ファイルも環境変数も直接は読まない。読む口は `DoctorProbes` で受け取り、
 * 実装を挿すのは合成ルート（`src/wiring/index.ts`）にする。テストから
 * 差し替えられるのはそのため。
 */

/**
 * 検査の結果。
 *
 * ok / failed の2値にしない。「確かめられなかった」を「問題なし」にも
 * 「不合格」にも畳まないため（design.md §3.1）。unknown はそのまま unknown で出す。
 */
export type DoctorResult = "ok" | "failed" | "unknown";

export interface DoctorCheck {
  /** 機械側の索引になる名前。`github_token` のような snake_case にする */
  name: string;
  result: DoctorResult;
  /** 何を見て、揃っていなければ何が起きるか。人間がこれだけ読んで動けるようにする */
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** failed が1件でもあれば 1。unknown だけなら 0 */
  exitCode: 0 | 1;
}

/** Goal YAML を1本読んだ結果。読めたなら error は null */
export interface DoctorGoal {
  slug: string;
  error: string | null;
  /**
   * `goal.depends_on` に書かれた id。**読めなかった Goal では空になる。**
   *
   * 読めていない YAML から依存は取り出せないので、空であることを
   * 「依存を書いていない」とは読まない。分けるのは `error` の側になる。
   */
  dependsOn: string[];
}

/**
 * doctor が外に触る口。ファイルと環境変数から切り離してテストする。
 *
 * 読み取りだけを並べてある。書き込む口を持たせないことで、
 * 「調べるついでに直す」が実装できないようにしてある。
 */
export interface DoctorProbes {
  /** GITHUB_TOKEN / GH_TOKEN。無ければ null */
  githubToken: () => string | null;
  /** `.goals/*.yaml` を読んで、slug ごとの成否と `depends_on` を返す */
  loadGoals: () => Promise<DoctorGoal[]>;
  /** state ディレクトリに書けるか */
  stateWritable: () => Promise<boolean>;
  /** いま動いている Node のバージョン（`v24.18.1` の形） */
  nodeVersion: () => string;
  /** cwd が git のワークツリーの中か */
  gitRepository: () => Promise<boolean>;
  /** `.goals/.state/` が gitignore されているか。確かめられなければ null */
  stateIgnored: () => Promise<boolean | null>;
  /** 後方互換用。共通のENT_ACTORだけを選ぶ呼び出し側が使う */
  actorKind?: (() => Exclude<ActorKind, "human">) | undefined;
  /** phase 別指定を含め、この実行で使いうる実行主体 */
  actorKinds?: (() => readonly Exclude<ActorKind, "human">[]) | undefined;
}

/**
 * `node:sqlite`（src/store/sqlite.ts）が要求する Node のメジャーバージョン。
 *
 * 足りない Node で叩かれると import が例外になり、ent の話であることが
 * メッセージから読み取れない。対象リポジトリ側の Node が使われる構成——
 * shebang の `/usr/bin/env node`、mise や nvm を効かせた shell——では必ず起きる。
 *
 * `package.json` の `engines.node` も同じ下限を宣言する。2箇所に別々の数字を書くと
 * 「入るのに動かない」か「動くのに入らない」のどちらかになるので、突き合わせられるよう
 * export する。根拠は `node:sqlite` の側にあり、doctor が出す detail が正になる。
 */
export const MIN_NODE_MAJOR = 24;

/**
 * `ent doctor` が出すもの。ティックを回す前に、前提が揃っているかを読み取り専用で確かめる。
 *
 * 6セッションを通して同じ形の摩擦が繰り返し起きた。入れ子の Claude Code が未ログインで
 * LLM 呼び出しが全滅した。GITHUB_TOKEN が無いまま回して `github.ci.conclusion` が
 * 永久に unobserved になった。どれも記録には残っていて、気づけないだけだった。
 *
 * `ent run` の入口では落とさない。トークンが無くてもローカルの観測・検証コマンド・
 * Actor の実行は進められるので、入口で殺すと進められるものまで止まる。
 *
 * 正直に作る。決定的に検査できるのは3つで、Claude のログイン状態はトークンを
 * 消費せずには確かめられない。それを ok と偽らず unknown として出し、
 * unknown だけでは終了コードを 1 にしない。確かめられなかったことを不合格として
 * 扱うと、doctor が常に赤くなって読まれなくなる。
 *
 * 出力は JSON にする。ent get / ent list と同じく機械可読を保つ。
 */
export async function doctorPayload(probes: DoctorProbes): Promise<DoctorReport> {
  // `.goals/` は1度だけ読む。goals と dependencies は同じ1回の読み取りを見る。
  // 別々に読むと、その間に書き換わった宣言について食い違った答えを出しうる。
  const goals = await readGoals(probes);

  // 並びは「その場所で ent が動くか」から「その Goal を回せるか」の順にする。
  // Node が足りない環境では他の検査の結果を読んでも直す手が変わらない。
  const actorKinds = [...new Set(probes.actorKinds?.() ?? [probes.actorKind?.() ?? "claude-code"])];
  // dependencies を goals の直後に置くのは、読めていることが前提になるから。
  const checks: DoctorCheck[] = [
    nodeVersionCheck(probes),
    await gitRepositoryCheck(probes),
    await stateIgnoredCheck(probes),
    githubTokenCheck(probes),
    goalsCheck(goals),
    dependenciesCheck(goals),
    await stateDirCheck(probes),
    ...actorKinds.map(actorLoginCheck),
  ];

  return {
    checks,
    // unknown は数えない。分からないものを不合格に畳まない。
    exitCode: checks.some((check) => check.result === "failed") ? 1 : 0,
  };
}

/**
 * 起動している Node が `node:sqlite` を持つか。
 *
 * 読めない形のバージョンは failed にも ok にも畳まず unknown で出す。
 * 「確かめられなかった」を「問題なし」にしないのと同じ理由で、逆向きにも倒さない。
 */
function nodeVersionCheck(probes: DoctorProbes): DoctorCheck {
  const version = probes.nodeVersion();
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);

  if (!Number.isInteger(major)) {
    return {
      name: "node_version",
      result: "unknown",
      detail: `Could not read the Node version: ${version} (node:sqlite requires Node ${String(MIN_NODE_MAJOR)} or later)`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: "node_version",
      result: "failed",
      detail:
        `node:sqlite requires Node ${String(MIN_NODE_MAJOR)} or later, but this process runs ${version}. ` +
        "Running as-is makes the store import throw, and the message will not reveal that ent is involved " +
        `(pin the Node that launches ent to ${String(MIN_NODE_MAJOR)} or later)`,
    };
  }
  return {
    name: "node_version",
    result: "ok",
    detail: `Running on ${version} (node:sqlite requires Node ${String(MIN_NODE_MAJOR)} or later)`,
  };
}

/** cwd が git のワークツリーの中か。外だと worktree もブランチも作れない */
async function gitRepositoryCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  if (!(await probes.gitRepository())) {
    return {
      name: "git_repository",
      result: "failed",
      detail:
        "This is not inside a git repository. The controller cannot create a worktree for the Actor, " +
        "and gitignoring .goals/.state/ means nothing (run git init, or run again from the repository root)",
    };
  }
  return { name: "git_repository", result: "ok", detail: "Running inside a git repository" };
}

/** `.goals/.state/` が gitignore されているか。されていないと状態が git に載る */
async function stateIgnoredCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  const ignored = await probes.stateIgnored();
  if (ignored === null) {
    // git に聞けなかった。「無視できていない」に畳むと doctor が常に赤くなる。
    return {
      name: "state_ignored",
      result: "unknown",
      detail:
        "git check-ignore could not confirm this. If .goals/.state/ is not ignored, " +
        "the state DB, the worktrees, and the Agent raw logs land in the target repository's git",
    };
  }
  if (!ignored) {
    return {
      name: "state_ignored",
      result: "failed",
      detail:
        ".goals/.state is not in .gitignore. The state DB (goals.db), the Actor worktrees, and " +
        "the Agent raw logs land in the target repository's git as they are (ent init adds the line)",
    };
  }
  return { name: "state_ignored", result: "ok", detail: ".goals/.state is gitignored" };
}

function githubTokenCheck(probes: DoctorProbes): DoctorCheck {
  const token = probes.githubToken();
  if (token === null || token === "") {
    return {
      name: "github_token",
      result: "failed",
      detail:
        "No GitHub token. The lookup order is GITHUB_TOKEN → GH_TOKEN → gh auth token, and " +
        "gh is not called when the environment variable is set to an empty string. " +
        "github.pr.* and github.ci.* cannot be observed, so type: fact criteria stay unobserved forever. " +
        "Creating PRs and posting comments fail too",
    };
  }
  return {
    name: "github_token",
    result: "ok",
    detail: "Read a GitHub token (from the environment or gh auth token; the value is not printed)",
  };
}

/**
 * `.goals/` を1度だけ読んだ結果。読めなかった理由も畳まずに持ち回る。
 *
 * goals と dependencies の2つの検査が同じ値を見るためにある。
 */
type GoalsRead =
  | { readonly kind: "read"; readonly goals: DoctorGoal[] }
  | { readonly kind: "unreadable"; readonly reason: string };

async function readGoals(probes: DoctorProbes): Promise<GoalsRead> {
  try {
    return { kind: "read", goals: await probes.loadGoals() };
  } catch (error) {
    return { kind: "unreadable", reason: errorMessage(error) };
  }
}

function goalsCheck(read: GoalsRead): DoctorCheck {
  if (read.kind === "unreadable") {
    // 「読めなかった」で止めない。壊れているのか、まだ始めていないのかを
    // 読み分けられないと、次に何を叩けばよいかが README を読むまで分からない。
    return {
      name: "goals",
      result: "failed",
      detail:
        `Could not read .goals/: ${read.reason}. ` +
        "If this repository has not been set up yet, run ent init (it places .goals/, a Goal template, and the gitignore line)",
    };
  }

  // どの slug が、なぜ読めなかったかを残す。件数だけでは直せない。
  const broken = read.goals.filter((goal) => goal.error !== null);
  if (broken.length > 0) {
    return {
      name: "goals",
      result: "failed",
      detail: broken.map((goal) => `${goal.slug}: ${goal.error}`).join(" / "),
    };
  }

  return {
    name: "goals",
    result: "ok",
    detail: `Read ${String(read.goals.length)} declaration(s) from .goals/*.yaml`,
  };
}

/**
 * `goal.depends_on` の宣言が、回す前から壊れていないか。
 *
 * 依存の判定は `tick` の入口（`dependencyGate`）にあり、依存が揃わないティックは
 * lease も取らずに return する。**そのティックは何も書かない。** reconciles は進まず
 * Decision も残らないので、`max_reconciles` にも `max_wall_clock` にも当たらない。
 * つまり depends_on の書き間違いは、どの停止条件にも掛からないまま永久に止まる。
 *
 * ここは読むだけで、実行時の判定は変えない。「先に進んでよいか」は停止条件なので
 * `dependencyGate`（src/domain/guard-rules.ts）が持ち続ける。こちらが答えるのは
 * 「回す前の宣言が壊れていないか」で、層が違う。
 *
 * 見るのは2つ。
 *
 *   不在  依存先の `.goals/<id>.yaml` が無い。実行時には「まだ始めていない」と
 *         区別が付かない（どちらも pending）。宣言を全部読める doctor だけが分けられる
 *   循環  a → b → a のように依存が閉じている。自己参照はスキーマが弾くが、
 *         2本以上をまたぐ循環は Goal YAML 1本からは見えない
 */
function dependenciesCheck(read: GoalsRead): DoctorCheck {
  if (read.kind === "unreadable") {
    // `.goals/` ごと読めていない。goals の検査が failed にして次の一手も出している。
    // ここまで failed にすると、原因が1つなのに検査が2つ鳴る。
    return {
      name: "dependencies",
      result: "unknown",
      detail:
        ".goals/ could not be read, so dependencies cannot be checked (read the goals check first)",
    };
  }

  // 読めなかった Goal があるなら、その depends_on も読めていない。無いものを
  // 「依存が不在」と読むと嘘になるし、欠けた辺を数えないまま「循環は無い」とも
  // 言えない。分かるのは goals の側なので、ここは黙る。
  const unreadable = read.goals.filter((goal) => goal.error !== null);
  if (unreadable.length > 0) {
    return {
      name: "dependencies",
      result: "unknown",
      detail:
        `${String(unreadable.length)} Goal declaration(s) could not be read, so their depends_on is unknown too. ` +
        "Neither missing dependencies nor cycles can be checked while edges are absent, so fix the goals check first",
    };
  }

  const goals = read.goals;
  // 存在の基準は「`.goals/` に宣言があるか」にする。ステータスは見ない。
  // 進んでいるかどうかは実行時の話で、ここが答えるのは宣言の壊れ方になる。
  const declared = new Set(goals.map((goal) => goal.slug));

  const problems: string[] = [];

  // 不在。どの Goal のどの依存かまで名指しする。件数だけでは直せない。
  const missing = goals
    .map((goal) => ({ slug: goal.slug, absent: goal.dependsOn.filter((id) => !declared.has(id)) }))
    .filter((entry) => entry.absent.length > 0);
  if (missing.length > 0) {
    problems.push(
      "Dependency has no .goals/<id>.yaml: " +
        missing.map((entry) => `${entry.slug} → ${entry.absent.join(", ")}`).join(" / ") +
        ". At runtime this is indistinguishable from a Goal that has not started — both read as pending — " +
        "so it stalls forever without hitting any stopping condition " +
        "(fix the spelling, or create the dependency with ent start)",
    );
  }

  // 循環。実在する依存だけを辺にする。不在の依存は上で名指し済みで、
  // 辺として数えると同じ書き間違いが2度鳴る。
  const edges = new Map<string, string[]>(
    goals.map((goal) => [goal.slug, goal.dependsOn.filter((id) => declared.has(id))]),
  );
  const cycles = findCycles(edges);
  if (cycles.length > 0) {
    problems.push(
      `depends_on forms a cycle: ${describeCycles(cycles)}` +
        ". Every Goal inside a closed cycle waits for its dependency to finish, so none of them progresses " +
        "(drop depends_on from one Goal in the cycle)",
    );
  }

  if (problems.length > 0) {
    return { name: "dependencies", result: "failed", detail: problems.join(" / ") };
  }

  const declaredEdges = goals.reduce((total, goal) => total + goal.dependsOn.length, 0);
  return {
    name: "dependencies",
    result: "ok",
    detail:
      declaredEdges === 0
        ? "No depends_on is declared"
        : `Followed ${String(declaredEdges)} depends_on edge(s) (every dependency exists and there is no cycle)`,
  };
}

async function stateDirCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  let writable: boolean;
  try {
    writable = await probes.stateWritable();
  } catch (error) {
    return {
      name: "state_dir",
      result: "failed",
      detail: `Could not check .goals/.state: ${errorMessage(error)}`,
    };
  }

  if (!writable) {
    return {
      name: "state_dir",
      result: "failed",
      detail:
        ".goals/.state is not writable. goals.db, the worktrees, and the raw logs cannot be placed, so nothing a tick produces is recorded",
    };
  }
  return { name: "state_dir", result: "ok", detail: ".goals/.state is writable" };
}

/**
 * Claude のログイン状態。
 *
 * 確かめるには query() を1回呼ぶことになり、それ自体がフルセッションのトークンを消費する。
 * 副作用のない doctor でそれはできないので、分からないまま unknown として出す。
 */
function actorLoginCheck(actor: Exclude<ActorKind, "human">): DoctorCheck {
  const label = actor === "codex" ? "Codex CLI" : "Claude Code";
  const command = actor === "codex" ? "codex login status" : "run claude, then /login";
  return {
    name: actor === "codex" ? "codex_login" : "claude_login",
    result: "unknown",
    detail:
      `ent doctor cannot determine the ${label} login state, so it reports unknown. ` +
      "If not logged in, every phase that selects this provider fails its call. " +
      `Check with ${command} if in doubt`,
  };
}
