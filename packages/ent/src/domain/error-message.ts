/**
 * 例外から人間が読める1行を取り出す。
 *
 * 同じ3行が9モジュールに書き写されていた。うち2つは名前が `message` に
 * 変わっていて、既に表記が割れていた。この関数を良くする変更——`cause` を
 * 辿る、`AggregateError` を展開する——を入れると、9箇所のうち直したものだけが
 * 良くなり、残りは黙って古いままになる。
 *
 * 置き場所を domain にしてあるのは、9つの読み手が cli / act / observe /
 * verify / decide / publish / controller / adapters に散っているため。
 * domain は全員が依存してよい唯一の層になる。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
