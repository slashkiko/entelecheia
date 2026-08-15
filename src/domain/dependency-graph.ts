/**
 * `goal.depends_on` が作る有向グラフの、読むだけの規則。
 *
 * もとは `src/usecase/doctor.ts` の中にあった。`ent plan` が書き出す前に同じ判定を
 * するので、ここへ出して読み手を1つにする。**循環検知が2つあると、doctor が
 * 通した集合を plan が落とす（逆も）状態を作れる。** 依存を持たない純粋な規則なので
 * ドメインに置ける。
 */

/**
 * 閉じた輪だけを取り出す。輪に入っていない Goal は返さない。
 *
 * 「複数の Goal が同じ依存先を指している」は循環ではない。菱形（alpha → base、
 * bravo → base）は閉じていないので、訪問済みを数えるだけの実装だとここを誤検知する。
 * 分解した本数が増えるほど当たるので、いま辿っている経路（`onPath`）に戻って
 * きたときだけを循環として数える。
 */
export function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  /** 辿り終えた頂点。ここから先に未発見の輪は無い */
  const done = new Set<string>();
  /** いま辿っている経路。ここに戻る辺だけが輪を閉じる */
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (id: string): void => {
    if (onPath.has(id)) {
      // 経路が自分に戻ってきた。閉じているのは戻り先から先端までで、
      // そこへ入ってきただけの手前の頂点は輪の中にいない。
      const cycle = path.slice(path.indexOf(id));
      const key = [...cycle].sort().join(">");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (done.has(id)) {
      return;
    }

    path.push(id);
    onPath.add(id);
    for (const next of edges.get(id) ?? []) {
      walk(next);
    }
    onPath.delete(id);
    path.pop();
    done.add(id);
  };

  for (const id of edges.keys()) {
    walk(id);
  }
  return cycles;
}

/**
 * 循環を人間が読む1行にする。doctor の助言と `ent plan` の断り文の両方が使う。
 *
 * 文言を2つ持たない。同じ壊れ方を別の言い方で伝えると、読む側は「別の問題か」を
 * 確かめる分だけ余計に読む。
 */
export function describeCycles(cycles: readonly (readonly string[])[]): string {
  return cycles.map((cycle) => [...cycle, cycle[0] ?? ""].join(" → ")).join(" / ");
}
