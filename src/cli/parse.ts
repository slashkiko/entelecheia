import { parseArgs } from "node:util";
import { errorMessage } from "../domain/error-message.js";
import { SLUG } from "../domain/goal.js";
import { DEFAULT_LIMIT } from "../usecase/inspect.js";

/**
 * 引数の解釈だけを持つ。**実行はしない。**
 *
 * 副作用のある部分（`src/cli.ts`）と分けてあるのは、解釈をそれ単体でテストするため。
 * 解釈は Node 24 標準の `node:util` の parseArgs で書く。citty は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 */

export const USAGE = `ent — Declare the end state; the controller converges to it.

  ent init             Make the current repository runnable with ent (idempotent)
  ent start <slug>     Register a Goal and make it ACTIVE
  ent run <slug>       Run one tick and exit (--once is the default)
                       --pr <n> / --issue <n> names what to observe
                       --dry-run writes nothing; it only shows what the next tick would contain
                       --report stdout|<path> sends progress to your hands instead of the PR
  ent get <slug>       Show the declaration and the runtime state together
  ent abandon <slug>   Declare it no longer pursued and terminate it (--reason is required)
  ent list             List registered Goals
  ent doctor           Read-only check that the prerequisites for running are in place
  ent agent-context    Emit the CLI's structure as machine-readable JSON

  --json               Emit JSON (run / get / list are JSON by default)
  --limit <n>          Cap how many entries are printed (get / list; default ${String(DEFAULT_LIMIT)})
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
    return { kind: "error", message: "show became get: ent get <slug>" };
  }
  if (!isSubcommand(sub)) {
    // 黙って無視すると、打ち間違いが「何も起きなかった」に見える。
    // 推測させても無駄な再試行になるので、有効値をその場で全部並べる（gist 2.3）。
    return {
      kind: "error",
      message: `unknown subcommand: ${sub} (valid: ${SUBCOMMANDS.join(" / ")})`,
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
        return { kind: "error", message: `too many arguments: ${positionals.join(" ")}` };
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
      return { kind: "error", message: `${sub} needs a Goal slug: ent ${sub} <slug>` };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: `too many arguments: ${positionals.join(" ")}` };
    }
    if (!SLUG.test(slug)) {
      // slug はそのまま `.goals/<slug>.yaml` のパスになる。`../` を通すと
      // ツリーの外の Goal を読めてしまい、その `setup` と `verification.run` が
      // controller の権限でシェルに流れる。id 一致の検査はファイル名しか見ず、
      // ディレクトリを縛らないので、そこでは止まらない。
      return {
        kind: "error",
        message: `malformed slug: ${slug} (kebab-case only; path separators are not allowed)`,
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
          message: `abandon needs a reason: ent abandon ${slug} --reason "<why it is no longer pursued>"`,
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
          "--dry-run and --report cannot be combined. --dry-run never reaches publish, so no progress is written" +
          " (criteria results land in observed.verifications of the output)",
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
    return `${flag} takes a positive integer: ${String(value)}`;
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
    return "--report needs a destination: stdout or a file path";
  }
  return raw === "stdout" ? { kind: "stdout" } : { kind: "file", path: raw };
}
