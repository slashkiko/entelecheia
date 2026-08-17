import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goalTemplate, TEMPLATE_SLUG } from "../domain/goal.js";
import { CONFIG_FILENAME, configTemplate } from "../domain/goal-config.js";

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
  /**
   * `origin` と現在のブランチから読んだ、対象リポジトリの識別子。読めなければ null。
   *
   * `.goals/config.yaml` の `repository` を埋めるのに使う。git に聞く判定なので
   * `gitRoot` と同じく Port で受け取る。読めなくても init は止めない——雛形の
   * `your-org/your-repo` を書いて、人間が埋める形にする。
   */
  repository(repoRoot: string): { owner: string; name: string; defaultBranch: string } | null;
  /**
   * `.goals/` ごと無視する行。`--private-goals` を渡したときに書く。
   *
   * `.goals/` はその下の `.state/` も覆うので、`stateIgnoreLine` の代わりになる。
   */
  goalsIgnoreLine: string;
  /**
   * そのリポジトリの `info/exclude` の絶対パス。引けなければ null。
   *
   * `--private-goals` の書き先になる。`join(repoRoot, ".git", ...)` を自前で
   * 組み立てないのは、`.git` がファイルのこともあり `info/` が無いこともあるため。
   */
  infoExcludePath(repoRoot: string): string | null;
}

/** `ent init` の振る舞いを変える指定。いまは1つだけになる */
export interface InitOptions {
  /**
   * 宣言部を git に載せない。`.gitignore` ではなく `info/exclude` に書く。
   *
   * **チームのリポジトリで個人が ent を回す形がこれにあたる。** `.goals/` の行を
   * tracked な `.gitignore` に足すと、それ自体がチームのリポジトリへの変更になる。
   * 避けたいのはまさにそれなので、このモードでは `.gitignore` を1文字も触らない。
   *
   * `info/exclude` は commit されず、linked worktree からも読まれる。Actor の
   * 作業ツリーで宣言部が無視されることが、controller が宣言部をそこへ配れる条件に
   * なっている（`deliverDeclaration`）。
   */
  privateGoals?: boolean;
}

/**
 * `ent init` が置いたもの1つ分。
 *
 * created と kept を分けて出す。「作った」と「既にあったので触らなかった」が
 * 同じ見た目だと、2度目に叩いた人が上書きされたのかどうかを判断できない。
 */
