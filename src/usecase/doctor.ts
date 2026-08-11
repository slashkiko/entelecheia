import { errorMessage } from "../domain/error-message.js";

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
}

/**
 * `node:sqlite`（src/store/sqlite.ts）が要求する Node のメジャーバージョン。
 *
 * 足りない Node で叩かれると import が例外になり、ent の話であることが
 * メッセージから読み取れない。対象リポジトリ側の Node が使われる構成——
 * shebang の `/usr/bin/env node`、mise や nvm を効かせた shell——では必ず起きる。
 */
const MIN_NODE_MAJOR = 24;

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
  // dependencies を goals の直後に置くのは、読めていることが前提になるから。
  const checks: DoctorCheck[] = [
    nodeVersionCheck(probes),
    await gitRepositoryCheck(probes),
    await stateIgnoredCheck(probes),
    githubTokenCheck(probes),
    goalsCheck(goals),
    dependenciesCheck(goals),
    await stateDirCheck(probes),
    claudeLoginCheck(),
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
      detail: `Node のバージョンを読めなかった: ${version}（node:sqlite は Node ${String(MIN_NODE_MAJOR)} 以上を要求する）`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: "node_version",
      result: "failed",
      detail:
        `node:sqlite が Node ${String(MIN_NODE_MAJOR)} 以上を要求するが、いま動いているのは ${version}。` +
        "このまま叩くと store の import が例外になり、ent の話であることがメッセージから読み取れない" +
        `（起動する Node を ${String(MIN_NODE_MAJOR)} 以上に固定する）`,
    };
  }
  return {
    name: "node_version",
    result: "ok",
    detail: `${version} で動いている（node:sqlite は Node ${String(MIN_NODE_MAJOR)} 以上を要求する）`,
  };
}

/** cwd が git のワークツリーの中か。外だと worktree もブランチも作れない */
async function gitRepositoryCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  if (!(await probes.gitRepository())) {
    return {
      name: "git_repository",
      result: "failed",
      detail:
        "ここは git リポジトリの中ではない。controller は Actor 用の worktree を作れず、" +
        ".goals/.state/ の gitignore も意味を持たない（git init を叩くか、リポジトリのルートで叩き直す）",
    };
  }
  return { name: "git_repository", result: "ok", detail: "git リポジトリの中で叩いている" };
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
        "git check-ignore で確かめられなかった。.goals/.state/ が無視されていないと、" +
        "状態 DB と worktree と Agent の生ログが対象リポジトリの git に載る",
    };
  }
  if (!ignored) {
    return {
      name: "state_ignored",
      result: "failed",
      detail:
        ".goals/.state が .gitignore に無い。状態 DB（goals.db）と Actor の worktree と " +
        "Agent の生ログが、そのまま対象リポジトリの git に載る（ent init が足す）",
    };
  }
  return { name: "state_ignored", result: "ok", detail: ".goals/.state は gitignore されている" };
}

function githubTokenCheck(probes: DoctorProbes): DoctorCheck {
  const token = probes.githubToken();
  if (token === null || token === "") {
    return {
      name: "github_token",
      result: "failed",
      detail:
        "GitHub の token を読めない。読む順は GITHUB_TOKEN → GH_TOKEN → gh auth token で、" +
        "環境変数に空文字を設定してあれば gh は呼ばない。" +
        "github.pr.* と github.ci.* が観測できず、" +
        "type: fact の criteria は永久に unobserved のままになる。PR の作成とコメントも通らない",
    };
  }
  return {
    name: "github_token",
    result: "ok",
    detail: "GitHub のトークンを読めた（環境変数か gh auth token。値は出さない）",
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
        `.goals/ を読めなかった: ${read.reason}。` +
        "このリポジトリでまだ始めていないなら ent init を叩く（.goals/ と雛形と gitignore の行を置く）",
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
    detail: `.goals/*.yaml を ${read.goals.length} 件読めた`,
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
      detail: ".goals/ を読めていないので依存は確かめられない（goals の検査を先に読む）",
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
        `読めなかった Goal が ${String(unreadable.length)} 件あり、その depends_on も読めていない。` +
        "欠けた辺を含む宣言では不在も循環も確かめられないので、goals の検査を先に直す",
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
      "依存先の .goals/<id>.yaml が無い: " +
        missing.map((entry) => `${entry.slug} → ${entry.absent.join(", ")}`).join(" / ") +
        "。実行時は「まだ始めていない」と同じ pending にしか見えず、" +
        "どの停止条件にも掛からないまま永久に止まる（綴りを直すか、依存先を ent start で立てる）",
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
      "depends_on が循環している: " +
        cycles.map((cycle) => [...cycle, cycle[0] ?? ""].join(" → ")).join(" / ") +
        "。閉じた輪の中は全員が依存の完了待ちのままで、どれも先に進まない" +
        "（輪のうち1本の depends_on を外す）",
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
        ? "depends_on は1本も書かれていない"
        : `depends_on を ${String(declaredEdges)} 本たどれた（依存先はすべて実在し、循環は無い）`,
  };
}

/**
 * 閉じた輪だけを取り出す。輪に入っていない Goal は返さない。
 *
 * 「複数の Goal が同じ依存先を指している」は循環ではない。菱形（alpha → base、
 * bravo → base）は閉じていないので、訪問済みを数えるだけの実装だとここを誤検知する。
 * 分解した本数が増えるほど当たるので、いま辿っている経路（`onPath`）に戻って
 * きたときだけを循環として数える。
 */
function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  /** 辿り終えた頂点。ここから先に未発見の輪は無い */
  const done = new Set<string>();
  /** いま辿っている経路。ここに戻る辺だけが輪を閉じる */
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (id: string): void => {
    if (onPath.has(id)) {
      // 経路が自分に戻ってきた。閉じているのは戻り先から先端までで、
      // そこへ入ってきただけの手前の頂点は輪の中にいない。
      const cycle = path.slice(path.indexOf(id));
      const key = [...cycle].sort().join(">");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (done.has(id)) {
      return;
    }

    path.push(id);
    onPath.add(id);
    for (const next of edges.get(id) ?? []) {
      walk(next);
    }
    onPath.delete(id);
    path.pop();
    done.add(id);
  };

  for (const id of edges.keys()) {
    walk(id);
  }
  return cycles;
}

async function stateDirCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  let writable: boolean;
  try {
    writable = await probes.stateWritable();
  } catch (error) {
    return {
      name: "state_dir",
      result: "failed",
      detail: `.goals/.state を確かめられなかった: ${errorMessage(error)}`,
    };
  }

  if (!writable) {
    return {
      name: "state_dir",
      result: "failed",
      detail:
        ".goals/.state に書けない。goals.db も worktree も生ログも置けないので、ティックの結果が残らない",
    };
  }
  return { name: "state_dir", result: "ok", detail: ".goals/.state に書ける" };
}

/**
 * Claude のログイン状態。
 *
 * 確かめるには query() を1回呼ぶことになり、それ自体がフルセッションのトークンを消費する。
 * 副作用のない doctor でそれはできないので、分からないまま unknown として出す。
 */
function claudeLoginCheck(): DoctorCheck {
  return {
    name: "claude_login",
    result: "unknown",
    detail:
      "Claude Code のログイン状態はトークンを消費せずには確かめられないので unknown にする。" +
      "未ログインだと DECIDE が PortError(unavailable) で ESCALATE(invalid_decision) になる。" +
      "疑わしければ claude コマンドで /login を確かめる",
  };
}
