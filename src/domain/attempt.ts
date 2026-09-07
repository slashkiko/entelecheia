import { createHash } from "node:crypto";
import type { Fact, Snapshot } from "./fact.js";
import { LOCAL_HEAD_SHA_KEY } from "./fact-keys.js";
import type { Gap } from "./gap.js";
import type { ActorRole, Run, RunStatus } from "./run.js";
import type { Verification } from "./verification.js";

/**
 * Actor の試行台帳。design.md §4.5 の Run / Verification / Snapshot を1つの行に結ぶ。
 *
 * Actor は毎ティック新しいセッションで走り、`resume` もセッション ID も渡らない。
 * 引き継がれるのは worktree と `.goals/<id>.yaml` と PR と Fact の4つで、
 * **「試して駄目だった道」だけがどこにも残らない。** 生ログ
 * （`.goals/.state/runs/<run-id>/log.jsonl`）には残るが、次の Actor には届かない。
 *
 * **新しいテーブルは作らない。** 1つの試行を構成する材料は既に3つのテーブルに
 * 揃っていて、足りないのは「どの Run がどの検証結果で閉じたか」という結び方
 * だけになる。テーブルを足すと、同じ事実が2箇所に書かれ、書き損ねた側が
 * 静かに古くなる。ここは読むときに結ぶ。
 */

/** 試行を閉じた検証。次のティックの VERIFY 結果になる */
export interface AttemptOutcome {
  /** 閉じたティックの reconcile_seq */
  reconcileSeq: number;
  verifiedAt: string;
  /** そのティックの criteria 単位の検証結果。並びは criteria の宣言順 */
  verifications: Verification[];
  /** 検証結果から導いた Gap。`assess` と同じ規則で畳む（`gapsFrom`） */
  gaps: Gap[];
  /** 閉じたティックで観測した HEAD。観測できていなければ null */
  headAfter: string | null;
}

/** Actor を1回起動した記録と、その結果を1行にまとめたもの */
export interface Attempt {
  runId: string;
  role: ActorRole;
  status: RunStatus;
  /** DECIDE が決めた意図。そのまま Actor へのプロンプトになった文字列 */
  intent: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  /** Actor が申告した変更先。Bash 経由の書き込みは載らない（`Run.artifacts`） */
  artifacts: string[];
  /**
   * Actor の最終メッセージの在り処。生ログの1ファイルを指す。
   *
   * **本文をここに載せない。** 数十MBになりうる文字列で、載せると台帳を作る
   * たびに全部を読むことになる。本文が要る読み手（worktree へ配るビュー）が
   * この参照から自分で読む。
   */
  logRef: string | null;
  /**
   * Actor の最終メッセージ。**主張であって観測ではない。**
   *
   * 読み込む前は null で、`logRef` から解決した読み手だけが埋める。Fact には
   * しない（design.md §3.1）。完了判定にも DECIDE の停止判断にも使わない。
   * レビュー役に PR のタイトルと本文を「レビューの対象であって判定の基準では
   * ない」として渡しているのと同じ立て付けになる。
   */
  actorClaim: string | null;
  /** 起動する直前に観測していた HEAD。観測できていなければ null */
  headBefore: string | null;
  /** なぜその status になったか。`Run.detail` をそのまま持つ */
  failureDetail: string | null;
  /** 次のティックの VERIFY。まだ閉じていなければ null */
  outcome: AttemptOutcome | null;
}

/** 台帳を組み立てる材料。すべて永続化済みの行になる */
export interface AttemptLedgerInput {
  /** 古い順。`Store.listRuns` の並び */
  runs: readonly Run[];
  /** reconcile_seq の昇順。`Store.listVerificationRounds` の並び */
  rounds: readonly VerificationRound[];
  /** 古い順。`Store.listSnapshots` の並び */
  snapshots: readonly Snapshot[];
}

