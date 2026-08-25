import type { Action, Decision } from "../domain/action.js";
import type { Snapshot } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import { CONFIG_FILENAME } from "../domain/goal-config.js";
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

  return shown.map((goal) => goalListEntry(store, goal));
}

/** 1件分の Goal に、Goal をまたいで読むための3つを足す。上限で切ったあとに呼ぶ */
function goalListEntry(store: Store, goal: GoalListItem): GoalListEntry {
  // listDecisions は古い順に返す。読むのは最後の1件だけにする。履歴に古い
  // ESCALATE が残っていても、次のティックで動き出していれば止まってはいない。
  const decision = store.listDecisions(goal.id).at(-1) ?? null;
  return {
    ...goal,
    stopped: stoppedReason(decision),
    criteria: tallyCriteria(store.latestVerifications(goal.id)),
    lastDecidedAt: decision?.decidedAt ?? null,
  };
}

/**
 * `.goals/` に置かれている宣言ファイル1本。**中身は読まない。**
 *
 * 読むのはファイル名だけにする。「状態ストアに登録されていない」は、その YAML が
 * 妥当かどうかとは無関係に決まる事実で、壊れた宣言でも未登録であることは変わらない。
 * 読みに行くと、読めなかった1本のせいで一覧そのものが出せなくなる。
 */
export interface Declaration {
  /** ファイル名から決まる slug。`parseGoal` が `goal.id` と一致を強制する側 */
  id: string;
  /** リポジトリルートからのパス。人間がそのまま開ける形にする */
  path: string;
}

/**
 * `.goals/` のファイル名から、Goal の宣言だけを取り出す。
 *
 * **`config.yaml` は数えない。** あれは repo スコープの宣言（`CONFIG_SLUG`）で
 * Goal ではない。外さないと「未登録の Goal が1本ある」と毎回報告することになり、
 * `ent start config` を叩いた人間が CLI に断られる（`src/cli/parse.ts`）。
 * doctor の `loadGoalSummaries` が同じ理由で同じ除外をしている。
 *
 * ファイルシステムには触らない。読むのは呼び出し側（`src/cli.ts`）の仕事にして、
 * 「何を Goal と数えるか」の規則だけをここに置く。
 */
export function declarationsIn(fileNames: readonly string[]): Declaration[] {
  const found = new Map<string, Declaration>();
  for (const name of [...fileNames].sort()) {
    if (name === CONFIG_FILENAME || !(name.endsWith(".yaml") || name.endsWith(".yml"))) {
      continue;
    }
    const id = name.slice(0, name.lastIndexOf("."));
    // `x.yaml` と `x.yml` が両方あっても、Goal は1本。先に来た方を残す。
    if (id !== "" && !found.has(id)) {
      found.set(id, { id, path: `.goals/${name}` });
    }
  }
  return [...found.values()];
}

/**
 * 一覧の1件が何であるかを表す種別。**すべての要素がこのキーを持つ。**
 *
 * 欠けたフィールドから推測させない。`status` が無いことを「未登録」と読ませる形に
 * すると、キーが1つ増えた日に読む側の分岐が黙って壊れる。
 */
export type ListEntryKind = "registered" | "unregistered";

/** 状態ストアに登録済みの Goal。既定の `ent list` が出す形に `kind` だけを足す */
export interface RegisteredListEntry extends GoalListEntry {
  kind: "registered";
}

/**
 * `.goals/` にあるが、状態ストアに登録されていない宣言。
 *
 * **なぜ未登録なのかは書かない。** 実装まで終わっていて状態 DB を作り直しただけの
 * ものと、まだ始めていないものは、ent からは同じに見える。片方に寄せた語を1つでも
 * 置けば、それは観測ではなく推測になる（design.md §3.1）。区別するのは人間で、
 * ent が出すのは「登録されていない」という事実と、その宣言の在り処だけにする。
 */
export interface UnregisteredListEntry {
  kind: "unregistered";
  id: string;
  path: string;
}

export type ListEntry = RegisteredListEntry | UnregisteredListEntry;

/**
 * 登録されていない宣言を、宣言の一覧と状態ストアの差から取る。
 *
 * 突き合わせるのは id だけにする。宣言が消えている登録済み Goal は、ここには
 * 現れない（登録済みの側に出る）。逆向きだけを answer する関数にしてある。
 */
export function unregisteredDeclarations(
  store: Store,
  declared: readonly Declaration[],
): UnregisteredListEntry[] {
  const registered = new Set(store.listGoals().map((goal) => goal.id));
  return declared
    .filter((declaration) => !registered.has(declaration.id))
    .map((declaration) => ({
      kind: "unregistered",
      id: declaration.id,
      path: declaration.path,
    }));
}

/**
 * `ent list --include-unregistered` が出すもの。登録済みと未登録を1つの配列で返す。
 *
 * **既定の出力は変えない。** 登録済みの要素の形を1つでも動かすと、`ent list --json`
 * を読んでいるスクリプトが壊れる。ここは opt-in の枝で、その枝でだけ全要素に
 * `kind` が付く。既存の呼び出し（`listPayload`）は1文字も変わらない。
 *
 * 並びは登録済みが先で、それぞれの中は id の昇順になる。先頭から読めば、既定の
 * 出力と同じ順に同じものが並ぶ。
 *
 * `listPayload` と同じく**上限で切ってから読む**。1件あたり Store を2回引くので、
 * 出さない分を読む理由は無い。
 */
export function listEntries(
  store: Store,
  declared: readonly Declaration[],
  options: LimitOptions = {},
): ListEntry[] {
  const goals = store.listGoals();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const shownGoals = goals.slice(0, limit);
  const unregistered = unregisteredDeclarations(store, declared).slice(
    0,
    Math.max(0, limit - shownGoals.length),
  );

  return [
    ...shownGoals.map((goal) => ({ kind: "registered" as const, ...goalListEntry(store, goal) })),
    ...unregistered,
  ];
}

/** 切り捨てを知らせるための全件数。登録済みと未登録の合計になる */
export function listEntryTotal(store: Store, declared: readonly Declaration[]): number {
  return store.listGoals().length + unregisteredDeclarations(store, declared).length;
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
  return `Printed ${String(shown)} of ${String(total)}. Raise the cap with ${flag} <n> to read them all`;
}
