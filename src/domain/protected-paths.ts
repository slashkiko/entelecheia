import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Agent が触ってはいけないものに触れたかを判定する（design.md §7 の自己ホスト用）。
 *
 * Agent 側の `disallowedTools` は Agent の設定にすぎず、SDK の外から同じ操作を
 * されれば素通りする（§10-6）。controller 側にも関門を置き、Actor が編集した
 * ファイルを実行後に検査する。二重にしておくのは、片方は Agent の設定、
 * もう片方は controller の判定で、破れ方が違うため。
 *
 * ACT の中ではなく外（controller）に置く。act の中に入れると、Actor を
 * 起動する層と検査する層が同じになる。
 */

/**
 * 渡されたパスがどこを基点にしているか。実行時状態の除外を掛けてよいかを決める。
 *
 * `worktree` は Actor が編集したパス（`Run.artifacts`・`changedPaths`）。絶対パスか
 * worktree からの相対で、中の `.goals/.state/` は Agent の空きスペースになる。
 *
 * `repo_root` は本体リポジトリ側の観測（`repoDirtyState`・`outOfSightState`）。
 * `repoDirtyState` は絶対パスを返すので脱出の判定で捕まるが、`outOfSightState` は
 * **repoRoot 相対の表示用パス**を返す（`src/adapters/local.ts` の
 * `outOfSightPaths`）。`.git/hooks/pre-push` を人間が読める形で残すためで、
 * その代わり文字列だけを見ても worktree の中の同名パスと見分けが付かない。
 *
 * 見分けが付かないまま除外を掛けると、`.goals/.state/goals.db` の改竄——
 * まさに `outOfSightState` が見に行っている当のもの——が
 * 「worktree の中の実行時状態」として素通りする。出どころは呼び出し側しか
 * 知らないので、引数で受け取る。
 */
export type PathOrigin = "worktree" | "repo_root";

export interface Violation {
  /** 何に引っかかったか */
  kind: "escaped_worktree" | "protected_path";
  /** 実際に編集されたパス。Actor が返したものをそのまま残す */
  path: string;
  /** protected_path のときだけ埋まる。どの glob に一致したか */
  pattern: string | null;
}

/**
 * Actor が編集したファイルを検査する。
 *
 * 満たすべき性質:
 * - worktree の外に出た編集を、保護パスの一致より先に見る。
 *   隔離が破れたことの方が重い（§7 の「物理的に分ける」が成立していない）
 * - 保護パスは worktree からの相対パスで照合する。Actor が返すのは絶対パスなので、
 *   worktree の場所が変わってもパターンが腐らないようにする
 * - シンボリックリンクは実体へ解決してから見る。worktree の中に
 *   `link -> ../../../../src/controller` を置かれると、`..` で始まらずグロブにも
 *   一致しないパスができ、脱出の検査と保護パスの検査を両方すり抜けた
 * - worktree の中の `.goals/.state/` は照合しない。controller が書く実行時状態で、
 *   保護したい宣言部（`.goals/*.yaml`）ではない。詳しくは RUNTIME_STATE_DIR
 * - **本体リポジトリ側を出どころとするパスには、その除外を掛けない。**
 *   どこを基点にしたパスなのかは文字列からは読めないので、`origin` で受ける。
 *   詳しくは PathOrigin
 * - 判定できないものは違反にしない。捏造した違反で人間を呼ぶと、
 *   関門そのものが信用されなくなる
 */
export function findViolations(
  artifacts: readonly string[],
  worktreePath: string,
  protectedPaths: readonly string[],
  origin: PathOrigin = "worktree",
): Violation[] {
  const root = realpath(resolve(worktreePath));
  const violations: Violation[] = [];

  for (const artifact of artifacts) {
    const absolute = realpath(isAbsolute(artifact) ? resolve(artifact) : resolve(root, artifact));
    const inside = relative(root, absolute);

    // `..` で始まる、あるいは絶対パスのままなら worktree の外。
    if (inside.startsWith("..") || isAbsolute(inside)) {
      violations.push({ kind: "escaped_worktree", path: artifact, pattern: null });
      continue;
    }

    // 実行時状態は宣言部ではない。脱出の判定の「後」に置く。
    // 本体リポジトリ側を出どころとするパスには掛けない（PathOrigin）。
    if (origin === "worktree" && isRuntimeState(inside)) {
      continue;
    }

    const pattern = protectedPaths.find((glob) => matches(inside, glob));
    if (pattern !== undefined) {
      violations.push({ kind: "protected_path", path: artifact, pattern });
    }
  }

  return violations;
}

/** 人間と Decision の rationale が読む形にまとめる */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) =>
      v.kind === "escaped_worktree"
        ? `worktree の外を編集した: ${v.path}`
        : `保護パスを編集した: ${v.path}（${v.pattern}）`,
    )
    .join(" / ");
}