interface InitEntry {
  /**
   * repoRoot からの相対パス。repoRoot の外に置くものだけは絶対パスで出す
   * （user scope の skill）。相対で出すと、repoRoot の中の話に見えてしまう。
   */
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
 * - 冪等。2度目は既にある `.goals/*.yaml` を上書きせず、無視の行を二重に足さない。
 *   この repo のルートで叩いても壊れない
 * - `--private-goals` なら宣言部を git に載せない。書き先は `.gitignore` ではなく
 *   `info/exclude` で、**tracked なファイルは1つも触らない**
 * - git のワークツリーのルートでなければ何も作らずに 1 で断る。argv は妥当なので
 *   2 ではない
 * - 書き込み先がシンボリックリンクなら何も書かない。リンク先はリポジトリの外を
 *   指せるので、辿ると `ent init` が repoRoot の外に書くことになる
 * - user scope に ent の手順書の skill を張る。既に別のものが埋まっていれば、
 *   repoRoot にも `$HOME` にも何も置かずに 1 で断る
 * - 出力は他のサブコマンドと揃える。`--json` のときは stdout に JSON だけを書く
 */
export function initRepository(
  repoRoot: string,
  json: boolean,
  probes: InitProbes,
  options: InitOptions = {},
): number {
  const refuse = (message: string): number => {
    // 作ってから気づかせない。何も置かずに、打ち直せる形を添える（gist 2.3）。
    process.stderr.write(`${message}\n`);
    return 1;
  };

  const gitRoot = probes.gitRoot(repoRoot);
  if (gitRoot === null) {
    return refuse(
      `${repoRoot} is not inside a git repository. ` +
        "The controller cannot create worktrees, and gitignoring .goals/.state/ means nothing " +
        "(run git init first, or run again from the repository root)",
    );
  }
  // 「中にいる」だけでは足りない。`repoRoot` は常に process.cwd() なので、
  // サブディレクトリで叩くとそこが対象リポジトリのルート扱いになり、worktree も
  // 状態 DB もそこに置かれる。人間はリポジトリのルートに置いたつもりでいる。
  if (resolve(gitRoot) !== resolve(repoRoot)) {
    return refuse(
      `${repoRoot} is not the git repository root (the root is ${gitRoot}). ` +
        "ent treats cwd as the target repository, so run again from the root",
    );
  }

  const goalsDir = join(repoRoot, ".goals");
  const configPath = join(goalsDir, CONFIG_FILENAME);

  // 無視の行をどこへ書くか。**private では tracked な `.gitignore` を候補にすら
  // しない。** 1行足すだけでもチームのリポジトリへの変更になり、避けたいのが
  // まさにそれになる。
  const ignore = options.privateGoals === true ? probes.infoExcludePath(repoRoot) : null;
  if (options.privateGoals === true && ignore === null) {
    return refuse(
      "Could not resolve info/exclude for this repository, so nothing is written. " +
        "--private-goals writes the ignore line there instead of .gitignore " +
        "(check that git rev-parse --git-path info/exclude works here)",
    );
  }
  const ignorePath = ignore ?? join(repoRoot, ".gitignore");
  const ignoreLine =
    options.privateGoals === true ? probes.goalsIgnoreLine : probes.stateIgnoreLine;

  for (const path of [goalsDir, ignorePath, configPath]) {
    // 書き込み系はどれもリンクを辿るので、`.gitignore -> ~/.zshrc` のような
    // リポジトリなら、clone して init を叩いた人の設定ファイルに書くことになる。
    if (isSymbolicLink(path)) {
      return refuse(
        `${path} is a symbolic link, so nothing is written (remove the link and run again)`,
      );
    }
  }

  // skill の判定は書き始める前に済ませる。断るなら repoRoot にも `$HOME` にも
  // 何も残さない——`.goals/` だけ出来た状態で断られると、次に叩いた人は
  // 中途半端な状態から何を直せばよいのか分からない。
  const skill = planSkillLink();
  if (skill.kind === "conflict") {
    return refuse(skill.message);
  }

  // 順に片付ける。`.goals/` が無い状態で雛形は置けないので、並べ替えられない。
  const dir = ensureGoalsDir(goalsDir);
  const ignored = ensureIgnored(ignorePath, ignoreLine, repoRoot);
  const config = ensureGoalConfig(configPath, probes.repository(repoRoot));
  const template = ensureGoalTemplate(goalsDir);
  const entries = [dir, ignored, config, template, ...applySkillLink(skill)];
  const report: InitReport = { repoRoot, entries, next: nextStep(template, config) };

  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${entries.map((entry) => `${entry.action.padEnd(9)}${entry.path}`).join("\n")}\n\n${report.next}\n`,
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
function nextStep(template: InitEntry, config: InitEntry): string {
  // repo スコープの宣言は config に移った。埋める先が2つに分かれたので、
  // どちらを埋めるのかを両方名指しする。片方だけ挙げると、もう片方は
  // 最初のティックで GitHub の 404 として初めて表面化する。
  const repository =
    config.action === "created"
      ? ` Check repository in .goals/${CONFIG_FILENAME} too — it is filled in from origin, or left as your-org/your-repo when that could not be read.`
      : "";
  if (template.action === "kept") {
    return `.goals/ already holds a Goal, so no template was placed. Run ent doctor to check the prerequisites.${repository}`;
  }
  const slug = basename(template.path, extname(template.path));
  return `Fill in goal.name / desired_state / acceptance_criteria in ${template.path}, then run ent doctor and ent start ${slug}.${repository}`;
}

/**
 * ent の手順書の skill ディレクトリ。symlink の向け先そのもの。
 *
 * パスは `import.meta.url` から引く。cwd 基準にすると、ent は対象リポジトリの
 * ルートで叩かれる CLI なので（`repoRoot = process.cwd()`、src/cli.ts）、対象
 * リポジトリ側の `.claude/` を見に行って外れる。`src/usecase/` からも
 * `dist/usecase/` からも、2つ上が ent 本体のリポジトリのルートになる
 * （`src/adapters/claude.ts` の `REVIEW_PLUGIN_DIR` と同じ引き方）。
 */
const SKILL_SOURCE_DIR = fileURLToPath(new URL("../../.claude/skills/ent", import.meta.url));

/** user scope に置く skill の名前。`~/.claude/skills/<name>` になる */
const SKILL_NAME = "ent";

/**
 * 手順書の skill をどうするか。**書き始める前に決めて、後から実行する。**
 *
 * `conflict` を持つのは、断る判断を書き込みより前に出すため。判定と実行が
 * 同じ関数に入っていると、`.goals/` を作ってから断る経路を後で足せてしまう。
 */
type SkillPlan =
  | { kind: "create"; link: string; target: string }
  | { kind: "kept"; link: string }
  | { kind: "conflict"; message: string }
  /** ent 本体の skill ディレクトリが見当たらない。張れないが init は止めない */
  | { kind: "unavailable"; message: string };

/**
 * `~/.claude/skills/ent` を張るかどうかを決める。ファイルには触らない。
 *
 * 張る先を user scope にするのは、ent 本体がマシンに1つ入るから
 * （`pnpm link --global`）。対象リポジトリの中に張ると、向け先が ent 本体の
 * 絶対パスなのでマシン固有になり、commit すれば他の人の手元で壊れる。
 *
 * 実体は写さずシンボリックリンクにする。写すと、ent 本体を更新しても対象側が
 * 古い手順書のままになる。正本は1箇所に保つ。
 *
 * `$HOME` は `os.homedir()` から引く。テストが `HOME` を差し替えるので、
 * 実際の `~/.claude/` を触らずに確かめられる。
 */
function planSkillLink(): SkillPlan {
  const link = join(homedir(), ".claude", "skills", SKILL_NAME);
  if (!existsSync(SKILL_SOURCE_DIR)) {
    // ビルド成果物だけを配ったなど、手順書が同梱されていない入れ方はあり得る。
    // 張れないことを伝えるだけにする。skill は init の主目的ではないので、
    // ここで 1 を返すと `.goals/` を作る道まで塞がる。
    return {
      kind: "unavailable",
      message: `${SKILL_SOURCE_DIR} is missing, so no skill is linked (check the ent repository itself)`,
    };
  }

  const linked = symlinkTargetOf(link);
  if (linked === undefined) {
    return { kind: "create", link, target: SKILL_SOURCE_DIR };
  }
  if (linked === null || linked !== realpathSync(SKILL_SOURCE_DIR)) {
    // 人間が自分で張ったもの、自分で書いた skill、壊れたリンクのいずれか。
    // **どちらが正かを決めるのは ent ではない。** 黙って差し替えない。
    return {
      kind: "conflict",
      message:
        `${link} already points somewhere other than ent itself (or is a real directory), so it is left alone. ` +
        `Check what is there, then remove it or move it aside and run again (the intended target is ${SKILL_SOURCE_DIR})`,
    };
  }
  return { kind: "kept", link };
}

/**
 * `planSkillLink` の結果をファイルに反映する。`conflict` はここへ来ない。
 *
 * 出力に載せるのは repoRoot の外に置くものだからで、載せないと人間は
 * `$HOME` が書き換わったことに気づけない。
 */
function applySkillLink(plan: SkillPlan): InitEntry[] {
  if (plan.kind === "unavailable") {
    process.stderr.write(`${plan.message}\n`);
    return [];
  }
  if (plan.kind === "kept") {
    return [{ path: plan.link, action: "kept" }];
  }
  if (plan.kind === "create") {
    // `~/.claude/skills/` ごと無いのが初回になる。
    mkdirSync(dirname(plan.link), { recursive: true });
    // 第3引数は POSIX では無視されるが、Windows では向け先の種類を渡さないと
    // ファイルのリンクとして作られ、Claude Code が SKILL.md を辿れない。
    symlinkSync(plan.target, plan.link, "dir");
    return [{ path: plan.link, action: "created" }];
  }
  return [];
}

/**
 * `path` がシンボリックリンクなら、その実体の絶対パス。
 *
 * リンクでなければ（実体があるか、辿れないなら）null。存在しなければ undefined。
 * 3つを区別するのは、「これから作る」「既にある正しいリンク」「別のもので
 * 埋まっている」で振る舞いが分かれるため。
 */
function symlinkTargetOf(path: string): string | null | undefined {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!link.isSymbolicLink()) {
    return null;
  }
  try {
    return realpathSync(path);
  } catch {
    // 壊れたリンク。辿れないものを「同じ向き先」とは言えない。
    return null;
  }
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
 * 無視の行を足す。既にその行があれば触らない。
 *
 * 足し忘れると、状態 DB と worktree と Agent の生ログが対象リポジトリの git に載る。
 * 既存の内容は消さずに末尾へ追記する。人間が書いた行を init が捨てる理由が無い。
 *
 * **書き先は2つある。** 既定は `.gitignore` で、`--private-goals` なら
 * `info/exclude` になる。後者は commit されないので、チームのリポジトリに1行も
 * 足さずに宣言部を隠せる。行そのものも `.goals/.state/` と `.goals/` で変わる。
 *
 * 「既にその行があるか」は文字列の完全一致で見る。git に聞く形（`check-ignore`）に
 * すると、祖先の設定で既に無視できている repo に1行も書かなくなる。init が
 * **自分の書いた行を後から見分けられる**ことに意味があるので、ここは一致で見る。
 */
function ensureIgnored(path: string, ignoreLine: string, repoRoot: string): InitEntry {
  const shown = relative(repoRoot, path) || path;
  const existed = existsSync(path);
  const body = existed ? readFileSync(path, "utf8") : "";
  if (body.split("\n").some((line) => line.trim() === ignoreLine)) {
    return { path: shown, action: "kept" };
  }

  // 末尾に改行が無いファイルへ追記すると、最後の行と繋がって別の pattern になる。
  const head = body === "" ? "" : body.endsWith("\n") ? `${body}\n` : `${body}\n\n`;
  const comment =
    ignoreLine === ".goals/"
      ? "# ent declarations and runtime state, kept out of git for this checkout only"
      : "# ent runtime state (goals.db / worktrees / Agent raw logs)";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${head}${comment}\n${ignoreLine}\n`);
  return { path: shown, action: existed ? "appended" : "created" };
}

