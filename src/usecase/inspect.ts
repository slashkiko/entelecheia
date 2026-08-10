import type { Decision } from "../domain/action.js";
import type { Snapshot } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import type { GoalListItem, GoalState } from "../domain/goal-state.js";
import type { Run } from "../domain/run.js";
import type { Verification } from "../domain/verification.js";
import type { Store } from "../store/port.js";

/**
 * 登録済みの Goal を読んで、そのまま JSON にできる形で返す（`ent get` / `ent list`）。
 *
 * 書かない。読むだけにしてあるので、`Store` 以外の Port は要らない。
 */

/**
 * 出力の既定の上限（gist 2.5）。`--limit` で上げ下げできる。
 *
 * 上限が無いと、Goal が増えるほど1回の出力がエージェントのコンテキストを食う。
 * 切り捨てたときは絞り込み方を stderr に出すので、足りないことには気づける。
 */
export const DEFAULT_LIMIT = 50;

/**
 * `ent get` が出すもの。宣言部と実行時状態をマージして1枚にする（design.md §4.6）。
 *
 * 初めて ent run を全周させたとき、失敗の理由を追うのに SQLite を直接叩くことに
 * なった。goals の行だけでは、何を観測して何を確かめられなかったのかが読めない。
 *
 * 出力は JSON のままにする。人向けの整形は後から足せるが、機械可読を失うと
 * 検証コマンドから使えなくなる。
 */
export interface ShowPayload {
  goal: Goal["goal"];
  state: GoalState | null;
  /** 直近の観測。facts と unresolved を組で出す（design.md §3.1） */
  snapshot: Snapshot | null;
  /** criteria 単位の検証結果。§9 の完了判定が読む索引 */
  verifications: Verification[];
  /** 直近の判断。過去の分は listDecisions で引ける */
  decision: Decision | null;
  runs: Run[];
  /** DECIDE が使ったトークン。Run には出てこない分（design.md §7） */
  llm: { calls: number; tokens: number };
}

/** 出力を絞る指定。指定が無ければ DEFAULT_LIMIT で切る（gist 2.5） */
export interface LimitOptions {
  limit?: number | undefined;
}

export function showPayload(goal: Goal, store: Store, options: LimitOptions = {}): ShowPayload {
  const decisions = store.listDecisions(goal.goal.id);
  const calls = store.listLlmCalls(goal.goal.id);
  const runs = store.listRuns(goal.goal.id);
  const limit = options.limit ?? DEFAULT_LIMIT;

  return {
    goal: goal.goal,
    state: store.getState(goal.goal.id),
    snapshot: store.latestSnapshot(goal.goal.id),
    verifications: store.latestVerifications(goal.goal.id),
    decision: decisions.at(-1) ?? null,
    // 落とすなら古い方から落とす。直近の失敗を追うために読むものなので、
    // 新しい方を残す（listRuns は古い順に返す）。
    runs: runs.length <= limit ? runs : runs.slice(-limit),
    llm: {
      calls: calls.length,
      tokens: calls.reduce((total, call) => total + call.tokens, 0),
    },
  };
}

/**
 * `ent list` が出すもの。Store.listGoals をそのまま JSON にできる形で返す。
 *
 * cron から回す構成では、どの Goal が ACTIVE でどれが WAITING_HUMAN かを
 * まとめて見る手段が要る。Goal ごとに ent get を叩く手間を無くす。
 */
export function listPayload(store: Store, options: LimitOptions = {}): GoalListItem[] {
  const goals = store.listGoals();
  const limit = options.limit ?? DEFAULT_LIMIT;
  return goals.length <= limit ? goals : goals.slice(0, limit);
}

/**
 * 切り捨てが起きたときだけ、絞り込み方を返す。全部出たなら null。
 *
 * 「全部出た」と「途中で切れた」が同じ見た目だと、読む側は足りない分に気づけない。
 * 逆に毎回出すと、切れていないときまでノイズになる（gist 2.5）。
 *
 * 返す文面は stderr に出す。stdout に混ぜると JSON が壊れる（gist 4.3）。
 */
export function truncationHint(shown: number, total: number, flag: string): string | null {
  if (total <= shown) {
    return null;
  }
  return `${total} 件のうち ${shown} 件だけ出した。全部読むなら ${flag} <n> で上限を上げる`;
}
