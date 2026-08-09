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
 * - 判定できないものは違反にしない。捏造した違反で人間を呼ぶと、
 *   関門そのものが信用されなくなる
 */
export function findViolations(
  artifacts: readonly string[],
  worktreePath: string,
  protectedPaths: readonly string[],
): Violation[] {
  const root = resolve(worktreePath);
  const violations: Violation[] = [];

  for (const artifact of artifacts) {
    const absolute = isAbsolute(artifact) ? resolve(artifact) : resolve(root, artifact);
    const inside = relative(root, absolute);

    // `..` で始まる、あるいは絶対パスのままなら worktree の外。
    if (inside.startsWith("..") || isAbsolute(inside)) {
      violations.push({ kind: "escaped_worktree", path: artifact, pattern: null });
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
 * glob の照合。依存を増やさないので自前で書く。
 *
 * 対応するのは `*`（区切りをまたがない）と `**`（区切りをまたぐ）と `?` の3つ。
 * `src/controller/**` と `.goals/**` を書ければ足りる（§7）。
 * `{a,b}` や `[]` は使わない。使いたくなったら、そのとき依存を足すか判断する。
 *
 * 末尾が `/**` のパターンは、そのディレクトリ自身にも一致させる。
 * `src/controller/**` が `src/controller` に一致しないと、
 * ディレクトリごと置き換えられたときに素通りする。
 */
function matches(path: string, glob: string): boolean {
  const normalized = path.split("\\").join("/");
  if (glob.endsWith("/**") && normalized === glob.slice(0, -3)) {
    return true;
  }
  return toRegExp(glob).test(normalized);
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
