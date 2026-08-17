import { exec, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type Worktree, type WorktreePort, worktreeBranchFor } from "../act/index.js";
import { CONFIG_FILENAME } from "../domain/goal-config.js";
import { VERIFY_WITHHELD_ENV, withheldEnv } from "../domain/withheld-env.js";
import type { LocalRepoPort } from "../observe/index.js";
import type { BranchPort, PushResult } from "../publish/index.js";
import type { ApprovalPort, CommandResult, CommandRunnerPort } from "../verify/index.js";

/**
 * 外部プロセスの上限。ここが無いと、刺さった `git push` や検証コマンドが
 * ティックを永久に終わらせない。lease の heartbeat はティックが走る限り
 * 延長し続けるので、cron から起動した他のワーカーも引き継げなくなる。
 *
 * 検証コマンド側を長く取ってあるのは、`mise run test` が実際に数分かかるため。
 * git は数十秒かかる時点で刺さっていると見てよい。
 */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * ローカル環境に対する Port の実装。
 *
 * GitHub（octokit）と Actor（Claude Agent SDK）はここに含めない。次の Goal で足す。
 * ここにあるのは node:child_process だけで書けるもので、依存パッケージが要らない。
 */

/**
 * シェルを経由する実行。Goal YAML の `setup` と `verification.run` **だけ**に使う。
 * あちらは「任意のシェルコマンドを流す」ことが宣言された機能なので、
 * シェルであること自体が仕様にあたる。
 */
const runShell = promisify(exec);

/**
 * argv 配列で実行する。シェルを経由しないので、引数に何が入っても実行されない。
 *
 * git の呼び出しはすべてこちらを通す。以前は `exec` にテンプレート文字列を渡していて、
 * 引数のどれか1つでもこちらの制御下に無ければシェルインジェクションになった。
 * 実際、`gitBranch.push` はブランチ名を worktree から読む。worktree の中身は Actor が
 * 書き換えられ、git は `;` や `$()` をブランチ名に許すので、Actor が
 * `evil;touch${IFS}PWNED` という名前のブランチを1本作るだけで controller の
 * プロセス上で任意コマンドが走った。隔離はファイルの置き場所の話でしかなく、
 * 実行の境界にはなっていなかった。
 */
const runFile = promisify(execFile);