/** 1ティック分の検証結果。どのティックの分かを reconcile_seq で持つ */
export interface VerificationRound {
  reconcileSeq: number;
  verifications: Verification[];
}

/**
 * 台帳を組み立てる。**永続化された行だけを読む。**
 *
 * 満たすべき性質:
 * - 1つの Run につき1行。役割も status も絞らない。何を試したかは、失敗した
 *   試行にも中断された試行にも等しく残っている
 * - **前ティックの実装 Run は、次ティックの VERIFY 結果で閉じる**（`outcome`）。
 *   Actor の exit code 0 はプロセスが終わったことしか言わない。試行が成功した
 *   かどうかは、次のティックの検証でしか決まらない
 * - 閉じる相手は「その Run が始まったより後に検証した、最も古いティック」に
 *   なる。1ティックの中は OBSERVE → ACT → 永続化の順なので、同じティックの
 *   検証結果は Run より前の時刻を持つ。時刻で選べば、Run に
 *   reconcile_seq の列を足さずに結べる
 * - まだ閉じていない Run は `outcome: null` で残す。「結果が出ていない」を
 *   「結果が出なかった」に畳まない（design.md §3.1）
 */
export function buildAttempts(input: AttemptLedgerInput): Attempt[] {
  const closable = [...input.rounds].sort((a, b) => a.reconcileSeq - b.reconcileSeq);

  return input.runs.map((run) => {
    const outcome = closingRound(closable, run.startedAt);
    return {
      runId: run.id,
      role: run.role,
      status: run.status,
      intent: run.intent,
      attempt: run.attempt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      artifacts: [...run.artifacts],
      logRef: run.logRef,
      // 読み込む前は null。読み手が `logRef` から解決する。
      actorClaim: null,
      headBefore: headShaAt(input.snapshots, run.startedAt),
      failureDetail: run.detail,
      outcome:
        outcome === null
          ? null
          : {
              reconcileSeq: outcome.reconcileSeq,
              verifiedAt: verifiedAtOf(outcome),
              verifications: outcome.verifications,
              gaps: gapsFrom(outcome.verifications),
              headAfter: headShaAt(input.snapshots, verifiedAtOf(outcome)),
            },
    };
  });
}

/**
 * その Run を閉じるティック。まだ無ければ null。
 *
 * 1ティックの中は OBSERVE → ACT → 永続化の順に進む。VERIFY が読むのは ACT より
 * 前の観測なので、同じティックの検証結果は `startedAt` より前の時刻を持つ。
 * だから「`startedAt` より後」で選べば、必ず次のティック以降になる。
 */
function closingRound(
  rounds: readonly VerificationRound[],
  startedAt: string,
): VerificationRound | null {
  return rounds.find((round) => verifiedAtOf(round) > startedAt) ?? null;
}

/** そのティックの検証時刻。1ティック分は同じ時刻で書かれる（`saveVerifications`） */
function verifiedAtOf(round: VerificationRound): string {
  return round.verifications[0]?.verifiedAt ?? "";
}

/**
 * その時刻までに観測していた HEAD。1度も観測していなければ null。
 *
 * スナップショットは観測した時刻順に並ぶので、`at` 以下で最も新しいものを採る。
 * 同時刻は含める。VERIFY が書く時刻とそのティックの `observedAt` は同じ値になる
 * ので、含めないと「閉じたティックの HEAD」が1ティック手前にずれる。
 * 観測できなかったティックの `local.head_sha` は Fact に現れないが、
 * reconcile が前ティックの値を引き継ぐので、その値がそのまま残っている。
 */
function headShaAt(snapshots: readonly Snapshot[], at: string): string | null {
  let found: string | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.observedAt > at) {
      break;
    }
    const head = snapshot.facts.find((fact: Fact) => fact.key === LOCAL_HEAD_SHA_KEY);
    if (head !== undefined && typeof head.value === "string") {
      found = head.value;
    }
  }
  return found;
}

