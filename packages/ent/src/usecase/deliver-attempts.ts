import { type Attempt, buildAttempts } from "../domain/attempt.js";
import {
  ATTEMPT_VIEW_LIMIT,
  ATTEMPT_VIEW_PATH,
  type AttemptViewOptions,
  renderAttemptLedger,
} from "../domain/attempt-view.js";
import { finalMessageIn } from "../domain/run-log.js";
import type { Store } from "../store/port.js";

/**
 * 試行台帳の読み取り用ビューを、Actor の作業ツリーへ配る。
 *
 * **worktree に置くのは写しだけで、正本は状態 DB にある。** 毎ティック作り直して
 * 上書きするので、前のティックの Actor が書き換えても次のティックで捨てられる。
 * 宣言部を配る `deliverDeclaration`（`src/adapters/local.ts`）が同じ形を採っている。
 *
 * **「Actor には書かせない」は強制できない。** 置き場所は git に無視されており、
 * 無視されている＝保護パスの関門から見えないので、Actor は配られた写しを
 * 書き換えられる。`deliverDeclaration` が採っている緩和は「役を起動するたびに
 * 置き直す」で、ここは**ティックの頭で1回**置き直す。1ティックの中で実装役と
 * レビュー役が続けて走ると、後の役は前の役が書き換えた写しを読みうる。
 * 置き直す口が Actor の起動側（`src/act/index.ts` と `WorktreePort`）にあり、
 * どちらもファイルを書く手段を持たないので、いまはティック単位までになる。
 *
 * ## 置き場所を `.goals/.state/` にする理由
 *
 * 作業ツリーの中の `.goals/.state/` は、保護パスの関門が唯一照合から外す場所に
 * なる（`RUNTIME_STATE_DIR`、`src/domain/protected-paths.ts`）。無視されていない
 * 場所に置くと untracked なファイルが1本増え、`changedPaths` に出て
 * `protected_path_touched` になる。触ってもいない Actor が止められるうえ、
 * commit の `add --all` がそれを PR の diff に入れる。
 *
 * **`.goals/.state/` が無視されていることは `ent init` と `ent doctor` が担保する**
 * （`STATE_IGNORE_LINE` / `GOALS_IGNORE_LINE`）。どちらの行が書かれていても
 * この階層は覆われるので、配る前に git へ聞き直さない。
 */

export interface DeliverAttemptsProbes {
  /** ディレクトリを作る。既にあれば何もしない */
  ensureDir: (path: string) => void;
  /** ビューを書き出す。毎ティック上書きする */
  writeFile: (path: string, contents: string) => void;
  /** 生ログを読む。読めなければ throw してよい */
  readLog: (path: string) => Promise<string>;
  /** その作業ツリーが既にあるか */
  exists: (path: string) => boolean;
}

export interface DeliverAttemptsTarget {
  goalId: string;
  /** 配る先の作業ツリー。無ければ何もしない */
  worktreePath: string;
}

/**
 * ビューを1本置く。置いたら true、置かなかったら false。
 *
 * 満たすべき性質:
 * - **どの経路でも throw しない。** ここが落ちてティックが止まると、参考情報の
 *   配布が制御ループの停止条件になる。台帳が無ければ Actor は今までどおり
 *   worktree と宣言と PR だけを見て走る
 * - 作業ツリーがまだ無ければ何もしない。ent は作業ツリーを作らないので、無い
 *   ティックは配る先が無いティックになる
 * - 載せる試行が1件も無ければ、ファイルを置かない。空のビューは「前の試行は
 *   無かった」とも「読めなかった」とも読める
 * - `actor_claim` は生ログから読む。読めなかった1件で全体を落とさず、その1件を
 *   null のままにする（design.md §3.1）
 */
export async function deliverAttemptLedger(
  target: DeliverAttemptsTarget,
  store: Store,
  probes: DeliverAttemptsProbes,
  options: AttemptViewOptions = {},
): Promise<boolean> {
  try {
    if (!probes.exists(target.worktreePath)) {
      return false;
    }

    const attempts = buildAttempts({
      runs: store.listRuns(target.goalId),
      rounds: store.listVerificationRounds(target.goalId),
      snapshots: store.listSnapshots(target.goalId),
    });

    // 本文を読むのは、実際に載せる分だけにする。Goal が長くなるほど生ログは
    // 増えるので、全件を開くと配布のたびに読む量が試行数に比例する。上限を
    // ここで確定させ、同じ値を描画にも渡す。
    const limit = options.limit ?? ATTEMPT_VIEW_LIMIT;
    // `slice(-0)` は配列全体を返す（`renderAttemptLedger` に同じ注記がある）。
    const shown = limit <= 0 ? [] : attempts.slice(-limit);
    const withClaims = await Promise.all(shown.map((attempt) => withClaim(attempt, probes)));

    const body = renderAttemptLedger(withClaims, { limit });
    if (body === "") {
      return false;
    }

    const path = `${target.worktreePath}/${ATTEMPT_VIEW_PATH}`;
    probes.ensureDir(path.slice(0, path.lastIndexOf("/")));
    probes.writeFile(path, body);
    return true;
  } catch {
    return false;
  }
}

/** 生ログから最終メッセージを埋める。読めなければ null のままにする */
async function withClaim(attempt: Attempt, probes: DeliverAttemptsProbes): Promise<Attempt> {
  if (attempt.logRef === null) {
    return attempt;
  }
  try {
    return { ...attempt, actorClaim: finalMessageIn(await probes.readLog(attempt.logRef)) };
  } catch {
    return attempt;
  }
}
