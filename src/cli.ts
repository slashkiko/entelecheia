import { mkdirSync } from "node:fs";
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
  if (sub !== "start" && sub !== "run" && sub !== "show" && sub !== "list") {
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

    if (sub === "list") {
      // list は slug を取らない。余分な引数は打ち間違いとして error にする。
      if (positionals.length > 0) {
        return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
      }
      return { kind: "list" };
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
      local: localRepo(repoRoot),
      command: commandRunner(repoRoot),
      // 承認は PR コメントの定型文で検知する（design.md §10-4）。
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
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token === "") {
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
