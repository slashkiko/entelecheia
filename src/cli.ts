#!/usr/bin/env node
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import { worktreeNameFor } from "./act/index.js";
import { type ClaudeOptions, claudeActor, claudeLlm } from "./adapters/claude.js";
import { githubApproval, githubCodeProvider, githubCodeWriter } from "./adapters/github.js";
import {
  commandRunner,
  findGitRoot,
  gitBranch,
  gitWorktree,
  localRepo,
  pendingApproval,
  STATE_IGNORE_LINE,
  stateDirIgnored,
} from "./adapters/local.js";
import { type ControllerDeps, type TickResult, tick } from "./controller/index.js";
import type { Decision } from "./domain/action.js";
import { errorMessage } from "./domain/error-message.js";
import { type Goal, goalTemplate, SLUG, TEMPLATE_SLUG } from "./domain/goal.js";
import { loadGoalFile } from "./domain/goal-loader.js";
import { isTerminal } from "./domain/goal-state.js";
import { PortError } from "./domain/port-error.js";
import type { Run } from "./domain/run.js";
import type { Verification } from "./domain/verification.js";
import type { CodeProviderPort } from "./observe/index.js";
import type { CodeWriterPort, ProgressSink } from "./publish/index.js";
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

  ent init             いまのリポジトリを ent で回せる状態にする（冪等）
  ent start <slug>     Goal を登録して ACTIVE にする
  ent run <slug>       1ティック回して終了する（--once は既定）
                       --pr <n> / --issue <n> で観測対象を指定する
                       --dry-run で、書かずに次のティックの中身だけを見る
                       --report stdout|<path> で、進捗を PR に投稿せず手元に出す
  ent get <slug>       宣言部と実行時状態をまとめて表示する
  ent abandon <slug>   もう追わないと宣言して終端にする（--reason は必須）
  ent list             登録済みの Goal を一覧する
  ent doctor           回す前の前提が揃っているかを読み取り専用で調べる
  ent agent-context    CLI の構造を機械可読な JSON で出す

  --json               出力を JSON にする（run / get / list は既定で JSON）
  --limit <n>          出力の件数を絞る（get / list。既定は ${String(DEFAULT_LIMIT)}）
