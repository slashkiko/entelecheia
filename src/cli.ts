import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeOptions, claudeActor, claudeLlm } from "./adapters/claude.js";
import { githubApproval, githubCodeProvider, githubCodeWriter } from "./adapters/github.js";
import {
  commandRunner,
  gitBranch,
  gitWorktree,
  localRepo,
  pendingApproval,
} from "./adapters/local.js";
import { type TickResult, tick } from "./controller/index.js";
import type { Decision } from "./domain/action.js";
import type { Goal } from "./domain/goal.js";
import { loadGoalFile } from "./domain/goal-loader.js";
import { isTerminal } from "./domain/goal-state.js";
import { PortError } from "./domain/port-error.js";
import type { Run } from "./domain/run.js";
import type { Verification } from "./domain/verification.js";
import type { CodeProviderPort } from "./observe/index.js";
import type { CodeWriterPort } from "./publish/index.js";
import {
  type GoalListItem,
  type GoalState,
  openStore,
  type Snapshot,
  type Store,
} from "./store/index.js";
import type { ApprovalPort } from "./verify/index.js";

/**
 * `ent` コマンド。常駐しない（design.md §3.6）。
 *
 * 引数の解釈は Node 24 標準の `node:util` の parseArgs で書く。citty は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 */

export const USAGE = `ent — Declare the end state; the controller converges to it.

  ent start <slug>   Goal を登録して ACTIVE にする
  ent run <slug>     1ティック回して終了する（--once は既定）
                     --pr <n> / --issue <n> で観測対象を指定する
  ent show <slug>    宣言部と実行時状態をまとめて表示する
  ent list           登録済みの Goal を一覧する
  ent doctor         回す前の前提が揃っているかを読み取り専用で調べる
`;

export type Command =
  /** Goal を登録して ACTIVE にする */
  | { kind: "start"; slug: string }
  /**
   * 1ティック回して終了する。--once は既定で、常駐する形は用意しない。
   *
   * prNumber / issueNumber は「指定があった場合だけ」入る。未指定と「明示的に
   * 対象なし」を区別するため、null ではなく未設定にしてある。未指定なら前回の値を保つ。
   */
  | { kind: "run"; slug: string; prNumber?: number; issueNumber?: number }
  /** 宣言部と実行時状態をマージして1枚で出す */
  | { kind: "show"; slug: string }
  /** 登録済みの Goal を一覧する。slug は取らない */
  | { kind: "list" }
  /**
   * 回す前の前提を調べる。slug は取らず、副作用も持たない。
   *
   * どの Goal にも共通する前提（トークン・Goal YAML・state ディレクトリ）だけを見るので、
   * 特定の Goal を指す必要が無い。
   */
  | { kind: "doctor" }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * `ent` の引数を解釈する。
 *
 * 満たすべき性質:
 * - 実行はしない。解釈だけを返す。副作用のある部分と分けてテストするため
 * - 知らないサブコマンドと知らないオプションは error にする。黙って無視しない
 * - slug が無ければ error。どの Goal を回すかは既定値で埋められない
 * - 引数が無い、または --help なら help
 */
