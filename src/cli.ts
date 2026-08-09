import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
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

/**
 * 出力の既定の上限（gist 2.5）。`--limit` で上げ下げできる。
 *
 * 上限が無いと、Goal が増えるほど1回の出力がエージェントのコンテキストを食う。
 * 切り捨てたときは絞り込み方を stderr に出すので、足りないことには気づける。
 */
export const DEFAULT_LIMIT = 50;

export const USAGE = `ent — Declare the end state; the controller converges to it.

  ent start <slug>     Goal を登録して ACTIVE にする
  ent run <slug>       1ティック回して終了する（--once は既定）
                       --pr <n> / --issue <n> で観測対象を指定する
                       --dry-run で、書かずに次のティックの中身だけを見る
  ent get <slug>       宣言部と実行時状態をまとめて表示する
  ent list             登録済みの Goal を一覧する
  ent agent-context    CLI の構造を機械可読な JSON で出す

  --json               出力を JSON にする（run / get / list は既定で JSON）
  --limit <n>          出力の件数を絞る（get / list。既定は ${String(DEFAULT_LIMIT)}）
`;

/** エージェントが叩けるサブコマンド。エラーはこの集合をそのまま並べる（gist 2.3） */
const SUBCOMMANDS = ["start", "run", "get", "list", "agent-context"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export type Command =
  /** Goal を登録して ACTIVE にする */
  | { kind: "start"; slug: string; json?: true }
  /**
   * 1ティック回して終了する。--once は既定で、常駐する形は用意しない。
   *
   * prNumber / issueNumber は「指定があった場合だけ」入る。未指定と「明示的に
   * 対象なし」を区別するため、null ではなく未設定にしてある。未指定なら前回の値を保つ。
   *
   * dryRun / json も同じく指定があったときだけ入る。必ず持たせると、
   * 既存のテストが仕様として固定した解釈（`{ kind: "run", slug }`）が壊れる。
   */
  | {
      kind: "run";
      slug: string;
      prNumber?: number;
      issueNumber?: number;
      dryRun?: true;
      json?: true;
    }
  /**
   * 宣言部と実行時状態をマージして1枚で出す。
   *
   * 打つのは `ent get <slug>`。判別タグは show のまま変えない。エージェントが
   * 揃えたいのはサブコマンド名であって、内部の識別子ではない。
   */
  | { kind: "show"; slug: string; limit?: number; json?: true }
  /** 登録済みの Goal を一覧する。slug は取らない */
  | { kind: "list"; limit?: number; json?: true }
  /** CLI の構造を機械可読な JSON で出す（gist 3.2 Layer 2）。slug は取らない */
  | { kind: "agent-context" }
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
  if (sub === "show") {
    // 別名としても残さない。同じ操作に2つ名前があると、どちらが正かを
    // 確かめる分だけ無駄が出る（gist 3.1）。打ち直す先はここで示す。
    return { kind: "error", message: "show は get に変わった: ent get <slug>" };
  }
  if (!isSubcommand(sub)) {
    // 黙って無視すると、打ち間違いが「何も起きなかった」に見える。
    // 推測させても無駄な再試行になるので、有効値をその場で全部並べる（gist 2.3）。
    return {
      kind: "error",
      message: `不明なサブコマンド: ${sub}（使えるのは ${SUBCOMMANDS.join(" / ")}）`,
    };
  }

  try {
    const { positionals, values } = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: optionsFor(sub),
      strict: true,
    });

    const json = values.json === true ? ({ json: true } as const) : {};

    // slug を取らないサブコマンド。余分な引数は打ち間違いとして error にする。
    if (sub === "list" || sub === "agent-context") {
      if (positionals.length > 0) {
        return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
      }
      if (sub === "agent-context") {
        return { kind: "agent-context" };
      }
      const limit = positiveInteger(values.limit, "--limit");
      if (typeof limit === "string") {
        return { kind: "error", message: limit };
      }
      return { kind: "list", ...(limit === undefined ? {} : { limit }), ...json };
    }

    const slug = positionals[0];
    if (slug === undefined) {
      // どの Goal を回すかは既定値で埋められない。打ち直せる形を添える（gist 2.3）。
      return { kind: "error", message: `${sub} には Goal の slug が要る: ent ${sub} <slug>` };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
    }

    if (sub === "start") {
      return { kind: "start", slug, ...json };
    }

    if (sub === "get") {
      const limit = positiveInteger(values.limit, "--limit");
      if (typeof limit === "string") {
        return { kind: "error", message: limit };
      }
      return { kind: "show", slug, ...(limit === undefined ? {} : { limit }), ...json };
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
      ...(values["dry-run"] === true ? ({ dryRun: true } as const) : {}),
      ...json,
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * サブコマンドごとに受け取るオプション。
 *
 * JSON 出力の指定は `--json` ひとつにする。`--format=json` や `--output json` は
 * 増やさない。表記が複数あると、どれが効くかを確かめる分だけ無駄が出る（gist 2.2 / 3.1）。
 *
 * --once は既定の挙動を明示するだけで、受け取っても何も変えない。
 * 常駐する形は用意しない（design.md §3.6）。
 *
 * --pr / --issue は観測対象。Goal YAML は宣言部だけを持つので置き場が無く、
 * controller が PR を作れるようになるまでは人間が渡す。
 */
function optionsFor(sub: Subcommand): ParseArgsOptions {
  switch (sub) {
    case "start":
      return { json: { type: "boolean" } };
    case "run":
      return {
        json: { type: "boolean" },
        once: { type: "boolean" },
        "dry-run": { type: "boolean" },
        pr: { type: "string" },
        issue: { type: "string" },
      };
    case "get":
    case "list":
      return { json: { type: "boolean" }, limit: { type: "string" } };
    case "agent-context":
      // 構造を出すだけなので常に JSON。絞る対象も無い。
      return {};
  }
}

type ParseArgsOptions = Record<string, { type: "boolean" | "string" }>;

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
  if (command.kind === "agent-context") {
    // CLI の構造を出すだけなので、Goal も DB も読まない。
    process.stdout.write(`${JSON.stringify(agentContextPayload(), null, 2)}\n`);
    return 0;
  }

  const repoRoot = process.cwd();
  const stateDir = join(repoRoot, ".goals", ".state");
  mkdirSync(join(stateDir, "worktrees"), { recursive: true });

  if (command.kind === "list") {
    // list は slug を取らない。Goal YAML を読まずに DB だけ見る。
    const store = openStore(join(stateDir, "goals.db"));
    try {
      const items = listPayload(store, { limit: command.limit });
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      writeTruncationHint(items.length, store.listGoals().length);
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
      // --json を渡さないときの出力は変えない。cron と既存の呼び出しが読んでいる。
      process.stdout.write(
        command.json === true
          ? `${JSON.stringify({ id: goal.goal.id, status: "ACTIVE" }, null, 2)}\n`
          : `${goal.goal.id}: ACTIVE\n`,
      );
      return 0;
    }

    if (command.kind === "show") {
      const payload = showPayload(goal, store, { limit: command.limit });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      writeTruncationHint(payload.runs.length, store.listRuns(goal.goal.id).length);
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
      // 何が起きるかを、起こす前に見るだけにする。ACT と publish と永続化を飛ばす。
      dryRun: command.dryRun === true,
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

/** 出力を絞る指定。指定が無ければ DEFAULT_LIMIT で切る（gist 2.5） */
export interface LimitOptions {
  limit?: number | undefined;
}

export function showPayload(goal: Goal, store: Store, options: LimitOptions = {}): ShowPayload {
  const decisions = store.listDecisions(goal.goal.id);
  const calls = store.listLlmCalls(goal.goal.id);
  const runs = store.listRuns(goal.goal.id);
  const limit = options.limit ?? DEFAULT_LIMIT;

  return {
    goal: goal.goal,
    state: store.getState(goal.goal.id),
    snapshot: store.latestSnapshot(goal.goal.id),
    verifications: store.latestVerifications(goal.goal.id),
    decision: decisions.at(-1) ?? null,
    // 落とすなら古い方から落とす。直近の失敗を追うために読むものなので、
    // 新しい方を残す（listRuns は古い順に返す）。
    runs: runs.length <= limit ? runs : runs.slice(-limit),
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
export function listPayload(store: Store, options: LimitOptions = {}): GoalListItem[] {
  const goals = store.listGoals();
  const limit = options.limit ?? DEFAULT_LIMIT;
  return goals.length <= limit ? goals : goals.slice(0, limit);
}

/**
 * 切り捨てが起きたときだけ、絞り込み方を返す。全部出たなら null。
 *
 * 「全部出た」と「途中で切れた」が同じ見た目だと、読む側は足りない分に気づけない。
 * 逆に毎回出すと、切れていないときまでノイズになる（gist 2.5）。
 *
 * 返す文面は stderr に出す。stdout に混ぜると JSON が壊れる（gist 4.3）。
 */
export function truncationHint(shown: number, total: number, flag: string): string | null {
  if (total <= shown) {
    return null;
  }
  return `${total} 件のうち ${shown} 件だけ出した。全部読むなら ${flag} <n> で上限を上げる`;
}

/**
 * `ent agent-context` が出すもの（gist 3.2 Layer 2）。
 *
 * 散文の --help から「何が叩けるか」を推測させないための、機械可読な CLI の構造。
 * 読ませる前提のものなので短く保つ。長い説明文はそのままコンテキストを食う。
 */
export interface AgentContext {
  /** 増えたのか壊れたのかを読む側が区別できるように版を持たせる */
  schemaVersion: number;
  commands: {
    name: string;
    /** 打ち直す先が分かるように、通らなくなった名前も併記する */
    aliases?: string[];
    summary: string;
    args: { name: string; required: boolean; type: string }[];
    flags: { name: string; type: string; summary: string }[];
  }[];
  env: { name: string; required: boolean; summary: string }[];
  exitCodes: { code: number; meaning: string }[];
}

const JSON_FLAG = { name: "--json", type: "boolean", summary: "JSON で出す" } as const;
const LIMIT_FLAG = {
  name: "--limit",
  type: "integer",
  summary: `出力の件数（既定 ${String(DEFAULT_LIMIT)}）`,
} as const;

export function agentContextPayload(): AgentContext {
  const slug = { name: "slug", required: true, type: "string" } as const;

  return {
    schemaVersion: 1,
    commands: [
      {
        name: "start",
        summary: "Goal を登録して ACTIVE にする",
        args: [slug],
        flags: [JSON_FLAG],
      },
      {
        name: "run",
        summary: "1ティックだけ回して終了する。常駐しないので繰り返し叩く",
        args: [slug],
        flags: [
          JSON_FLAG,
          { name: "--dry-run", type: "boolean", summary: "書かずに次のティックの中身を見る" },
          { name: "--pr", type: "integer", summary: "観測する PR 番号" },
          { name: "--issue", type: "integer", summary: "観測する Issue 番号" },
        ],
      },
      {
        name: "get",
        aliases: ["show"],
        summary: "宣言部と実行時状態をまとめて出す",
        args: [slug],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "list",
        summary: "登録済みの Goal を一覧する",
        args: [],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "agent-context",
        summary: "この構造そのものを出す",
        args: [],
        flags: [],
      },
    ],
    env: [
      { name: "GITHUB_TOKEN", required: false, summary: "無いと GitHub の観測が unresolved" },
      { name: "ENT_MODEL", required: false, summary: "DECIDE のモデル" },
      { name: "ENT_EFFORT", required: false, summary: "low / medium / high / xhigh / max" },
    ],
    exitCodes: [
      { code: 0, meaning: "成功。ティックが最後まで回った" },
      { code: 1, meaning: "実行時エラー。詳細は stderr" },
      { code: 2, meaning: "引数が不正。stderr に有効値が出る" },
    ],
  };
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
    // dry-run は DB に残さないので、ここで出さなければ読む手段が無い。
    // 通常のティックでは増やさない。既存の呼び出しが読んでいる形を変えない。
    ...(result.dryRun === true
      ? {
          dryRun: true,
          wouldTransitionTo: result.wouldTransitionTo ?? null,
          observed: result.observed ?? null,
        }
      : {}),
  };
}

/**
 * 切り捨てが起きたときだけ、絞り込み方を stderr に出す。
 *
 * stdout は JSON 専用にする。診断を混ぜると、そのまま jq に渡せなくなる（gist 4.3）。
 */
function writeTruncationHint(shown: number, total: number): void {
  const hint = truncationHint(shown, total, "--limit");
  if (hint !== null) {
    process.stderr.write(`${hint}\n`);
  }
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