`;

/** エージェントが叩けるサブコマンド。エラーはこの集合をそのまま並べる（gist 2.3） */
const SUBCOMMANDS = [
  "init",
  "start",
  "run",
  "get",
  "abandon",
  "list",
  "doctor",
  "agent-context",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export type Command =
  /**
   * いまのリポジトリを ent で回せる状態にする。slug は取らない。
   *
   * どの Goal の話でもないので slug を受け取る理由が無く、`--force` のような
   * 上書きの口も持たない。2度目は既にあるものを一切書き換えずに 0 で返る。
   */
  | { kind: "init"; json?: true }
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
      /** 進捗の宛先。指定があったときだけ入る。無ければ PR コメント */
      report?: ReportTarget;
      json?: true;
    }
  /**
   * 宣言部と実行時状態をマージして1枚で出す。
   *
   * 打つのは `ent get <slug>`。判別タグは show のまま変えない。エージェントが
   * 揃えたいのはサブコマンド名であって、内部の識別子ではない。
   */
  | { kind: "show"; slug: string; limit?: number; json?: true }
  /**
   * もう追わないと宣言して ABANDONED にする。
   *
   * `reason` は任意項目にしない。理由の無い ABANDONED は、後から読む人に
   * 「なぜ出荷済みの Goal が放棄されているのか」を伝えない。省略できる形にすると
   * 書かれないので、ここが `sqlite3` を直接叩くのとの差になる。
   *
   * **対になる `complete` は作らない。** design.md §3.1「完了判定は VERIFIED のみ」は
   * `decide` が LLM にすら COMPLETE を選ばせない根拠で、CLI に足すと赤い criteria を
   * 1コマンドで飛び越える経路が公式の口になる。書ける終端を選べる形（`--status`）にも
   * しない。ここから書けるのは ABANDONED だけ。
   */
  | { kind: "abandon"; slug: string; reason: string; json?: true }
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
 * `--report` の宛先。
 *
 * `stdout` だけを予約語にして、それ以外はファイルのパスとして読む。`stdout` という
 * 名前のファイルには書けなくなるが、`--report ./stdout` と書けば通る。逆に
 * `--report-file` と `--report-stdout` の2つに割ると、同じ操作に名前が2つできる（gist 3.1）。
 */
export type ReportTarget = { kind: "stdout" } | { kind: "file"; path: string };

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
    if (sub === "init" || sub === "list" || sub === "doctor" || sub === "agent-context") {
      if (positionals.length > 0) {
        return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
      }
      if (sub === "agent-context") {
        return { kind: "agent-context" };
      }
      if (sub === "doctor") {
        return { kind: "doctor" };
      }
      if (sub === "init") {
        return { kind: "init", ...json };
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

    if (sub === "abandon") {
      // 空白だけも弾く。必須にしても空文字で通れば、結局は書かれない。
      const reason = typeof values.reason === "string" ? values.reason.trim() : "";
      if (reason === "") {
        return {
          kind: "error",
          message: `abandon には理由が要る: ent abandon ${slug} --reason "<なぜ追わないのか>"`,
        };
      }
      return { kind: "abandon", slug, reason, ...json };
    }

    const prNumber = positiveInteger(values.pr, "--pr");
    if (typeof prNumber === "string") {
      return { kind: "error", message: prNumber };
    }
    const issueNumber = positiveInteger(values.issue, "--issue");
    if (typeof issueNumber === "string") {
      return { kind: "error", message: issueNumber };
    }

    const dryRun = values["dry-run"] === true;
    const report = reportTarget(values.report);
    if (typeof report === "string") {
      return { kind: "error", message: report };
    }
    if (report !== undefined && dryRun) {
      // dry-run は publish を通らないので、受け取っても書く先に届かない。
      // 黙って無視すると「指定したのに何も出ない」になる（gist 2.3）。
      return {
        kind: "error",
        message:
          "--dry-run と --report は一緒に使えない。--dry-run は publish を通らないので進捗を書かない" +
          "（criteria の結果は出力の observed.verifications に入る）",
      };
    }

    return {
      kind: "run",
      slug,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(issueNumber === undefined ? {} : { issueNumber }),
      ...(dryRun ? ({ dryRun: true } as const) : {}),
      ...(report === undefined ? {} : { report }),
      ...json,
    };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

/**
 * 「もう追わない」と宣言して終端にする。
 *
 * 満たすべき性質:
 * - 書けるのは status（ABANDONED）と理由だけ。観測の履歴には触らない。
 *   snapshots / facts / verifications は「最後のティックが何を見たか」の記録で、
 *   書き換えるのは観測の捏造になる（design.md §3.1）
 * - 落とせない場合は何も書かずに 1 を返す。部分的に書いて失敗しない
 * - 完了は名乗らせない。ここから書ける終端は ABANDONED だけで、対になる
 *   `complete` は用意しない
 *
 * `upsertGoal` を通さずに呼ぶ。降りるのは実行時状態の話なので宣言部を書き直す
 * 理由が無く、通すと未登録の Goal に DRAFT の行ができてしまう。
 */
function abandonGoal(
  command: { slug: string; reason: string; json?: true },
  goal: Goal,
  store: Store,
): number {
  const current = store.getState(goal.goal.id);

  // 回したことのない Goal を終端にすると、「一度も動いていないのに放棄済み」
  // という読めない記録ができる。
  if (current === null) {
    process.stderr.write(
      `${goal.goal.id} は登録されていない。降りる先の状態が無い（ent start から始める）\n`,
    );
    return 1;
  }

  // 終端から別の終端へ移さない。design.md §4.4 は「終端の Goal を ACTIVE に
  // 戻さない。COMPLETED を後から取り消せると、完了判定そのものが意味を失う」と
  // 書いている。COMPLETED を ABANDONED で塗り替えられるなら、同じことになる。
  if (isTerminal(current.status)) {
    process.stderr.write(
      `${goal.goal.id} は既に ${current.status} なので abandon できない。終端は塗り替えない\n`,
    );
    return 1;
  }

  // lease を持っているなら、別のプロセスがそのティックを回している。
  // 横から終端へ落とすと、走っている controller が終端の Goal に書き戻す。
  if (current.leaseOwner !== null) {
    process.stderr.write(
      `${goal.goal.id} は ${current.leaseOwner} が回している。` +
        "終わるのを待つか、lease が切れてから叩くこと\n",
    );
    return 1;
  }

  store.abandon(goal.goal.id, command.reason);
  process.stdout.write(
    command.json === true
      ? `${JSON.stringify({ id: goal.goal.id, status: "ABANDONED", reason: command.reason }, null, 2)}\n`
      : `${goal.goal.id}: ABANDONED（${command.reason}）\n`,
  );
  return 0;
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
    case "init":
      // `--force` は置かない。上書きできる口があると、人間が埋めた宣言部を
      // 消す経路が公式のものになる。2度目は黙って既存を残す。
      return { json: { type: "boolean" } };
    case "start":
      return { json: { type: "boolean" } };
    case "run":
      return {
        json: { type: "boolean" },
        once: { type: "boolean" },
        "dry-run": { type: "boolean" },
        pr: { type: "string" },
        issue: { type: "string" },
        // 進捗を PR に投稿せず、手元に出す。書くのは run のティックだけなので、
        // 他のサブコマンドには置かない（付ければ終了コード 2 になる）。
        report: { type: "string" },
      };
    case "get":
    case "list":
      return { json: { type: "boolean" }, limit: { type: "string" } };
    case "abandon":
      // 書ける終端は ABANDONED だけ。`--status` のような、状態を選べる口は
      // 置かない。置いた時点で COMPLETED を書ける経路になる。
      return { json: { type: "boolean" }, reason: { type: "string" } };
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
 * `--report` の値を読む。指定が無ければ undefined、読めなければエラー文字列を返す。
 *
 * 空白だけを「指定しなかった」と同じに畳まない。投稿しないつもりの1回が PR に出る。
 */
function reportTarget(value: unknown): ReportTarget | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    return "--report には宛先が要る: stdout かファイルのパス";
  }
  return raw === "stdout" ? { kind: "stdout" } : { kind: "file", path: raw };
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

  if (command.kind === "init") {
    // Goal も DB も読まない。読める状態を作るのがこのコマンドなので、
    // 読めないことを理由に落とすと最初の1回が通らない。
    return initRepository(repoRoot, command.json === true);
  }

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

    // abandon は upsert より先に片付ける。降りるのは実行時状態の話で、宣言部を
    // 読み直す必要が無い。upsert を通すと未登録の Goal に DRAFT の行ができ、
    // 「一度も動いていないのに放棄済み」という読めない記録を作れてしまう。
    if (command.kind === "abandon") {
      return abandonGoal(command, goal, store);
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

    // 進捗の宛先。指定が無ければ publish は従来どおり PR コメントに書く。
    const record: ReportRecord = { body: null, error: null };
    const report = command.report === undefined ? undefined : reportSink(command.report, record);

    const result = await tick(goal, {
      ...tickPorts(goal, store, repoRoot, stateDir),
      store,
      signal: aborter.signal,
      report,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ...summarize(result),
          ...(command.report === undefined
            ? {}
            : { report: reportPayload(command.report, record) }),
        },
        null,
        2,
      )}\n`,
    );
    if (record.error !== null) {
      // 終了コードは変えない。通知の失敗でティックの成否を塗り替えない
      // （design.md §9）。ただし黙らない。stdout は JSON 専用なので stderr に出す。
      process.stderr.write(`進捗を書けなかった: ${record.error}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * 宛先に書いた結果を CLI 側で控える箱。
 *
 * `publish` は `PublishResult.report` に結果を載せるが、controller はそれを
 * `TickResult` に持ち上げない（通常のティックの出力の形は変えない）。stdout に
 * 出す本文と、書けなかった理由は、ここを通して JSON にする。
 */
export interface ReportRecord {
  /** 書いた本文。宛先が stdout のときだけ JSON に載せる */
  body: string | null;
  /** 書けなかった理由。書けたなら null */
  error: string | null;
}

/**
 * 進捗の宛先を作る。`publish` はここに書くだけで、場所のことは知らない。
 *
 * ファイルは**追記**する。ティックごとの進捗は積み上がるもので、PR コメントも
 * 同じく積む。上書きにすると、cron から回したときに最後の1ティックしか残らない。
 *
 * stdout はここでは書かない。`run` の stdout は JSON 専用（gist 4.3）なので、
 * 素の Markdown を混ぜると `ent run | jq` が壊れる。本文を控えるだけにして、
 * ティックが終わってから JSON の `report.body` に入れる。
 *
 * 書けなかったら throw する。`publish` がそれを握って結果に変えるので、
 * 通知の失敗でティック全体は落ちない。ここで理由も控えるのは、controller が
 * `PublishResult` を持ち上げないため。
 *
 * 宛先の妥当性は見ない。保護パス（`.goals/**` など）を指しても止めないが、関門は
 * すり抜けない——ここに書くのはティックの最後で、関門が前後を比べるのはそれより
 * 前になる。叩いたのは人間で、Agent がこのコマンドを打つ経路も無い。
 */
export function reportSink(target: ReportTarget, record: ReportRecord): ProgressSink {
  return {
    destination: target.kind === "stdout" ? "stdout" : "file",
    write: async (body: string): Promise<void> => {
      record.body = body;
      if (target.kind === "stdout") {
        return;
      }
      try {
        appendFileSync(target.path, `${body}\n\n`);
      } catch (error) {
        record.error = errorMessage(error);
        throw error;
      }
    },
  };
}

/**
 * `--report` を付けたときだけ JSON に足す枝。
 *
 * `written` を必ず持たせる。回らなかったティック（終端・寝ている・他のワーカーが
 * 処理中）では publish を通らないので、宛先には何も書かれない。そこが読めないと、
 * ファイルが空なのが「回らなかった」からなのか「書けなかった」からなのかが
 * 区別できない。
 *
 * 本文を載せるのは stdout のときだけにする。ファイルに出したものを JSON にも
 * 積むと、同じ本文が2箇所に出る。
 */
function reportPayload(target: ReportTarget, record: ReportRecord): unknown {
  // 2つとも要る。`reportSink` は書きに行く**前**に本文を控えるので、body だけでは
  // 「書こうとした」と「書けた」を区別できない。error だけでも足りない——回らなかった
  // ティックでは書きに行かないので、どちらも null のまま残る。
  const written = record.body !== null && record.error === null;
  if (target.kind === "stdout") {
    return { destination: "stdout", written, error: record.error, body: record.body };
  }
  return { destination: "file", path: target.path, written, error: record.error };
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
 * `ent init` が置いたもの1つ分。
 *
 * created と kept を分けて出す。「作った」と「既にあったので触らなかった」が
 * 同じ見た目だと、2度目に叩いた人が上書きされたのかどうかを判断できない。
 */
interface InitEntry {
  /** repoRoot からの相対パス */
  path: string;
  /**
   * `appended` を `created` と分ける。既にある `.gitignore` へ1行足したものを
   * `created` と出すと「新しく作られた」と読めて、既存ファイルを変更した事実が
   * 出力から消える。上のコメントの理由がそのまま当てはまる。
   */
  action: "created" | "appended" | "kept";
}

/** `ent init` の結果。--json のときはこれをそのまま出す */
interface InitReport {
  repoRoot: string;
  entries: InitEntry[];
  /** 次に何を叩くか。JSON を読む側にも同じことを伝える */
  next: string;
}

/**
 * いまのリポジトリを ent で回せる状態にする。
 *
 * 満たすべき性質:
 * - 冪等。2度目は既にある `.goals/*.yaml` を上書きせず、`.gitignore` に同じ行を
 *   二重に足さない。この repo のルートで叩いても壊れない
 * - git のワークツリーのルートでなければ何も作らずに 1 で断る。argv は妥当なので
 *   2 ではない
 * - 書き込み先がシンボリックリンクなら何も書かない。リンク先はリポジトリの外を
 *   指せるので、辿ると `ent init` が repoRoot の外に書くことになる
 * - 出力は他のサブコマンドと揃える。`--json` のときは stdout に JSON だけを書く
 */
function initRepository(repoRoot: string, json: boolean): number {
  const refuse = (message: string): number => {
    // 作ってから気づかせない。何も置かずに、打ち直せる形を添える（gist 2.3）。
    process.stderr.write(`${message}\n`);
    return 1;
  };

  const gitRoot = findGitRoot(repoRoot);
  if (gitRoot === null) {
    return refuse(
      `${repoRoot} は git リポジトリの中ではない。` +
        "controller は worktree を作れず、.goals/.state/ の gitignore も意味を持たない" +
        "（git init を先に叩くか、リポジトリのルートで叩き直す）",
    );
  }
  // 「中にいる」だけでは足りない。`repoRoot` は常に process.cwd() なので、
  // サブディレクトリで叩くとそこが対象リポジトリのルート扱いになり、worktree も
  // 状態 DB もそこに置かれる。人間はリポジトリのルートに置いたつもりでいる。
  if (resolve(gitRoot) !== resolve(repoRoot)) {
    return refuse(
      `${repoRoot} は git リポジトリのルートではない（ルートは ${gitRoot}）。` +
        "ent は cwd を対象リポジトリとして扱うので、ルートで叩き直す",
    );
  }

  const goalsDir = join(repoRoot, ".goals");
  const gitignore = join(repoRoot, ".gitignore");
  for (const path of [goalsDir, gitignore]) {
    // 書き込み系はどれもリンクを辿るので、`.gitignore -> ~/.zshrc` のような
    // リポジトリなら、clone して init を叩いた人の設定ファイルに書くことになる。
    if (isSymbolicLink(path)) {
      return refuse(`${path} はシンボリックリンクなので書かない（リンクを外してから叩き直す）`);
    }
  }

  // 順に片付ける。`.goals/` が無い状態で雛形は置けないので、並べ替えられない。
  const dir = ensureGoalsDir(goalsDir);
  const ignore = ensureStateIgnored(gitignore);
  const template = ensureGoalTemplate(goalsDir);
  const entries = [dir, ignore, template];
  const report: InitReport = { repoRoot, entries, next: nextStep(template) };

  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${entries.map((entry) => `${entry.action.padEnd(8)}${entry.path}`).join("\n")}\n\n${report.next}\n`,
  );
  return 0;
}

/**
 * 次に何を叩くか。**雛形を置いたときと、既にあったときで別のことを言う。**
 *
 * 両方を同じ文にしていたとき、`.goals/*.yaml` があるリポジトリでは
 * 「`.goals/<既存の Goal>.yaml` の desired_state と acceptance_criteria を埋めてから
 * ent start <既存の slug> を叩く」と出ていた。名前が挙がるのはアルファベット順の
 * 1本目なので、終わった Goal を「これを埋めろ」と名指しすることになる。
 * ファイルは壊れないが、init の唯一の出力が常に誤った指示になる。
 */
function nextStep(template: InitEntry): string {
  if (template.action === "kept") {
    return `.goals/ に既に Goal があるので雛形は置いていない。ent doctor で前提を確かめる`;
  }
  const slug = basename(template.path, extname(template.path));
  return `${template.path} の goal.name / desired_state / acceptance_criteria / repository を埋めてから、ent doctor と ent start ${slug} を叩く`;
}

/** シンボリックリンクか。存在しないパスは false（これから作るので辿る先が無い） */
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureGoalsDir(goalsDir: string): InitEntry {
  if (existsSync(goalsDir)) {
    return { path: ".goals/", action: "kept" };
  }
  mkdirSync(goalsDir, { recursive: true });
  return { path: ".goals/", action: "created" };
}

/**
 * `.gitignore` に `.goals/.state/` を足す。既に無視できていれば触らない。
 *
 * 足し忘れると、状態 DB と worktree と Agent の生ログが対象リポジトリの git に載る。
 * 既存の内容は消さずに末尾へ追記する。人間が書いた行を init が捨てる理由が無い。
 *
 * 「既に無視できているか」は自分で判定しない。`stateDirIgnored`（git に聞く）と
 * 判定を分けると、doctor が ok と言う状態に init が行を足すことになる。
 */
function ensureStateIgnored(path: string): InitEntry {
  const existed = existsSync(path);
  const body = existed ? readFileSync(path, "utf8") : "";
  if (body.split("\n").some((line) => line.trim() === STATE_IGNORE_LINE)) {
    return { path: ".gitignore", action: "kept" };
  }

  // 末尾に改行が無いファイルへ追記すると、最後の行と繋がって別の pattern になる。
  const head = body === "" ? "" : body.endsWith("\n") ? `${body}\n` : `${body}\n\n`;
  writeFileSync(
    path,
    `${head}# ent の実行時状態（goals.db / worktree / Agent の生ログ）\n${STATE_IGNORE_LINE}\n`,
  );
  return { path: ".gitignore", action: existed ? "appended" : "created" };
}

/**
 * Goal YAML が1本も無ければ雛形を置く。1本でもあれば何もしない。
 *
 * 「雛形のファイルが無ければ置く」にはしない。人間が雛形を自分の slug に
 * 改名した直後にもう一度叩くと、消したはずの `example-goal.yaml` が戻ってくる。
 */
function ensureGoalTemplate(goalsDir: string): InitEntry {
  const [existing] = readdirSync(goalsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  if (existing !== undefined) {
    return { path: `.goals/${existing}`, action: "kept" };
  }

  writeFileSync(join(goalsDir, `${TEMPLATE_SLUG}.yaml`), goalTemplate(TEMPLATE_SLUG), {
    encoding: "utf8",
  });
  return { path: `.goals/${TEMPLATE_SLUG}.yaml`, action: "created" };
}

/**
 * `ent get` が出すもの。宣言部と実行時状態をマージして1枚にする（design.md §4.6）。
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
 * まとめて見る手段が要る。Goal ごとに ent get を叩く手間を無くす。
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
        name: "init",
        summary:
          "いまのリポジトリを回せる状態にする。.goals/ と gitignore の行と Goal の雛形を置く。冪等",
        args: [],
        flags: [JSON_FLAG],
      },
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
          {
            name: "--report",
            type: "string",
            summary:
              "進捗を PR に投稿せず、stdout（JSON の report.body）か指定したファイルに出す。--dry-run とは併用しない",
          },
        ],
      },
      {
        name: "get",
        summary: "宣言部と実行時状態をまとめて出す",
        args: [slug],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "abandon",
        summary: "もう追わないと宣言して ABANDONED にする。完了は名乗らせないので complete は無い",
        args: [slug],
        flags: [
          JSON_FLAG,
          { name: "--reason", type: "string", summary: "なぜ追わないのか（必須）" },
        ],
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
  /** いま動いている Node のバージョン（`v24.18.1` の形） */
  nodeVersion: () => string;
  /** cwd が git のワークツリーの中か */
  gitRepository: () => Promise<boolean>;
  /** `.goals/.state/` が gitignore されているか。確かめられなければ null */
  stateIgnored: () => Promise<boolean | null>;
}

/**
 * `node:sqlite`（src/store/index.ts）が要求する Node のメジャーバージョン。
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
  // 並びは「その場所で ent が動くか」から「その Goal を回せるか」の順にする。
  // Node が足りない環境では他の検査の結果を読んでも直す手が変わらない。
  const checks: DoctorCheck[] = [
    nodeVersionCheck(probes),
    await gitRepositoryCheck(probes),
    await stateIgnoredCheck(probes),
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
    // 「読めなかった」で止めない。壊れているのか、まだ始めていないのかを
    // 読み分けられないと、次に何を叩けばよいかが README を読むまで分からない。
    return {
      name: "goals",
      result: "failed",
      detail:
        `.goals/ を読めなかった: ${errorMessage(error)}。` +
        "このリポジトリでまだ始めていないなら ent init を叩く（.goals/ と雛形と gitignore の行を置く）",
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
    nodeVersion: () => process.version,
    gitRepository: async () => findGitRoot(repoRoot) !== null,
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

function summarize(result: TickResult): Record<string, unknown> {
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
 * **見るのは実装役の作業ツリーに固定する。** レビュー役の作業ツリーで criteria を
 * 検証すると、レビュー中に書き換わったものを実装の検証結果として読むことになる。
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
  // reject しないことは main() 側の try/catch が保証している。
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