export function parseCommand(argv: readonly string[]): Command {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  if (sub !== "start" && sub !== "run" && sub !== "show" && sub !== "list" && sub !== "doctor") {
    // 黙って無視すると、打ち間違いが「何も起きなかった」に見える。
    return { kind: "error", message: `不明なサブコマンド: ${sub}` };
  }

  try {
    const { positionals, values } = parseArgs({
      args: [...rest],
      allowPositionals: true,
      // --once は既定の挙動を明示するだけで、受け取っても何も変えない。
      // 常駐する形は用意しない（design.md §3.6）。
      //
      // --pr / --issue は観測対象。Goal YAML は宣言部だけを持つので置き場が無く、
      // controller が PR を作れるようになるまでは人間が渡す（次の Goal で自動化する）。
      options:
        sub === "run"
          ? {
              once: { type: "boolean" },
              pr: { type: "string" },
              issue: { type: "string" },
            }
          : {},
      strict: true,
    });

    if (sub === "list" || sub === "doctor") {
      // どちらも slug を取らない。余分な引数は打ち間違いとして error にする。
      if (positionals.length > 0) {
        return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
      }
      return sub === "list" ? { kind: "list" } : { kind: "doctor" };
    }

    const slug = positionals[0];
    if (slug === undefined) {
      // どの Goal を回すかは既定値で埋められない。
      return { kind: "error", message: `${sub} には Goal の slug が要る` };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
    }

    if (sub !== "run") {
      return { kind: sub, slug };
    }

    const prNumber = positiveInteger(values.pr, "--pr");
    if (typeof prNumber === "string") {
      return { kind: "error", message: prNumber };
    }
    const issueNumber = positiveInteger(values.issue, "--issue");
    if (typeof issueNumber === "string") {
      return { kind: "error", message: issueNumber };
    }

    return {
      kind: "run",
      slug,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(issueNumber === undefined ? {} : { issueNumber }),
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR / Issue 番号を読む。指定が無ければ undefined、読めなければエラー文字列を返す。
 *
 * 読めない値を黙って捨てると、`--pr abc` が「指定しなかった」と同じ扱いになり、
 * 観測対象が変わらないまま回ってしまう。
 */
function positiveInteger(value: unknown, flag: string): number | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return `${flag} は正の整数で指定する: ${String(value)}`;
  }
  return parsed;
}

/**
 * `ent` の本体。1ティック回して終了する。常駐しない（design.md §3.6）。
 *
 * GITHUB_TOKEN が無ければ、GitHub の Port は PortError(unavailable) を投げる。
 * observe がそれを握って unobserved に落とすので、ティック自体は最後まで回り、
 * 状態が DB に残る。捏造した観測は作らない。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "error") {
    process.stderr.write(`${command.message}\n\n${USAGE}`);
    return 2;
  }

  const repoRoot = process.cwd();
  const stateDir = join(repoRoot, ".goals", ".state");

  if (command.kind === "doctor") {
    // 読み取り専用にする。state ディレクトリを作るのも書き込みなので、
    // mkdirSync より前に返す。doctor は調べるだけで、直さない。
    const report = await doctorPayload(doctorProbes(repoRoot, stateDir));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }

  mkdirSync(join(stateDir, "worktrees"), { recursive: true });

  if (command.kind === "list") {
    // list は slug を取らない。Goal YAML を読まずに DB だけ見る。
    const store = openStore(join(stateDir, "goals.db"));
    try {
      process.stdout.write(`${JSON.stringify(listPayload(store), null, 2)}\n`);
      return 0;
    } finally {
      store.close();
    }
  }

  const goal = loadGoalFile(join(repoRoot, ".goals", `${command.slug}.yaml`));
  const store = openStore(join(stateDir, "goals.db"));

  try {
    store.upsertGoal(goal);

    if (command.kind === "start") {
      // 終端の Goal を黙って ACTIVE に戻さない。nextStatus と tick は終端を
      // 守るのに、この経路だけ素通りしていた。COMPLETED を後から取り消せると、
      // §9 の完了判定そのものが意味を失う。
      const current = store.getState(goal.goal.id);
      if (current !== null && isTerminal(current.status)) {
        process.stderr.write(
          `${goal.goal.id} は ${current.status} なので start できない。` +
            "やり直すなら .goals/.state/goals.db の状態を明示的に戻すこと\n",
        );
        return 2;
      }

      const now = new Date().toISOString();
      store.setStatus(goal.goal.id, "ACTIVE", null, now);
      process.stdout.write(`${goal.goal.id}: ACTIVE\n`);
      return 0;
    }

    if (command.kind === "show") {
      process.stdout.write(`${JSON.stringify(showPayload(goal, store), null, 2)}\n`);
      return 0;
    }

    // 観測対象。指定があったものだけ書き換え、指定が無い方は前回の値を保つ。
    // 片方だけ渡したときにもう片方が消えると、次のティックが観測をやめる。
    if (command.prNumber !== undefined || command.issueNumber !== undefined) {
      const current = store.getState(goal.goal.id);
      store.setObserveTarget(
        goal.goal.id,
        command.prNumber ?? current?.prNumber ?? null,
        command.issueNumber ?? current?.issueNumber ?? null,
      );
    }

    // SIGTERM を受けたら走行中の Actor に伝播する。Ctrl+C が効かない状態を作らない。
    const aborter = new AbortController();
    const stop = (): void => aborter.abort();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    const result = await tick(goal, {
      store,
      owner: `${hostname()}:${process.pid}`,
      leaseSeconds: 300,
      signal: aborter.signal,
      code: codeProvider(goal),
      writer: codeWriter(goal),
      branch: gitBranch(join(stateDir, "worktrees")),
      local: localRepo(verifyRoot(stateDir, goal)),
      command: commandRunner(verifyRoot(stateDir, goal)),
      // 承認はレビュー承認と PR コメントの定型文の2つで検知する（design.md §10-4）。
      // PR がまだ無い Goal では常に未承認になる。捏造した承認を作らない。
      approval: approval(goal, store.getState(goal.goal.id)?.prNumber ?? null),
      worktree: gitWorktree(repoRoot, join(stateDir, "worktrees")),
      worktreeRoot: join(stateDir, "worktrees"),
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
    });

    process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `ent show` が出すもの。宣言部と実行時状態をマージして1枚にする（design.md §4.6）。
 *
 * 初めて ent run を全周させたとき、失敗の理由を追うのに SQLite を直接叩くことに
 * なった。goals の行だけでは、何を観測して何を確かめられなかったのかが読めない。
 *
 * 出力は JSON のままにする。人向けの整形は後から足せるが、機械可読を失うと
 * 検証コマンドから使えなくなる。
 */
export interface ShowPayload {
  goal: Goal["goal"];
  state: GoalState | null;
  /** 直近の観測。facts と unresolved を組で出す（design.md §3.1） */
  snapshot: Snapshot | null;
  /** criteria 単位の検証結果。§9 の完了判定が読む索引 */
  verifications: Verification[];
  /** 直近の判断。過去の分は listDecisions で引ける */
  decision: Decision | null;
  runs: Run[];
  /** DECIDE が使ったトークン。Run には出てこない分（design.md §7） */
  llm: { calls: number; tokens: number };
}

export function showPayload(goal: Goal, store: Store): ShowPayload {
  const decisions = store.listDecisions(goal.goal.id);
  const calls = store.listLlmCalls(goal.goal.id);

  return {
    goal: goal.goal,
    state: store.getState(goal.goal.id),
    snapshot: store.latestSnapshot(goal.goal.id),
    verifications: store.latestVerifications(goal.goal.id),
    decision: decisions.at(-1) ?? null,
    runs: store.listRuns(goal.goal.id),
    llm: {
      calls: calls.length,
      tokens: calls.reduce((total, call) => total + call.tokens, 0),
    },
  };
}

/**
 * `ent list` が出すもの。Store.listGoals をそのまま JSON にできる形で返す。
 *
 * cron から回す構成では、どの Goal が ACTIVE でどれが WAITING_HUMAN かを
 * まとめて見る手段が要る。Goal ごとに ent show を叩く手間を無くす。
 */
export function listPayload(store: Store): GoalListItem[] {
  return store.listGoals();
}

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
  /** `.goals/*.yaml` を読んで、slug ごとの成否を返す */
  loadGoals: () => Promise<DoctorGoal[]>;
  /** state ディレクトリに書けるか */
  stateWritable: () => Promise<boolean>;
}

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
 * 出力は JSON にする。ent show / ent list と同じく機械可読を保つ。
 */
