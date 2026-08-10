import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { goalTemplate, TEMPLATE_SLUG } from "../domain/goal.js";

/**
 * `ent init` の本体。いまのリポジトリを ent で回せる状態にする。
 *
 * git に聞く判定と `.gitignore` に書く1行は Port で受け取る（`InitProbes`）。
 * `doctor` と同じ形にしてあるのは、どちらも「調べた結果」に依存する処理で、
 * Adapter を選ぶのは合成ルートの仕事だから（design.md §3.3）。
 */

/** init が外の世界に聞くこと。合成ルートが実装を挿す（`src/wiring/index.ts`） */
export interface InitProbes {
  /** 対象リポジトリの git ルート。git のワークツリーの中でなければ null */
  gitRoot(repoRoot: string): string | null;
  /**
   * `.gitignore` に書く1行。
   *
   * 「既に無視できているか」を判定する `stateDirIgnored` と同じ文字列でなければ、
   * init が書いた行を doctor が認識しない状態を作れる。
   */
  stateIgnoreLine: string;
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
export function initRepository(repoRoot: string, json: boolean, probes: InitProbes): number {
  const refuse = (message: string): number => {
    // 作ってから気づかせない。何も置かずに、打ち直せる形を添える（gist 2.3）。
    process.stderr.write(`${message}\n`);
    return 1;
  };

  const gitRoot = probes.gitRoot(repoRoot);
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
  const ignore = ensureStateIgnored(gitignore, probes.stateIgnoreLine);
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
function ensureStateIgnored(path: string, stateIgnoreLine: string): InitEntry {
  const existed = existsSync(path);
  const body = existed ? readFileSync(path, "utf8") : "";
  if (body.split("\n").some((line) => line.trim() === stateIgnoreLine)) {
    return { path: ".gitignore", action: "kept" };
  }

  // 末尾に改行が無いファイルへ追記すると、最後の行と繋がって別の pattern になる。
  const head = body === "" ? "" : body.endsWith("\n") ? `${body}\n` : `${body}\n\n`;
  writeFileSync(
    path,
    `${head}# ent の実行時状態（goals.db / worktree / Agent の生ログ）\n${stateIgnoreLine}\n`,
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