/**
 * 照合から外す唯一の場所。worktree の直下にある実行時状態の置き場。
 *
 * `.goals/**` は宣言部（人間が書く `.goals/*.yaml`）を守るために書かれているのに、
 * worktree の中の `.goals/.state/` にも一致する。Agent が自分の作業ツリーへ
 * 一時ファイルを1つ置いただけで `protected_path_touched` になり、しかも
 * 止まった時点でそのファイルはもう無い——人間に片付けるものが残らない停止になる。
 * 捏造した違反で人間を呼べば、関門そのものが信用されなくなる。
 *
 * 外してよい根拠は3つ:
 * - `.goals/.state/` は controller が書く実行時状態で gitignore 済み。
 *   design.md §4.6 が宣言部と分けている当のもので、人間は編集しない
 * - worktree の中のそれは本体の state dir ですらない。goals.db も Run のログも
 *   本体リポジトリ側にあり、ここは Agent が作った空きスペースにすぎない
 *
 * **本体側の state dir はこの除外の対象外になる（`origin: "repo_root"`）。**
 * かつてここには「本体側への書き込みは worktree の外なので escaped_worktree で
 * 先に捕まる」と書いてあったが、絶対パスで来るもの（`repoDirtyState`）にしか
 * 当てはまらなかった。`outOfSightState` は `.goals/.state/goals.db` を
 * repoRoot 相対の文字列で返すので `..` から始まらず、脱出の判定を素通りして
 * この除外に落ちていた。DB を偽造されても関門が鳴らない、という形になる。
 * 除外を掛けてよいかは文字列ではなく出どころで決める（PathOrigin）。
 */
const RUNTIME_STATE_DIR = ".goals/.state";

/**
 * worktree からの相対パスが実行時状態の下に入るかを、パスの区切りで判定する。
 *
 * 前方一致にすると `.goals/.stateful.yaml` のように名前を寄せるだけで宣言部を
 * 編集できるので、区切りまで含めて見る。ディレクトリ自身（`.goals/.state`）は
 * 中身と同じ扱いにする。丸ごと置き換えられても、そこにあるのは実行時状態になる。
 *
 * 基点は worktree の直下だけになる。`src/controller/.goals/.state/x.ts` は
 * この形にならないので、他の保護パターンに一致したまま残る。
 *
 * 大文字小文字は matches と同じく区別しない。区別しない FS では
 * `.goals/.State/` も同じディレクトリに届くので、照合と揃えないと
 * 「保護は広いのに除外は狭い」という誤検知がそのまま残る。
 */
function isRuntimeState(inside: string): boolean {
  const normalized = normalize(inside);
  return normalized === RUNTIME_STATE_DIR || normalized.startsWith(`${RUNTIME_STATE_DIR}/`);
}

/**
 * 実体のパスに解決する。存在しないパス（削除された、まだ無い）はそのまま返す。
 *
 * 「解決できなかったから見なかったことにする」と、消してから作り直す形で
 * 検査を抜けられる。解決できないなら元の文字列で照合を続ける。
 */
function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * glob の照合。依存を増やさないので自前で書く。
 *
 * 対応するのは `*`（区切りをまたがない）と `**`（区切りをまたぐ）と `?` の3つ。
 * `src/controller/**` や `tsconfig*.json` のような、§7 が並べる形を書ければ足りる。
 * `{a,b}` や `[]` は使わない。使いたくなったら、そのとき依存を足すか判断する。
 *
 * 末尾が `/**` のパターンは、そのディレクトリ自身にも一致させる。
 * `src/controller/**` が `src/controller` に一致しないと、
 * ディレクトリごと置き換えられたときに素通りする。
 *
 * 大文字小文字は区別しない。macOS の APFS も Windows も既定で区別しないので、
 * `src/Controller/index.ts` と書けば同じファイルに届くのに `src/controller/**`
 * には一致しない、という抜け道ができる。区別する FS では保護が少し広くなるが、
 * 広すぎて人間を呼ぶほうが、狭すぎて素通りするより安全側になる。
 */
function matches(path: string, glob: string): boolean {
  const normalized = normalize(path);
  // glob 側は区切りの読み替えをしない。`\` はエスケープとして扱う文字になる。
  const pattern = glob.normalize("NFC").toLowerCase();
  if (pattern.endsWith("/**") && normalized === pattern.slice(0, -3)) {
    return true;
  }
  return toRegExp(pattern).test(normalized);
}

/**
 * パスを照合できる形に揃える。区切りは `/`、Unicode は NFC、大文字小文字は畳む。
 *
 * 除外（isRuntimeState）と照合（matches）で同じ関数を使う。片方だけ揺れると、
 * 保護される形と除外される形がずれる。
 */
function normalize(path: string): string {
  return path.split("\\").join("/").normalize("NFC").toLowerCase();
}

function toRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**` は区切りをまたぐ。`**/` の形なら区切りごと飲み込む。
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    // それ以外は正規表現のメタ文字として解釈させない。
    source += char?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  return new RegExp(`^${source}$`);
}
