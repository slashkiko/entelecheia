/**
 * パスと glob の照合。ファイルシステムには触らない。
 *
 * もとは ent の保護パスの関門（`packages/ent/src/domain/protected-paths.ts`）の中にあった。
 * 関門は実パスの解決（`realpathSync`）を要件に持つので ent に残し、文字列の照合だけを
 * ここへ出した。承認ルール（`approval_rules`）のパスも同じ照合で当てる。2つの規則で
 * glob の読み方が揺れると、「保護パスでは当たるのに承認ルールでは外れる」パスが作れる。
 */

/**
 * glob の照合。依存を増やさないので自前で書く。
 *
 * 対応するのは `*`（区切りをまたがない）と `**`（区切りをまたぐ）と `?` の3つ。
 * `src/controller/**` や `tsconfig*.json` のような、§7 が並べる形を書ければ足りる。
 * `{a,b}` や `[]` は使わない。使いたくなったら、そのとき依存を足すか判断する。
 *
 * 末尾が `/**` のパターンは、そのディレクトリ自身にも一致させる。
 * `src/controller/**` が `src/controller` に一致しないと、
 * ディレクトリごと置き換えられたときに素通りする。末尾の `/**` を外した残りも glob として
 * 照合する。文字列として比べると、先頭が `**` のパターン（任意の深さの `.mise` を指すもの
 * など）では、先頭の `**` が残ったままになり、ディレクトリそのものには当たらない。
 *
 * 大文字小文字は区別しない。macOS の APFS も Windows も既定で区別しないので、
 * `src/Controller/index.ts` と書けば同じファイルに届くのに `src/controller/**`
 * には一致しない、という抜け道ができる。区別する FS では保護が少し広くなるが、
 * 広すぎて人間を呼ぶほうが、狭すぎて素通りするより安全側になる。
 */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = normalizePath(path);
  // glob 側は区切りの読み替えをしない。`\` はエスケープではなく、`\` という1文字として
  // 照合する。パスの側は `\` を `/` に揃えるので、`\` を含む glob はどのパスにも当たらない。
  const pattern = glob.normalize("NFC").toLowerCase();
  if (pattern.endsWith("/**") && compiled(pattern.slice(0, -3)).test(normalized)) {
    return true;
  }
  return compiled(pattern).test(normalized);
}

/**
 * パスを照合できる形に揃える。区切りは `/`、Unicode は NFC、大文字小文字は畳む。
 *
 * 除外（ent の `isRuntimeState`）と照合（matchesGlob）で同じ関数を使う。片方だけ揺れると、
 * 保護される形と除外される形がずれる。
 */
export function normalizePath(path: string): string {
  return path.split("\\").join("/").normalize("NFC").toLowerCase();
}

/**
 * 組み立てた正規表現の置き場。承認ルールは、変更したファイルの数だけ同じ glob を
 * 照合するので、毎回組み立て直さない。glob は設定とコードに書いたものだけで、数は増えない。
 */
const COMPILED = new Map<string, RegExp>();

function compiled(glob: string): RegExp {
  let regexp = COMPILED.get(glob);
  if (regexp === undefined) {
    regexp = toRegExp(glob);
    COMPILED.set(glob, regexp);
  }
  return regexp;
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
  // `s`（dotAll）が要る。無いと `.` が改行・`\r`・U+2028・U+2029 に当たらず、git が
  // 許すそれらの文字をファイル名に入れるだけで、`**` を使う規則を全部すり抜けられる。
  return new RegExp(`^${source}$`, "s");
}
