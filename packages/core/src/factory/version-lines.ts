import type { FilePatch } from "./change.js";

/**
 * 差分が「バージョンの行だけ」に閉じているかを判定する。依存更新の自動マージの例外
 * （`renovateException`）が、manifest とワークフローの差分に使う。
 *
 * 行を構文として読むのではなく、**バージョンに見える値を1つの記号に置き換えたら、消した行と
 * 足した行が同じ形になるか**で見る。`"zod": "^4.4.3"` → `"zod": "^4.4.4"` は両方とも
 * `"zod": "<v>"` になって一致する。`"build": "tsc"` → `"build": "curl … | sh"` は
 * 一致しない。依存の名前・並び・行数が1つでも変われば外れる。
 *
 * 判定できないものは「バージョンの行だけではない」に倒す。その場合は人がマージするだけで、
 * 誤って自動マージに回ることはない。
 */

/**
 * バージョンに見える値。`^1.2.3`・`~1.2`・`>=1.2.0`・`v1.2.3`・`1.2.3-rc.1`・`pnpm@10.20.0` など。
 *
 * 点を1つ以上要る形にしてあるのは、`"port": "3000"` のような数字の設定値をバージョンとして
 * 扱わないため。`^4` のように前置記号の付いたものだけは点が無くてもバージョンとみなす。
 */
const VERSION =
  /^(?:[a-z][\w.-]*@)?(?:(?:[\^~]|[<>]=?|=)\s*v?\d+(?:\.\d+){0,3}|v?\d+(?:\.\d+){1,3})(?:[-+][0-9A-Za-z.-]+)?$/;

/** バージョンを置き換えたあとの印。元の行に現れない文字列にしておく */
const MARK = "\u0000v\u0000";

/**
 * 1行の中のバージョンに見える値を印に置き換える。置き換えた数も返す。
 *
 * 見るのは引用符で囲まれた値（JSON・TOML・Swift）と、空白で区切られた語（go.mod）だけ。
 * 語の途中に埋まった数字（`a.1.2.js`）は置き換えない。
 */
export function maskVersions(line: string): { masked: string; count: number } {
  let count = 0;
  const quoted = line.replace(/(["'])([^"']*)\1/g, (whole, quote: string, inner: string) => {
    if (VERSION.test(inner.trim())) {
      count += 1;
      return `${quote}${MARK}${quote}`;
    }
    return whole;
  });
  const masked = quoted
    .split(/(\s+)/)
    .map((token) => {
      if (VERSION.test(token)) {
        count += 1;
        return MARK;
      }
      return token;
    })
    .join("");
  return { masked, count };
}

/**
 * manifest の差分がバージョンの行だけか。
 *
 * - 消した行と足した行が同じ数で、順に対にしたとき、バージョンを伏せた形が一致する
 * - どの対にもバージョンが1つ以上ある（バージョンの無い行が動いたなら、それはバージョンの更新ではない）
 * - 対の中で実際に何かが変わっている（同じ行を消して足しただけの対は認めない）
 *
 * 依存を足す・消すと行数が合わなくなるので、新しい依存もここで外れる。
 */
export function isVersionOnlyPatch(patch: FilePatch): boolean {
  return everyPair(patch, (before, after) => {
    const a = maskVersions(before);
    const b = maskVersions(after);
    return a.count > 0 && b.count > 0 && a.masked === b.masked;
  });
}

/**
 * ワークフローの `uses:` を、commit sha とバージョンのコメントで固定した行。
 *
 * `- uses: actions/checkout@<40桁の sha> # v7.0.1` の形だけを認める。タグや
 * ブランチでの指定（`@v7`・`@main`）は、バージョンを固定していないので対象にしない。
 */
const PINNED_USES = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@[0-9a-f]{40}\s+#\s*v?\d[\w.+-]*\s*$/;

/**
 * ワークフローの差分が、固定した action のバージョンの付け替えだけか。
 *
 * 消した行と足した行が同じ数で、どの行も `PINNED_USES` の形をしており、順に対に
 * したとき同じ action を指している。`run:` も `permissions:` も `with:` も、1行でも
 * 動けば外れる。
 */
export function isPinOnlyPatch(patch: FilePatch): boolean {
  return everyPair(patch, (before, after) => {
    const a = PINNED_USES.exec(before);
    const b = PINNED_USES.exec(after);
    return a !== null && b !== null && a[1] === b[1];
  });
}

/**
 * 消した行と足した行を順に対にし、どの対も `accepts` を満たすか。
 *
 * 2つの判定が同じ対にし方を使う。行数が合わない、空、同じ行を消して足しただけの対がある、
 * のどれかなら、`accepts` を呼ぶ前に外す。
 */
function everyPair(patch: FilePatch, accepts: (before: string, after: string) => boolean): boolean {
  if (patch.added.length !== patch.removed.length || patch.added.length === 0) {
    return false;
  }
  return patch.removed.every((before, i) => {
    const after = patch.added[i];
    return after !== undefined && after !== before && accepts(before, after);
  });
}

/**
 * manifest の差分が、既存の行の付け替えでは説明できない行を足しているか。
 *
 * 新しい依存の検出に使う。足した行のうち、バージョンを伏せた形が消した行のどれとも一致しない
 * ものがあれば「足している」とみなす。依存の行か scripts の行かは区別しない。
 * 区別できないので、多めに人へ回す側に倒す。
 */
export function addsUnmatchedLines(patch: FilePatch): boolean {
  const removed = new Set(patch.removed.map((line) => maskVersions(line).masked));
  return patch.added.some((line) => line.trim() !== "" && !removed.has(maskVersions(line).masked));
}