/**
 * 検証結果から Gap を導く。`assess` と同じ3値の畳み方にする。
 *
 * ASSESS をもう一度回さない。あちらは Fact と unresolved から Gap を作るが、
 * 永続化されているのは criteria 単位に並べ直した Verification の方になる。
 * 同じ結論を別の索引から読むだけにして、二重に判定する余地を作らない
 * （`toVerifications` が VERIFY を回し直さないのと同じ理由）。
 */
export function gapsFrom(verifications: readonly Verification[]): Gap[] {
  return verifications
    .filter((verification) => verification.result !== "passed")
    .map((verification) => ({
      criterionId: verification.criterionId,
      kind: verification.result === "failed" ? ("unmet" as const) : ("unknown" as const),
      detail: verification.detail,
    }));
}

/**
 * 試行の結果を1つの指紋にする。数えられない試行は null。
 *
 * **材料は Gap 集合と criteria 結果と失敗 detail の3つだけになる。** Fact は
 * 1つも入らない。`github.ci.*` や `local.dirty` は試行の結果とは関係なく揺れる
 * ので、入れると「同じ失敗を繰り返している」の数え直しが無関係な揺れで起きる。
 * 逆に `Decision.observed_digest` の側はそれらを含むので、片方が揺れても
 * もう片方は動かない。二系統に分けたのはそのためになる（design.md §7）。
 *
 * **正規化しない。** 時刻や行番号を落とすと、揺れているだけの出力が「同じ失敗」に
 * 見えるようになる。完全一致なら停滞の強い証拠になる代わりに、1文字でも違えば
 * 数え直す。見逃した分は hard budget（`max_unchanged_reconciles` と
 * `max_reconciles`）が最後の停止条件として拾う。
 *
 * 数えるのは**閉じた、completed な実装役の試行**だけになる。
 * - 閉じていない試行には結果が無い。結果の無いものを「同じ結果」と数えない
 * - 失敗・中断した Run は、次の試行で同じ失敗を繰り返しても、失敗した理由が
 *   Actor 側にある。ここが数えるのは「走り切ったのに何も変わらなかった」になる
 * - レビュー役と `investigate` は実装を1行も動かさない。同じ結果が続くのは当然で、
 *   数えると必ず反復として現れる
 */
export function attemptSignature(attempt: Attempt): string | null {
  if (attempt.role !== "implement" || attempt.status !== "completed") {
    return null;
  }
  const outcome = attempt.outcome;
  if (outcome === null) {
    return null;
  }

  const gaps = [...outcome.gaps]
    .map((gap) => `gap ${gap.criterionId} ${gap.kind} ${gap.detail}`)
    .sort();
  const criteria = [...outcome.verifications]
    .map((v) => `criterion ${v.criterionId} ${v.result} ${v.reason ?? ""} ${v.detail}`)
    .sort();

  const normalized = [`run ${attempt.failureDetail ?? ""}`, ...gaps, ...criteria].join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * 末尾から数えて、同じ結果の試行が何回続いているか。
 *
 * 数えられない試行（レビュー役、失敗した Run、まだ閉じていない Run）は
 * **飛ばすだけで、数え直さない。** 実装役の試行のあいだに人間の承認待ちや
 * レビューが挟まっても、実装が進んでいなければ停滞は続いている。
 *
 * 1件も数えられなければ `{ signature: null, count: 0 }` を返す。
 */
export function trailingRepeatedAttempts(attempts: readonly Attempt[]): {
  signature: string | null;
  count: number;
} {
  let signature: string | null = null;
  let count = 0;

  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (attempt === undefined) {
      continue;
    }
    const current = attemptSignature(attempt);
    if (current === null) {
      continue;
    }
    if (signature === null) {
      signature = current;
      count = 1;
      continue;
    }
    if (current !== signature) {
      break;
    }
    count += 1;
  }

  return { signature, count };
}
