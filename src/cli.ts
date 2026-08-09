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
import { type ControllerDeps, type TickResult, tick } from "./controller/index.js";
import type { Decision } from "./domain/action.js";
import { type Goal, SLUG } from "./domain/goal.js";
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
const DEFAULT_LIMIT = 50;

const USAGE = `ent — Declare the end state; the controller converges to it.

  ent start <slug>     Goal を登録して ACTIVE にする
  ent run <slug>       1ティック回して終了する（--once は既定）
                       --pr <n> / --issue <n> で観測対象を指定する
                       --dry-run で、書かずに次のティックの中身だけを見る
  ent get <slug>       宣言部と実行時状態をまとめて表示する
  ent list             登録済みの Goal を一覧する
  ent doctor           回す前の前提が揃っているかを読み取り専用で調べる
  ent agent-context    CLI の構造を機械可読な JSON で出す

  --json               出力を JSON にする（run / get / list は既定で JSON）
  --limit <n>          出力の件数を絞る（get / list。既定は ${String(DEFAULT_LIMIT)}）
`;

/** エージェントが叩けるサブコマンド。エラーはこの集合をそのまま並べる（gist 2.3） */
const SUBCOMMANDS = ["start", "run", "get", "list", "doctor", "agent-context"] as const;
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
  /**
   * 回す前の前提を調べる。slug は取らず、副作用も持たない。
   *
   * どの Goal にも共通する前提（トークン・Goal YAML・state ディレクトリ）だけを見るので、
   * 特定の Goal を指す必要が無い。
   */
  | { kind: "doctor" }
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
    if (sub === "list" || sub === "doctor" || sub === "agent-context") {
      if (positionals.length > 0) {
        return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
      }
      if (sub === "agent-context") {
        return { kind: "agent-context" };
      }
      if (sub === "doctor") {
        return { kind: "doctor" };
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
    if (!SLUG.test(slug)) {
      // slug はそのまま `.goals/<slug>.yaml` のパスになる。`../` を通すと
      // ツリーの外の Goal を読めてしまい、その `setup` と `verification.run` が
      // controller の権限でシェルに流れる。id 一致の検査はファイル名しか見ず、
      // ディレクトリを縛らないので、そこでは止まらない。
      return {
        kind: "error",
        message: `slug の形が不正: ${slug}（kebab-case のみ。パス区切りは使えない）`,
      };
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
    case "doctor":
    case "agent-context":
      // どちらも調べた結果を出すだけ。常に JSON で、絞る対象も無い。
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
/**
 * CLI の入口。終了コードの契約はここで閉じる。
 *
 * 以前は throw がそのまま呼び出し元へ抜け、1 を返していたのはモジュール末尾の
 * エントリだった。`agent-context` が「終了コードはこれが正」と宣言しているのに、
 * `main()` を呼ぶ側からは 1 を観測できず、テストも書けなかった。実際
 * 「Goal YAML が無い」は 1 と文書化されているのに、`main()` は throw していた。
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

async function runCommand(argv: readonly string[]): Promise<number> {
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

  if (command.kind === "doctor") {
    // 読み取り専用にする。state ディレクトリを作るのも書き込みなので、
    // mkdirSync より前に返す。doctor は調べるだけで、直さない。
    const report = await doctorPayload(doctorProbes(repoRoot, stateDir));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }

  // --dry-run は覗くだけ。state ディレクトリを作るのも DB を作るのも書き込みなので、
  // ここより前に返す。SKILL.md は「Actor の起動と PR への書き込みは起きない。
  // snapshot / verifications / decision / status も書かない」と書いている。
  if (command.kind === "run" && command.dryRun === true) {
    return previewOnly(command, repoRoot, stateDir);
  }

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
    // run は登録済みの Goal だけを進める。upsert より先に見る。
    //
    // design.md は「Goal YAML のレビューがそのまま承認ゲートを担うので、
    // ent start は DRAFT から ACTIVE に直行する」と書いている。ここで先に
    // upsert していたので tick 側の「Goal が登録されていない」は本番で到達せず、
    // start を挟まない run が Actor を起動して予算を使い、1ティックで
    // DRAFT から COMPLETED まで進めた。唯一の承認ゲートが飛ばせていた。
    if (command.kind === "run" && store.getState(goal.goal.id) === null) {
      process.stderr.write(
        `${goal.goal.id} は登録されていない。先に ent start ${goal.goal.id} を叩くこと\n`,
      );
      process.stdout.write(`${JSON.stringify(summarize(draftIdle()), null, 2)}\n`);
      return 0;
    }

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
        // 2 ではなく 1 を返す。2 は「引数が不正」で、SKILL.md はそこに
        // 「stderr に有効値が並ぶ」と書いている。argv は妥当で打ち直せる値も
        // 無いので、2 を返すとエージェントが argv を変えて無限に再試行する。
        // 実行できない状態は 1 にあたる。
        return 1;
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
      ...tickPorts(goal, store, repoRoot, stateDir),
      store,
      signal: aborter.signal,
    });

    process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * ティックに渡す Port 一式。
 *
 * 通常のティックと `--dry-run` の両方から呼ぶ。以前は呼び出し側それぞれが
 * 同じ組み立てを書いていて、片方にだけ Port を足すと dry-run が本番と違う
 * 配管を見ることになった。dry-run の用途が「配管が繋がっているか」なので、
 * そこがずれると道具の意味が無くなる。
 */
function tickPorts(
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
 * 登録されていない Goal に対して返すティック結果。
 *
 * `tick()` が state を読めなかったときに返すものと同じ形にする。DB を作らずに
 * 同じことを言う必要があるので、ここで組み立てる。
 */
function draftIdle(): TickResult {
  return {
    ran: false,
    skipped: "Goal が登録されていない",
    reclaimed: 0,
    decision: null,
    run: null,
    status: "DRAFT",
  };
}

/**
 * `ent run <slug> --dry-run` の本体。何も書かずに次のティックの中身だけを出す。
 *
 * 通常の経路と分けてあるのは、書き込みが tick() より前に3つあったため。
 * state ディレクトリの作成・DB を開くこと（無ければ作られる）・upsertGoal と
 * setObserveTarget がそれにあたる。とくに setObserveTarget は、覗いたつもりの
 * `--dry-run --pr 42` が観測先を恒久的に差し替え、次の本番ティックが違う PR を
 * 見る状態を作っていた。`--pr` / `--issue` は永続化せず、この1回にだけ効かせる。
 */
async function previewOnly(
  command: Extract<Command, { kind: "run" }>,
  repoRoot: string,
  stateDir: string,
): Promise<number> {
  const goal = loadGoalFile(join(repoRoot, ".goals", `${command.slug}.yaml`));
  const dbPath = join(stateDir, "goals.db");

  if (!existsSync(dbPath)) {
    // DB を開くと作られる。作るのも書き込みなので、その前に返す。
    process.stdout.write(
      `${JSON.stringify(summarize({ ...draftIdle(), dryRun: true }), null, 2)}\n`,
    );
    return 0;
  }

  const store = openStore(dbPath);
  try {
    const result = await tick(goal, {
      ...tickPorts(goal, store, repoRoot, stateDir),
      store,
      dryRun: true,
      observeOverride: {
        ...(command.prNumber === undefined ? {} : { prNumber: command.prNumber }),
        ...(command.issueNumber === undefined ? {} : { issueNumber: command.issueNumber }),
      },
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
    /**
     * 同じサブコマンドを指す、いま実際に叩ける別名。
     *
     * 通らなくなった名前はここに載せない。ここを読んで組み立てたコマンドが
     * 通らないなら、Layer 2 は --help より当てにならないものになる。
     * 打ち直す先は、不明なサブコマンドのエラーが有効値を並べることで伝わる。
     */
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
        name: "doctor",
        summary: "回す前の前提が揃っているかを読み取り専用で調べる",
        args: [],
        flags: [],
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
      { code: 0, meaning: "成功。ティックが最後まで回った（doctor では failed が1件も無い）" },
      {
        code: 1,
        meaning:
          "実行時エラー、または実行できない状態。詳細は stderr（doctor では stdout の JSON）",
      },
      { code: 2, meaning: "引数が不正。stderr に有効値が出る" },
    ],
  };
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // main() が終了コードの契約を閉じているので、ここでは受け取るだけにする。
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