export async function doctorPayload(probes: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    githubTokenCheck(probes),
    await goalsCheck(probes),
    await stateDirCheck(probes),
    claudeLoginCheck(),
  ];

  return {
    checks,
    // unknown は数えない。分からないものを不合格に畳まない。
    exitCode: checks.some((check) => check.result === "failed") ? 1 : 0,
  };
}

function githubTokenCheck(probes: DoctorProbes): DoctorCheck {
  const token = probes.githubToken();
  if (token === null || token === "") {
    return {
      name: "github_token",
      result: "failed",
      detail:
        "GITHUB_TOKEN も GH_TOKEN も無い。github.pr.* と github.ci.* が観測できず、" +
        "type: fact の criteria は永久に unobserved のままになる。PR の作成とコメントも通らない",
    };
  }
  return {
    name: "github_token",
    result: "ok",
    detail: "GITHUB_TOKEN が設定されている（値は出さない）",
  };
}

async function goalsCheck(probes: DoctorProbes): Promise<DoctorCheck> {
  let goals: DoctorGoal[];
  try {
    goals = await probes.loadGoals();
  } catch (error) {
    return {
      name: "goals",
      result: "failed",
      detail: `.goals/ を読めなかった: ${errorMessage(error)}`,
    };
  }

  // どの slug が、なぜ読めなかったかを残す。件数だけでは直せない。
  const broken = goals.filter((goal) => goal.error !== null);
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
    detail: `.goals/*.yaml を ${goals.length} 件読めた`,
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

/** 実際のファイルと環境変数を読む口。テストからは差し替える */
function doctorProbes(repoRoot: string, stateDir: string): DoctorProbes {
  return {
    githubToken,
    loadGoals: async () => loadGoalSummaries(join(repoRoot, ".goals")),
    stateWritable: async () => isWritable(stateDir),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(result: TickResult): unknown {
  return {
    ran: result.ran,
    // 回さなかった理由。「寝ている」「他のワーカーが処理中」「終端」は
    // どれも ran: false になるので、これが無いと cron のログから区別できない。
    skipped: result.skipped,
    reclaimed: result.reclaimed,
    status: result.status,
    action: result.decision?.action ?? null,
    rationale: result.decision?.rationale ?? null,
    run: result.run === null ? null : { id: result.run.id, status: result.run.status },
  };
}

/**
 * GitHub に繋ぐ。トークンが無ければ throw する Port を返す。
 *
 * 捏造した観測を返すより、落として unobserved に残した方が状態が正しく残る
 * （design.md §3.1）。
 */
function codeProvider(goal: Goal): CodeProviderPort {
  const token = githubToken();
  if (token === null) {
    const fail = async (): Promise<never> => {
      throw new PortError("unavailable", "GITHUB_TOKEN が設定されていない");
    };
    return { getPullRequest: fail, getLatestCiRun: fail, getIssue: fail };
  }

  return githubCodeProvider({
    owner: goal.repository.owner,
    repo: goal.repository.name,
    token,
  });
}

/**
 * GitHub の書き込み側。read と分けてある（design.md §4.1）。
 *
 * トークンが無ければ呼ばれた時点で throw する。publish はそれを握って
 * skipped の理由に変えるので、通知に失敗してもティックは最後まで回る。
 */
function codeWriter(goal: Goal): CodeWriterPort {
  const token = githubToken();
  if (token === null) {
    const fail = async (): Promise<never> => {
      throw new PortError("unavailable", "GITHUB_TOKEN が設定されていない");
    };
    return { findPullRequest: fail, createPullRequest: fail, addComment: fail };
  }

  return githubCodeWriter({
    owner: goal.repository.owner,
    repo: goal.repository.name,
    token,
  });
}

/**
 * 人間の承認。PR コメントの `/ent approve <criterion-id>` を signal にする。
 *
 * PR もトークンも無ければ、常に未承認を返す Port にする。
 * 「確かめられなかった」を「承認された」と読まないため（design.md §3.1）。
 */
function approval(goal: Goal, prNumber: number | null): ApprovalPort {
  const token = githubToken();
  if (token === null || prNumber === null) {
    return pendingApproval();
  }

  return githubApproval({
    owner: goal.repository.owner,
    repo: goal.repository.name,
    token,
    prNumber,
  });
}

/**
 * 検証コマンドとローカル観測を流す場所。
 *
 * Goal 専用の worktree があればそちらを使う。無ければ controller のリポジトリ。
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
  const worktree = join(stateDir, "worktrees", goal.goal.id);
  return existsSync(worktree) ? worktree : process.cwd();
}

function githubToken(): string | null {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token === undefined || token === "" ? null : token;
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

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