/**
 * Goal YAML が1本も無ければ雛形を置く。1本でもあれば何もしない。
 *
 * 「雛形のファイルが無ければ置く」にはしない。人間が雛形を自分の slug に
 * 改名した直後にもう一度叩くと、消したはずの `example-goal.yaml` が戻ってくる。
 */
/**
 * repo スコープの宣言を置く。既にあれば触らない。
 *
 * `repository` は git から読めた分を埋める。読めなければ雛形と同じ
 * `your-org/your-repo` になる。**読めなかったことを黙らない**——`nextStep` が
 * 埋める先として config を名指しするので、そこで人間に届く。
 */
function ensureGoalConfig(
  path: string,
  repository: { owner: string; name: string; defaultBranch: string } | null,
): InitEntry {
  const shown = `.goals/${CONFIG_FILENAME}`;
  if (existsSync(path)) {
    return { path: shown, action: "kept" };
  }

  writeFileSync(
    path,
    configTemplate(repository ?? { owner: "your-org", name: "your-repo", defaultBranch: "main" }),
    { encoding: "utf8" },
  );
  return { path: shown, action: "created" };
}

function ensureGoalTemplate(goalsDir: string): InitEntry {
  const [existing] = readdirSync(goalsDir)
    // config.yaml は Goal ではない。数に入れると、init の1周目が置いた config を
    // 「Goal が既にある」と読んで、同じ1周で雛形を置かなくなる。
    .filter((name) => name !== CONFIG_FILENAME)
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
