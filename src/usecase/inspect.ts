import type { Action, Decision } from "../domain/action.js";
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
 * 人間を待たせている判断だけを取り出した形。動いていれば null になる。
 *
 * 種別と理由を別のフィールドで持つ。`nextStatus` は
 * `ESCALATE(protected_path_touched)` も `WAIT(review_pending)` も同じ
 * `WAITING_HUMAN` に畳むので、status からはこの2つを見分けられない。前者は人間が
 * worktree を掃除しないと二度と進まず、後者は承認の1行で進む。1本の文字列に
 * 繋げてしまうと読む側が再び分解することになるので、組で持ったまま出す。
 */
export interface StoppedReason {
  action: StoppingAction["type"];
  reason: StoppingAction["reason"];
}

/** 人間なり外部なりを待つ行動。ACT / VERIFY / REPLAN / COMPLETE は「止まっている」ではない */
type StoppingAction = Extract<Action, { type: "WAIT" | "ESCALATE" }>;

/**
 * 直近ティックの検証結果の内訳。1度も検証していなければ null になる。
 *
 * 3値のまま数える。passed だけを出して残りを畳むと、「落ちた」と
 * 「確かめられなかった」が同じ見た目になる（design.md §3.1）。
 */
export interface CriteriaTally {
  passed: number;
  failed: number;
  unresolved: number;
}

/**
 * `ent list` の1件分。`Store.listGoals()` の6項目に、Goal をまたいで
 * 「いま誰の番で、どこまで通っているか」を読むための3つを足す。
 *
 * 足す側を `GoalListItem` に混ぜない。あちらは DB の goals 1行をそのまま写す型で
 * （`tests/store-list.test.ts` が仕様として固定している）、ここが読む
 * `latestVerifications` / `listDecisions` は別のテーブルにある。組み立てるのは
 * usecase の仕事にして、Store の口は1行を写すだけに保つ。
 */
export interface GoalListEntry extends GoalListItem {
  /** 直近の判断が WAIT / ESCALATE なら、その種別と理由。動いていれば null */
  stopped: StoppedReason | null;
  /** 直近ティックの検証結果の内訳。1度も検証していなければ null */
  criteria: CriteriaTally | null;
  /** 最後に判断した時刻。1度も判断していなければ null */
  lastDecidedAt: string | null;
}

/**
 * 止まっている理由を、直近の判断1件から読む。判断は足さない。
 *
 * 見張る主体は作らない。停止条件を決めているのは既にある純ロジックの関門
 * （`src/domain/guard-rules.ts`）で、ここはその関門が出した結論を写すだけになる。
 * LLM を呼ぶ経路は1本も増えない（design.md §7）。
 */
export function stoppedReason(decision: Decision | null): StoppedReason | null {
  const action = decision?.action;
  if (action === undefined || (action.type !== "WAIT" && action.type !== "ESCALATE")) {
    // COMPLETE をここに数えない。終わった Goal が毎回一覧の上で人を呼ぶことになる。
    return null;
  }
  return { action: action.type, reason: action.reason };
}

/** 検証結果を3値のまま数える。0件は「まだ回していない」なので null にする */
export function tallyCriteria(verifications: readonly Verification[]): CriteriaTally | null {
  if (verifications.length === 0) {
    // { passed: 0, failed: 0, unresolved: 0 } にすると、
    // 「まだ回していない」が「全部落ちている」と同じ見た目になる。
    return null;
  }

  const tally: CriteriaTally = { passed: 0, failed: 0, unresolved: 0 };
  for (const verification of verifications) {
    tally[verification.result] += 1;
  }
  return tally;
}

/**
 * `ent list` が出すもの。Goal をまたいで「いま誰の番か」を読めるようにする。
 *
 * cron から回す構成では、どの Goal が ACTIVE でどれが WAITING_HUMAN かを
 * まとめて見る手段が要る。Goal ごとに ent get を叩く手間を無くす。
 *
 * トップレベルは配列のままにする。オブジェクトに包むと `ent agent-context` と
 * SKILL.md まで波及する。
 *
 * **上限で切ってから読む。** 1件あたり Store を2回引くので、切るのを後回しにすると
 * 登録数に比例してクエリが増える。出さない分を読む理由は無い。
 */
export function listPayload(store: Store, options: LimitOptions = {}): GoalListEntry[] {
  const goals = store.listGoals();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const shown = goals.length <= limit ? goals : goals.slice(0, limit);

  return shown.map((goal) => {
    // listDecisions は古い順に返す。読むのは最後の1件だけにする。履歴に古い
    // ESCALATE が残っていても、次のティックで動き出していれば止まってはいない。
    const decision = store.listDecisions(goal.id).at(-1) ?? null;
    return {
      ...goal,
      stopped: stoppedReason(decision),
      criteria: tallyCriteria(store.latestVerifications(goal.id)),
      lastDecidedAt: decision?.decidedAt ?? null,
    };
  });
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