/** git を argv 配列で叩き、標準出力をそのまま返す。終了コードが 0 以外なら reject する */
async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile("git", [...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * git を argv 配列で叩き、前後の空白を落とした標準出力を返す。
 *
 * `status --porcelain` にはこちらを使わない。あの出力は先頭2桁が状態で
 * 3桁目が区切りなので、trim すると1行目だけ列がずれてパスが1文字欠ける。
 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

/**
 * ここが属する git ワークツリーのルート。外なら null。
 *
 * **`ent init` と `ent doctor` の判定はここ1箇所に置く。** どちらも「その場所で
 * ent を回せるか」を答えるもので、判定が2箇所にあると、init が作った場所を
 * doctor が別の基準で見ることになる。`src/adapters/local.ts` は
 * `PROTECTED_PATH_FLOOR` に入っているので、Agent が判定そのものを書き換えられない。
 *
 * **真偽ではなくルートを返す。** 祖先を辿るので、リポジトリのサブディレクトリでも
 * 「中にいる」は真になる。一方 `repoRoot` は常に `process.cwd()` なので、
 * `repo/src/` で `ent init` を叩くとそこに `.goals/` ができる。呼ぶ側が
 * 「ここはルートか」を判断できるように、見つけた場所そのものを返す。
 *
 * `--show-toplevel` は使わない。linked worktree では本体側を返すことがあり、
 * ent が回るのは worktree の側なので、辿った先の実体をそのまま返す。
 * `.git` はディレクトリともファイルともなりうるので種類は問わない。
 */
export function findGitRoot(from: string): string | null {
  let candidate = resolve(from);
  while (!existsSync(join(candidate, ".git"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
  return candidate;
}

/** `.goals/.state/` を無視する行。init が書き、doctor が読む。文言を2箇所に持たない */
export const STATE_IGNORE_LINE = ".goals/.state/";

/**
 * `.goals/` ごと無視する行。宣言部を git に載せない構成で init が書く。
 *
 * `STATE_IGNORE_LINE` の代わりになる。`.goals/` はその下の `.state/` も覆うので、
 * 両方を書く必要は無い（`git check-ignore` に聞く doctor もこれで通る）。
 */
export const GOALS_IGNORE_LINE = ".goals/";

/**
 * 宣言部を worktree に配る。**無視されているものだけを配る。**
 *
 * チームのリポジトリで個人が ent を回すと、`.goals/` を commit したくない。だが
 * `git worktree add` が持ってくるのは tracked なファイルだけなので、無視した
 * 宣言部は worktree に現れない。レビュー役は worktree の中の
 * `.goals/<id>.yaml` を読めと指示されている（`src/adapters/agent-prompt.ts`）ので、
 * 読む材料が丸ごと消える。controller が代わりに置く。
 *
 * **配る条件は「その worktree で git に無視されていること」で、ファイルの有無では
 * ない。** 無視されていないパスに置くと untracked なファイルが1本増え、
 * `changedPaths` に出て `protected_path_touched` になる。触ってもいない Actor が
 * 止められるうえ、`commit` の `add --all` がそれを PR の diff に入れる。逆に
 * 無視されていれば、`status --porcelain` にも `add --all` にも現れない。
 *
 * **毎回上書きする。** 無視されている＝関門から見えないので、Actor は配られた
 * 写しを書き換えられる。controller が読むのは repoRoot 側なので判断は変わらないが、
 * レビュー役は書き換えられた宣言に対してレビューすることになる。役を起動する
 * たびに置き直せば、前の役が書き換えた分はそこで捨てられる。
 *
 * `goalId` が無ければ何もしない。宣言部の場所が決まらないので配りようが無い。
 */
async function deliverDeclaration(
  repoRoot: string,
  worktreePath: string,
  goalId: string | undefined,
): Promise<void> {
  if (goalId === undefined) {
    return;
  }

  const names = [`${goalId}.yaml`, `${goalId}.yml`, CONFIG_FILENAME];
  for (const name of names) {
    const source = join(repoRoot, ".goals", name);
    if (!existsSync(source)) {
      continue;
    }
    const relative = `.goals/${name}`;
    if (!(await ignoredIn(worktreePath, relative))) {
      continue;
    }
    const destination = join(worktreePath, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

/**
 * その作業ツリーで、そのパスが git に無視されるか。
 *
 * 判定できなかったときは false に倒す。`stateDirIgnored` は3値（無視される /
 * されない / 分からない）を返すが、こちらの読み手は1人で、分からないときに
 * 取るべき側が決まっている——**配らない**。配って外すほうの間違いは、Actor が
 * 触っていない変更で関門に止められる形になる。
 */
async function ignoredIn(worktreePath: string, path: string): Promise<boolean> {
  try {
    await gitRaw(worktreePath, ["check-ignore", "-q", "--", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * そのリポジトリの `info/exclude` の絶対パス。引けなければ null。
 *
 * `join(repoRoot, ".git", "info", "exclude")` とは書かない。`.git` はディレクトリ
 * とは限らず（worktree では gitdir を指すファイルになる）、`info/` が無いことも
 * ある。git に聞けば、どの形でも共通の置き場を返す。
 *
 * この行を worktree 側ではなく共通の `info/exclude` に書くのが要点になる。
 * linked worktree もここを読むので、1度書けば作業ツリー全部に効く。
 */
export function gitInfoExcludePath(repoRoot: string): string | null {
  const path = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (path === null) {
    return null;
  }
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

/**
 * `.goals/.state/` が gitignore されているか。判定は git にさせる。
 *
 * 自分で `.gitignore` を1行ずつ読む形にしていたが、git の意味論とずれる。
 * 否定パターン（`!.goals/.state/goals.db`）は後の行が前の行を打ち消すので、
 * 素朴な一致では「無視できている」と誤って読む。逆に、祖先の `.gitignore`・
 * `.git/info/exclude`・`core.excludesFile` で既に無視できている repo では
 * 誤って failed が出る。**doctor が ok と言った状態で状態 DB が commit される**
 * のは、この検査を足した意味が消える壊れ方になる。
 *
 * 確かめられなかったとき（git が無い・リポジトリの外）は false を返さない。
 * 「無視できていない」と「確かめられなかった」を畳まないため、呼ぶ側が
 * `unknown` に倒せるように null を返す（design.md §3.1）。
 */
export async function stateDirIgnored(repoRoot: string): Promise<boolean | null> {
  try {
    await gitRaw(repoRoot, ["check-ignore", "-q", "--", STATE_IGNORE_LINE]);
    return true;
  } catch (error) {
    // check-ignore は「無視されない」を終了コード 1 で返す。それ以外（128 など）は
    // 判定できていないので null に倒す。code は execFile が載せる終了コード。
    return (error as { code?: unknown }).code === 1 ? false : null;
  }
}

/**
 * push 先にしてよいブランチ名。
 *
 * argv 化でシェルインジェクションは塞がるが、「どの remote ref を作るか」は
 * 依然として worktree 側が決める。push 先を予測可能にするために形も縛る。
 */
const PUSHABLE_BRANCH = /^[\w./-]+$/;

/**
 * シェルコマンドを実行する。起動そのものに失敗したときだけ throw する。
 *
 * 環境変数は明示的に絞る。ここで流すのは Goal YAML の `setup` と
 * `verification.run` で、criteria が `mise run test` である以上、実際に走るのは
 * **Actor が worktree に書いたテストとソース**にあたる。既定のまま
 * `process.env` を継承すると、`src/adapters/claude.ts` が Actor 本体に対して
 * トークンを落としているのが無意味になる。Actor は自分では受け取れない
 * `GITHUB_TOKEN` を、VERIFY に実行させるコードを書くことで読める。
 *
 * `tests/**` は guard-the-controller.yaml の判断で意図的に保護対象外なので、
 * この経路には保護パスを1つも踏まずに乗れる。関門はティックの末尾にあり
 * VERIFY はティックの先頭なので、関門は常に1ティック遅れる。ここで落とすしかない。
 */
export function commandRunner(cwd: string): CommandRunnerPort {
  const env = withheldEnv(process.env, VERIFY_WITHHELD_ENV);
  return {
    async run(command): Promise<CommandResult> {
      try {
        const { stdout, stderr } = await runShell(command, {
          cwd,
          env,
          maxBuffer: 32 * 1024 * 1024,
          timeout: COMMAND_TIMEOUT_MS,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        // 終了コードが 0 以外なら reject されるが、これは「検証できた不合格」なので
        // throw に畳まない。起動できなかった場合だけ throw する。
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        if (typeof failure.code === "number") {
          return {
            exitCode: failure.code,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
        throw error;
      }
    },
  };
}

export function localRepo(cwd: string): LocalRepoPort {
  return {
    async snapshot() {
      const [branch, headSha, status] = await Promise.all([
        git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(cwd, ["rev-parse", "HEAD"]),
        git(cwd, ["status", "--porcelain"]),
      ]);
      return { branch, headSha, dirty: status.length > 0 };
    },
  };
}

/**
 * git worktree による隔離。同じ name で2回呼んでも同じものを返す。
 * ティックをまたいで同じ作業ツリーに差分を積み上げる。
 */
export function gitWorktree(repoRoot: string, root: string): WorktreePort {
  const pathOf = (name: string): string => join(root, name);

  return {
    async ensure(name, baseBranch, goalId): Promise<Worktree> {
      const path = pathOf(name);
      // 規則は act/index.ts が正。controller の関門も同じ関数を通す。
      const branch = worktreeBranchFor(name);
      // 既にある作業ツリーは作り直さない。作り直すと前ティックの差分が消える。
      // `worktree list` の出力は realpath なので、パスの表記が揺れても
      // 取りこぼさないようにディレクトリの実在も見る。
      //
      // **宣言部の配布だけは、既にある作業ツリーでも必ず通す。** ここで一緒に
      // return してしまうと、配るのが1ティック目だけになる。
      if (existsSync(join(path, ".git"))) {
        await deliverDeclaration(repoRoot, path, goalId);
        return { path, branch };
      }

      const existing = await git(repoRoot, ["worktree", "list", "--porcelain"]);
      if (existing.split("\n").includes(`worktree ${path}`)) {
        await deliverDeclaration(repoRoot, path, goalId);
        return { path, branch };
      }

      const branches = await git(repoRoot, ["branch", "--list", "--format=%(refname:short)"]);
      const exists = branches.split("\n").includes(branch);
      // 既にブランチがあれば checkout し直す。作り直すと前ティックの差分が消える。
      await git(
        repoRoot,
        exists
          ? ["worktree", "add", path, branch]
          : ["worktree", "add", "-b", branch, path, baseBranch],
      );
      await deliverDeclaration(repoRoot, path, goalId);
      return { path, branch };
    },

    /**
     * 作業ツリーで実際に変わったパス。Actor の自己申告ではなく git から取る。
     *
     * `Run.artifacts` は SDK の Edit / Write / NotebookEdit から作られるので、
     * Bash 経由の書き込みが1件も現れない（design.md §10-6）。保護パスの検査を
     * そこに載せている限り、`echo >` で制御ループを書き換えられても素通りする。
     * 「書けた結果」を git から観測するのが、Bash を許したまま取れる唯一の検査点になる。
     *
     * commit 済みと未 commit の両方を返す。前者を落とすと、違反した編集が
     * commit された次のティックで検知できなくなる。
     */
    /**
     * worktree の変更を1つの commit にまとめる。commit したら true。
     *
     * git は argv 配列で叩く（design.md §7）。メッセージは stdin から渡さず
     * `-m` で渡すが、`execFile` なのでシェルは通らない。Actor が書いた
     * ブランチ名やパスが引数に混ざる経路はここには無い。
     *
     * 作業ツリーが無い・壊れている場合は throw する。`changedPaths` と同じで、
     * 「変更が無い」と「確かめられなかった」を混ぜない（design.md §3.1）。
     */
    async commit(name, message): Promise<boolean> {
      const path = pathOf(name);
      if (!existsSync(path)) {
        throw new Error(`cannot commit: the worktree does not exist: ${path}`);
      }
      if (!existsSync(join(path, ".git"))) {
        // 親をたどって controller 本体のリポジトリを commit してしまう。
        throw new Error(`worktree is broken (no .git): ${path}`);
      }

      await gitRaw(path, ["add", "--all"]);
      // 何も無いのに commit すると空の commit が積まれる。criteria が通った
      // ティックは毎回ここを通るので、放っておくと履歴が空 commit で埋まる。
      const staged = await gitRaw(path, ["diff", "--cached", "--name-only"]);
      if (staged.trim() === "") {
        return false;
      }
      await gitRaw(path, ["commit", "-m", message]);
      return true;
    },

    async changedPaths(name, baseBranch): Promise<string[]> {
      const path = pathOf(name);
      if (!existsSync(path)) {
        // まだ作業ツリーが無い。「変更が無い」であって「確かめられなかった」ではない。
        return [];
      }
      if (!existsSync(join(path, ".git"))) {
        // ディレクトリはあるが作業ツリーではない。ここで git を回すと、
        // git は親をたどって controller 本体のリポジトリに当たり、
        // 本体の汚れを「worktree の中の変更」として返す。
        // 確かめられなかったこととして扱う（design.md §3.1）。
        throw new Error(`worktree is broken (no .git): ${path}`);
      }

      const paths = new Set<string>();

      // 未 commit の変更。-uall で未追跡ファイルも1件ずつ出す。
      // ディレクトリ名だけにまとめられると、その下のパスが glob に一致しない。
      const status = await gitRaw(path, ["status", "--porcelain", "--untracked-files=all"]);
      for (const line of status.split("\n")) {
        for (const entry of porcelainPaths(line)) {
          paths.add(entry);
        }
      }

      // index の隠しビットが立っているパス。**中身を見ていないのに足す。**
      //
      // `status --porcelain` は `assume-unchanged` / `skip-worktree` を尊重するので、
      // ビットを1本立てるだけで、そのファイルへの書き込みが上のループから消える。
      // 「編集された」ではなく「**観測から外された**」を違反として扱う。ビットを
      // 立てること自体に正当な理由が無く、立てた後の書き込みは原理的に見えない。
      for (const entry of await indexHiddenPaths(path)) {
        paths.add(entry);
      }

      // base から分岐して以降の commit 済みの変更。
      //
      // ここで例外を握り潰してはいけない。以前は catch{} で「変更なし」に
      // 畳んでいたが、Actor は `git update-ref -d refs/heads/main` を実行できる。
      // 保護パスへの違反を commit してから base の ref を消せば、
      // 未 commit の変更は無く、diff は fatal で握り潰され、`changedPaths` は
      // 空を返す。origin/main は残るので push だけは通り、違反が通常の変更として
      // PR に流れた。「解決できなかった」を「変わっていない」と読ませないために、
      // 解決できなければ throw して guard_unavailable に倒す（design.md §3.1）。
      const committed = await gitDiffAgainst(path, baseBranch);
      for (const line of committed.split("\n")) {
        if (line !== "") {
          paths.add(line);
        }
      }

      return [...paths];
    },

    /**
     * 本体リポジトリ側で変わったパス。絶対パスで返す。
     *
     * `changedPaths` は worktree の中で git を回すので、`git worktree add` で
     * 分けた本体側の作業ツリーは観測できない（別の作業ツリーなので当然そうなる）。
     * Actor は Bash を持っているから、`echo > ../../../../src/controller/index.ts` の
     * 1行で隔離の外を書ける。そこを見るための口をもう1つ開ける。
     *
     * **ここで見えない範囲（design.md §10-6 の残る穴 (a) (b) (e)）:**
     * - repoRoot の外（`~/.zshrc`、`~/.claude/**` など）。git の観測範囲が上限で、
     *   ここから先は git ベースの検査では原理的に届かない
     * - gitignore されたパス。`--ignored` を付ければ出るが、controller 自身が
     *   `.goals/.state/**` に毎ティック書くので、自分の書き込みが毎回違反として
     *   並ぶ。ただし状態 DB そのものは controller が論理ダイジェストで見るので
     *   （`Store.guardDigest`）、ここに残るのは `goals.db` 以外の gitignore された
     *   パスになる
     * - commit 済みの変更。本体側のブランチは controller が動かさないので
     *   作業ツリーの汚れだけを見ているが、`git -C ../../../.. commit` や
     *   `git -C ../../../.. stash` は拒否リストに無い。本体側で書いてから commit されると、
     *   汚れの集合から消えて検査の外に出る
     *
     * パスだけでなく中身の指紋も返す。controller は ACT の前後を比べて
     * 「Actor が書いた分」を切り出すが、パスの集合だけで比べると、
     * **人間が編集中のファイルを Actor が上書きしたときに前後で同じパスが並び、
     * 差がゼロになる**。自己ホストでは保護対象がまさに編集中でありうるうえ、
     * Actor は `git -C ../../../.. status` でどれが汚れているかを読める。
     * どこを上書きすれば検知されないかを選べる状態になってしまう。
     *
     * worktree の置き場（`root`）配下は除く。既定では `.goals/.state/` の下で
     * gitignore されているので出てこないが、repoRoot の中に worktree を置く
     * 構成では未追跡ファイルとして並び、ACT のたびに違反と読んでしまう。
     */
    async repoDirtyState(): Promise<Map<string, string>> {
      const status = await gitRaw(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
      const state = new Map<string, string>();
      for (const line of status.split("\n")) {
        for (const entry of porcelainPaths(line)) {
          const absolute = resolve(repoRoot, entry);
          if (isInside(root, absolute)) {
            continue;
          }
          state.set(absolute, fingerprint(absolute));
        }
      }

      // index の隠しビットが立っているパス。**値は中身の指紋ではなく印にする。**
      //
      // `status` はこのビットを尊重するので、`git -C <repoRoot> update-index
      // --assume-unchanged src/controller/index.ts` を1回叩いてから本体側の
      // ファイルを書き換えると、上のループが空のままになる。commit もしないので
      // `changedPaths` の差分にも出ない。それでいて次のティックの `tsc` は
      // index ではなくファイルシステムから読むので、書き換えられた controller が
      // そのまま走る。既知の穴 (c) (e) が持っていた「1度は人間に届く」すら無い。
      //
      // 指紋ではなく印にするのは、**ビットが立った瞬間だけを差にするため**。
      // 中身を値にすると、人間が assume-unchanged を立てて置いているファイル
      // （ローカル専用の設定など、この動詞の本来の用途）を編集するたびに
      // ACT の前後で値が動き、毎ティック誤検知になる（穴 (d) の拡大）。
      // 印にしておけば、ACT の窓の中でビットが立ったか消えたかだけが差に出る。
      // **その代わり、以前から隠されていたファイルへの書き込みは見えない。**
      for (const entry of await indexHiddenPaths(repoRoot)) {
        const absolute = resolve(repoRoot, entry);
        if (isInside(root, absolute) || state.has(absolute)) {
          continue;
        }
        state.set(absolute, INDEX_HIDDEN);
      }

      return state;
    },

    /**
     * git が観測しないが、書き換えられると controller の権限でコードが走る場所。
     *
     * `repoDirtyState` と分けてあるのは、あちらが「git が見える汚れ」を意味する
     * ため。混ぜると、常に載る項目のせいで「汚れていなければ空」が成り立たなくなる。
     *
     * `git status` は `.git/**` を1件も出さない。`--ignored` を足せば見える類でも
     * なく、この計測手段では原理的に出てこない。一方 linked worktree は共通の
     * `.git/hooks` を共有し、Actor の cwd から `../../../../.git/hooks/pre-push` に
     * 届く。push のたびに controller のプロセス・全環境変数でそれが走る。
     *
     * 検知手段は `repoDirtyState` と同じでよい。ACT の前後で指紋を比べる。
     *
     * **状態 DB（`.goals/.state/goals.db`）はここには出さない。** gitignore 済みで
     * git から見えないのは同じだが、あれは controller 自身の書き込み先でもあり、
     * バイト列で見ると自分の書き込みと改竄が同じ差になる（issue #62）。
     * 観測は controller が `Store.guardDigest` から作り、この Map と同じ集合に
     * 混ぜる。保護対象から外したわけではない。
     */
    async outOfSightState(): Promise<Map<string, string>> {
      const state = new Map<string, string>();
      for (const [key, path] of await outOfSightPaths(repoRoot)) {
        state.set(key, fingerprint(path));
      }
      // 設定値そのものも見る。hooks のファイルを1つも触らずに、実行される
      // スクリプト群をまるごと差し替えられるため。
      state.set(".git/config#core.hooksPath", (await hooksPathSetting(repoRoot)) ?? "unset");
      return state;
    },
  };
}

/**
 * git の観測に出てこないが、書き換えられると controller の権限で実行される場所。
 *
 * 返すキーは repoRoot 相対の表示用パスにする。関門（`findViolations`）は
 * worktree からの相対に直して glob と突き合わせるので、実体のパスをそのまま
 * 返すと `.git` の中が `..` 扱いになって `escaped_worktree` に化ける。
 * 何が変わったのかを人間が読める形で残す方が、分類として正しい。
 *
 * `core.hooksPath` も見る。hooks のファイルを1つも触らずに、設定で
 * まるごと別のディレクトリへ差し替えられるため。
 */
async function outOfSightPaths(repoRoot: string): Promise<Map<string, string>> {
  const watched = new Map<string, string>();

  // hooks の実体。linked worktree でも共通の .git を指すので、
  // git に居場所を聞く（.git がファイルのこともある）。
  let gitDir: string;
  try {
    gitDir = resolve(repoRoot, await git(repoRoot, ["rev-parse", "--git-common-dir"]));
  } catch {
    // 聞けなければ既定の場所を見る。見に行けること自体は失敗にしない。
    gitDir = join(repoRoot, ".git");
  }

  const hooksDir = join(gitDir, "hooks");
  let entries: string[] = [];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    // hooks ディレクトリが無いのは正常。
  }
  for (const name of entries) {
    // .sample は git が最初から置くひな形で、実行されない。
    if (name.endsWith(".sample")) {
      continue;
    }
    watched.set(`.git/hooks/${name}`, join(hooksDir, name));
  }

  // **状態 DB はここでは見ない。** gitignore 済みで git status に出ないのは
  // hooks と同じだが、あれは controller 自身の書き込み先でもある。ファイルの
  // バイト列で見ていると、SQLite の WAL が自動 checkpoint に当たった回だけ
  // 自分の書き込みが外部からの改竄と同じ差になり、ACT を含むティックが
  // `protected_path_touched` で止まっていた（issue #62）。
  //
  // 代わりに controller が store から論理ダイジェストを取り、
  // `CONTROLLER_STATE_DB_KEY` として同じ観測に混ぜる
  // （`src/controller/index.ts` の `observedRepoState`、`Store.guardDigest`）。
  // 行を読めるのは store だけなので、adapter からは作れない。
  // **保護対象から外したわけではない。** 観測の作り方を変えただけになる。

  return watched;
}

/**
 * `core.hooksPath` の現在値。設定されていなければ null。
 *
 * hooks のファイルを1つも触らずに、設定だけで実行されるスクリプト群を
 * まるごと差し替えられる。指紋の対象がファイルなので、これは別に見る。
 */
async function hooksPathSetting(repoRoot: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["config", "--get", "core.hooksPath"]);
  } catch {
    // 未設定なら git は終了コード 1 を返す。設定されていないことは正常。
    return null;
  }
}

/**
 * index の隠しビットが立っているパスに付ける値。中身の指紋とは別物だと読めるようにする。
 *
 * 64桁の16進（`fingerprint` が返す形）と衝突しない文字列にしてある。
 */
const INDEX_HIDDEN = "index-hidden";

/**
 * `assume-unchanged` か `skip-worktree` が立っていて、`git status` から消えるパス。
 *
 * 関門の一次入力は `git status --porcelain -uall` で、**どちらのビットも尊重される。**
 * `git update-index --assume-unchanged <path>` を1回叩けば、そのファイルへの
 * 書き込みは status からも `git diff` からも消える。拒否リスト
 * （`ALWAYS_DENIED`、src/adapters/claude.ts）にも同じ動詞を足したが、あれは
 * 先頭からのグロブなので `git -C . update-index ...` や環境変数の前置で外れうる。
 * **観測を潰す形は、観測する側でも見る。**
 *
 * 判定はタグの文字で行う。`git ls-files -v` は1行につき `<タグ> <パス>` を出し、
 * `assume-unchanged` が立っているものは**タグが小文字**になる。`skip-worktree` は
 * `S`。知らないタグは「隠されていない」に倒さず throw する。この関数の呼び出し元は
 * どちらも「確かめられなかった」を `guard_unavailable` に落とす経路にいるので、
 * 読めない出力を静かに空として返すと、関門が鳴らないまま素通りする（design.md §3.1）。
 */
async function indexHiddenPaths(cwd: string): Promise<string[]> {
  const listed = await gitRaw(cwd, ["ls-files", "-v"]);
  const hidden: string[] = [];
  for (const line of listed.split("\n")) {
    if (line === "") {
      continue;
    }
    const tag = line[0] ?? "";
    const path = unquote(line.slice(2).trim());
    if (line[1] !== " " || path === "") {
      throw new Error(`cannot read the output of git ls-files -v: ${line}`);
    }
    // 小文字は assume-unchanged、`S` は skip-worktree。
    if (/^[a-z]$/.test(tag) || tag === "S") {
      hidden.push(path);
      continue;
    }
    // `H` cached / `M` unmerged / `R` removed / `C` modified / `K` to-be-killed /
    // `?` other。ここに無いタグが出たら、隠しビットかどうかを判定できていない。
    if (!"HMRCK?".includes(tag)) {
      throw new Error(`cannot read the output of git ls-files -v: ${line}`);
    }
  }
  return hidden;
}

/**
 * ファイルの中身の指紋。
 *
 * 大きさと更新時刻ではなく中身を読む。Actor は `touch -t` も `truncate` も
 * 実行できるので、メタデータだけを見ていると同じ値に戻される。
 * 読めないもの（削除された、ディレクトリ）は読めなかったことを値にする。
 * 「無い」も前後で変われば変更として数える。
 */
function fingerprint(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

/**
 * base から分岐して以降に commit されたパス。
 *
 * **`origin/<base>` を先に試す。** 以前はローカルの `<base>` を先に見ていたが、
 * 関門の入力を Actor が選べる形になっていた。`ALWAYS_DENIED`（src/adapters/claude.ts）
 * が塞いでいるのは ref を**消す**側（`update-ref` / `branch -D`）だけで、
 * ローカル ref を**前に進める**側（`git branch -f main HEAD` など）は塞いでいない。
 * 一方 push が ahead を数えるのは `origin/<base>..HEAD` なので、ローカルの base
 * だけを HEAD に進めれば「関門には差分ゼロ、push には差分あり」が成立する。
 * 保護パスを書き換えた commit が、関門を鳴らさずに remote へ出ることになる。
 *
 * push と同じ ref を関門も見る、に揃える。`origin/<base>` が無いとき
 * （remote を持たない repo、clone 直後）はローカルの `<base>` に落とす。
 * 両方とも解決できなければ throw する。握り潰すと「確かめられなかった」が
 * 「変わっていない」になる。
 */
async function gitDiffAgainst(cwd: string, baseBranch: string): Promise<string> {
  try {
    return await git(cwd, ["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
  } catch (error) {
    try {
      return await git(cwd, ["diff", "--name-only", `${baseBranch}...HEAD`]);
    } catch {
      throw error;
    }
  }
}

/** `parent` の中にあるか。同じパスも中に数える */
function isInside(parent: string, target: string): boolean {
  const inside = relative(resolve(parent), target);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/**
 * `git status --porcelain` の1行からパスを取り出す。
 *
 * `R  old -> new` のようにリネームは2つ持つ。片方だけ見ると、保護パスから
 * 逃がす形のリネームを取りこぼす。
 */
function porcelainPaths(line: string): string[] {
  if (line.length <= 3) {
    return [];
  }
  const body = line.slice(3);
  const renamed = body.split(" -> ");
  return renamed.map((entry) => unquote(entry.trim())).filter((entry) => entry !== "");
}

/** core.quotePath が有効だと、非 ASCII を含むパスが二重引用符で囲まれて出る */
function unquote(entry: string): string {
  return entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
}

/**
 * worktree の差分を feature ブランチに push する。
 *
 * push 先は worktree が checkout しているブランチだけにする。base ブランチへ
 * 直接 push しない（design.md §7 の push_to_default_branch）。
 */
export function gitBranch(root: string): BranchPort {
  return {
    async push(name, baseBranch): Promise<PushResult> {
      const cwd = join(root, name);

      const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === baseBranch) {
        // ここを通すと controller が main を書き換えられる。設定ではなく実装で塞ぐ。
        throw new Error(`refusing to push to the base branch: ${branch}`);
      }
      if (!PUSHABLE_BRANCH.test(branch)) {
        // ブランチ名は worktree 側、つまり Actor が決める。argv で渡すので実行は
        // されないが、どの remote ref を作るかまで委ねる理由は無い。
        throw new Error(`branch name is not usable as a push target: ${branch}`);
      }

      // base との差分が無ければ push しない。空の PR は通知にも検証にも使えない。
      const ahead = await git(cwd, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
      if (ahead === "0") {
        return { branch, pushed: false };
      }

      // HEAD:<branch> の形にして、ローカルとリモートで名前がずれても同じ先に送る。
      await git(cwd, ["push", "-u", "origin", `HEAD:${branch}`]);
      return { branch, pushed: true };
    },
  };
}

/**
 * 人間の承認が常に未承認になる Port。
 *
 * PR がまだ無い Goal で使う。承認コメントの置き場所が無い状態を
 * 「承認された」と読まないため、捏造せずに null を返す。
 */
export function pendingApproval(): ApprovalPort {
  return { getApproval: async () => null };
}

/**
 * `gh auth token` から GitHub のトークンを読む。読めなければ null。
 *
 * `GITHUB_TOKEN` も `GH_TOKEN` も無いときの最後の手段になる。gh は README が
 * 挙げている前提そのもの（mise と gh が入っていること）なので、依存を増やさない。
 *
 * **これが無いと doctor が毎回赤くなる。** トークンを渡し忘れたまま回すのは
 * 実際に繰り返し起きていて、`ent doctor` のコメント自身が「GITHUB_TOKEN が無いまま
 * 回して `github.ci.conclusion` が永久に unobserved になった」と書いている。
 * 毎回落ちる検査は読まれなくなり、本当に落ちた回を見落とす。
 *
 * 落とし方を2つ決めてある。
 *
 * - **失敗を握り潰して null にする。** gh が入っていない・未ログイン・
 *   headless で対話ログインが無い、のいずれも「トークンが無い」で同じ扱いになる。
 *   ここで throw すると、トークン無しでも進められるローカルの観測と検証まで
 *   止まる（`doctorPayload` のコメントと同じ理由）
 * - **値をログにも例外にも載せない。** 返り値以外の経路に出さない。
 *   `withheldEnv` が Actor から `GITHUB_TOKEN` を落としている意味を消さないため、
 *   呼び出し側も `process.env` に書き戻さない
 *
 * argv 配列で叩く。シェルを経由してよいのは Goal YAML の `setup` と
 * `verification.run` だけになる（design.md §7）。
 */
export function ghAuthToken(): string | null {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

/**
 * `origin` が指す GitHub リポジトリ。読めなければ null。
 *
 * `ent plan` が書き出す宣言と、`ent init` が書く `.goals/config.yaml` の
 * `repository` を埋めるのに使う。**LLM にも人間の記憶にも書かせない。**
 * 存在しない owner 名を埋められると、最初のティックで GitHub の 404 として初めて
 * 表面化する（`goalTemplate` が同じ注意を書いている）。
 *
 * SSH（`git@github.com:owner/repo.git`）と HTTPS（`https://github.com/owner/repo`）の
 * 両方を読む。**GitHub 以外のホストは null にする。** `repository.provider` は
 * `github` 固定（design.md §5）なので、別ホストの owner/name を埋めると、
 * 宣言としては通るのに観測先だけが実在しない状態になる。
 */
export function gitRemoteRepository(repoRoot: string): { owner: string; name: string } | null {
  const url = gitOutput(repoRoot, ["remote", "get-url", "origin"]);
  if (url === null) {
    return null;
  }
  const matched = /(?:github\.com[:/])([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  const owner = matched?.[1];
  const name = matched?.[2];
  return owner === undefined || name === undefined ? null : { owner, name };
}

/**
 * `origin` の既定ブランチ。読めなければ null。
 *
 * **読めないことが普通にある。** `refs/remotes/origin/HEAD` を張るのは `git clone` で、
 * `git init` から始めた repo や、remote を後から足した repo には無い
 * （`git remote set-head origin -a` を叩けば張られる）。読めなかったときに
 * 既定値へ倒さず null を返すのは、呼び出し側が「フラグで渡してほしい」と
 * 言えるようにするため。ここで `main` を勝手に埋めると、既定が `master` の
 * リポジトリで宣言だけが静かに間違う。
 */
export function gitDefaultBranch(repoRoot: string): string | null {
  const head = gitOutput(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head === null) {
    return null;
  }
  const branch = head.startsWith("origin/") ? head.slice("origin/".length) : head;
  return branch === "" ? null : branch;
}

/**
 * 対象リポジトリの識別子。`ent init` が `.goals/config.yaml` の `repository` を埋める。
 *
 * owner と name は `gitRemoteRepository` が、既定ブランチは `gitDefaultBranch` が読む。
 * **後者が読めないときは、いま HEAD が指しているブランチに落とす。** `git init` から
 * 始めた repo には `refs/remotes/origin/HEAD` が無く、`ent init` を叩くいちばん
 * ありそうな順番（`git init` の直後）がまさにそれになる。`symbolic-ref --short HEAD` は
 * commit が1つも無くても読めるので、`rev-parse --abbrev-ref HEAD` は使わない。
 *
 * どちらも読めなければ null を返し、init は雛形の `your-org/your-repo` を書く。
 * **推測で埋めない。** 別のリポジトリの名前が入った config は、404 になるだけでなく、
 * 「埋めた覚えのない値が入っている」ので人間が疑う場所を1つ増やす。
 */
export function gitRepositoryIdentity(
  repoRoot: string,
): { owner: string; name: string; defaultBranch: string } | null {
  const repository = gitRemoteRepository(repoRoot);
  if (repository === null) {
    return null;
  }
  const defaultBranch =
    gitDefaultBranch(repoRoot) ?? gitOutput(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  return defaultBranch === null ? null : { ...repository, defaultBranch };
}

/** git を1回叩いて標準出力を読む。落ちたら null。argv 配列で叩く（シェルを経由しない） */
function gitOutput(repoRoot: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}
