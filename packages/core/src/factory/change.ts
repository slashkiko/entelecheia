import type { WorkKind } from "./kind.js";

/**
 * 判定に掛ける変更（PR 1本）。governor が GitHub から読んだ値を詰めて渡す。
 *
 * **core は GitHub を読まない。** ここにある値はすべて呼ぶ側が観測したもので、
 * core はそれを決定的に判定するだけになる。Actor が書いたファイル（PR の中の
 * `evidence.json` など）から作ってはいけない。
 */
export interface ChangeSet {
  kind: WorkKind;
  /** PR を作った主体。名前ではなく ID で持つ（名前は付け替えられる） */
  author: ChangeAuthor;
  files: readonly ChangedFile[];
  /**
   * 依存更新で新しく解決されるバージョンと、その公開日時（ISO 8601）。**直接の依存だけでなく、
   * lockfile に新しく入る間接の依存のバージョンも全部入れる。** 呼ぶ側が lockfile の差分と
   * レジストリから読む。Renovate の PR の本文に並ぶのは直接の依存だけなので、それだけを
   * 入れると、公開直後の間接の依存が日数の条件をすり抜ける。
   * 依存更新でない変更では空でよい。
   */
  releases?: readonly Release[];
  /**
   * lockfile に前は無かったパッケージの名前（間接の依存も含む）。lockfile を変える変更で、
   * 呼ぶ側が lockfile の差分から読む。読めなかったときは入れない。**無いことは「新しい
   * 依存は無い」の証拠にならない。**
   */
  addedPackages?: readonly string[];
}

export type ChangeAuthor = { type: "app"; appId: number } | { type: "user"; userId: number };

/**
 * 変更したファイル1つ。rename だけが古い側（`previousPath`）を持ち、持たない rename は
 * 作れない。古い側が抜けると、承認ルールの外へ出す移動が新しい側だけで判定される。
 */
export type ChangedFile =
  | (ChangedFileBase & { status: "added" | "modified" | "removed"; previousPath?: never })
  | (ChangedFileBase & { status: "renamed"; previousPath: string });

interface ChangedFileBase {
  /** リポジトリのルートからの相対パス。rename なら新しい側 */
  path: string;
  /**
   * 差分の行（先頭の `+` / `-` を落としたもの）。GitHub は大きい差分の patch を
   * 返さないことがあり、そのときは無い。**無いことは「バージョンの行だけ」の証拠にならない。**
   */
  patch?: FilePatch;
}

export interface FilePatch {
  added: readonly string[];
  removed: readonly string[];
}

export interface Release {
  name: string;
  /** ISO 8601 */
  releasedAt: string;
}

/** 承認ルールを当てるパス。rename は古い側も含める */
export function sidesOf(file: ChangedFile): string[] {
  return file.previousPath === undefined || file.previousPath === file.path
    ? [file.path]
    : [file.path, file.previousPath];
}
