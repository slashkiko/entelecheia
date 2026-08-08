/**
 * `ent` コマンド。常駐しない（design.md §3.6）。
 *
 * 引数の解釈は Node 24 標準の `node:util` の parseArgs で書く。citty は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 */

export type Command =
  /** Goal を登録して ACTIVE にする */
  | { kind: "start"; slug: string }
  /** 1ティック回して終了する。--once は既定で、常駐する形は用意しない */
  | { kind: "run"; slug: string }
  /** 宣言部と実行時状態をマージして1枚で出す */
  | { kind: "show"; slug: string }
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
export function parseCommand(_argv: readonly string[]): Command {
  throw new Error("not implemented");
}
