import {
  type ApprovalHit,
  effectiveApprovalHits,
  isLockfile,
  isManifest,
  type RenovateCondition,
  type RenovateExceptionResult,
  renovateException,
} from "./approval-rules.js";
import type { ChangeSet } from "./change.js";
import { type EvidenceLevel, reaches } from "./evidence.js";
import { allowsAutoMerge, type WorkKind } from "./kind.js";
import type { EffectivePolicy } from "./policy.js";
import type { RepoPhase } from "./repo-state.js";
import { addsUnmatchedLines } from "./version-lines.js";

/**
 * 自動マージの判定（`decideAutoMerge`）。governor が merge の前に必ず通す。
 *
 * **結果は「自動マージ」か「人がマージ」の2つだけになる。** LLM の自己申告は入力に
 * 取らない。LLM の分類器の結果だけは受けるが、人を呼ぶ方向にしか効かない。
 * 承認ルールもエビデンスの要求も、差分そのものと、検査が base の
 * 定義で出したエビデンスだけを見る。
 */

/** 検査の結果。governor は PR の中のファイルではなく、その sha の実行から読む */
export interface EvidenceSummary {
  level: EvidenceLevel;
  /** 公開している型（生成した IPC 型など）に差分がある */
  typesChanged: boolean;
  /** スナップショットに差分がある */
  snapshotsChanged: boolean;
}

export interface ReviewSummary {
  /**
   * AI レビューとセキュリティレビューが両方とも走り終えたか。走らなかった・終わらなかった
   * ときは false にする。数が0でも、走っていなければ「指摘が無い」ことにはならない
   */
  completed: boolean;
  /** AI レビューかセキュリティレビューの、未解決の Important の数 */
  unresolvedImportant: number;
  /** レビューと修正を回した回数 */
  rounds: number;
}

export interface AutoMergeInput {
  policy: EffectivePolicy;
  change: ChangeSet;
  /** 検査の結果がまだ無い・検査できなかったときは null */
  evidence: EvidenceSummary | null;
  review: ReviewSummary;
  /** LLM の分類器が「人が要る」と言ったときだけ true。言わなかった・動かなかったは false */
  classifierNeedsHuman: boolean;
  repo: { phase: RepoPhase; halted: boolean };
  /** 判定の時刻（ISO 8601）。依存更新の例外が公開からの日数に使う */
  now: string;
}

/** レビューと修正の上限。これを超えたら方針の見直しを人に求める */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * 種別ごとに要るエビデンス。
 *
 * - 振る舞いを変えない変更（refactor・lint・docs・flaky）は E2 で、型とスナップショットに
 *   差分が無いこと。設計の作業種別の表は lint・docs・flaky を「E2」とだけ書くが、決定則は
 *   E2 を「振る舞いを変えない変更で、型とスナップショットの差分なし」に限っているので、
 *   どちらも満たす側に揃える
 * - fix と feat は E4（holdout と別ベンダーのレビューまで）
 * - deps はエビデンスの段ではなく、依存更新の例外の4条件で決める
 *
 * harness と migration は自動マージの対象にならない（`AUTO_MERGEABLE_KINDS`）。
 */
type Requirement =
  | { type: "level"; level: EvidenceLevel; unchangedSurface: boolean }
  | { type: "renovate" }
  | { type: "never" };

const REQUIREMENTS: Readonly<Record<WorkKind, Requirement>> = {
  refactor: { type: "level", level: "E2", unchangedSurface: true },
  lint: { type: "level", level: "E2", unchangedSurface: true },
  docs: { type: "level", level: "E2", unchangedSurface: true },
  flaky: { type: "level", level: "E2", unchangedSurface: true },
  fix: { type: "level", level: "E4", unchangedSurface: false },
  feat: { type: "level", level: "E4", unchangedSurface: false },
  deps: { type: "renovate" },
  harness: { type: "never" },
  migration: { type: "never" },
};

/** 人がマージする理由。人に見せるときは、この順のまま並べる */
export type HumanMergeReason =
  | { code: "halted" }
  | { code: "repo_onboarding" }
  | { code: "repo_suspended" }
  | { code: "approval_rule"; reason: string; files: string[] }
  | { code: "kind_not_auto_merge"; kind: WorkKind }
  | { code: "evidence_missing" }
  | { code: "evidence_insufficient"; required: EvidenceLevel; actual: EvidenceLevel }
  | { code: "surface_changed"; types: boolean; snapshots: boolean }
  | { code: "renovate_conditions_unmet"; unmet: RenovateCondition[] }
  | { code: "new_dependency"; files: string[] }
  | { code: "review_not_completed" }
  | { code: "review_count_invalid" }
  | { code: "unresolved_important_review"; count: number }
  | { code: "review_rounds_exceeded"; rounds: number }
  | { code: "classifier_needs_human" };

export type AutoMergeDecision =
  | { decision: "auto_merge"; reasons: [] }
  | { decision: "human_merge"; reasons: HumanMergeReason[] };

/**
 * 自動マージしてよいかを決める。次のどれかに当たれば「人がマージ」。
 *
 * - factory が止まっている（halt）
 * - リポジトリが登録直後か一時停止中
 * - 承認ルールに当たる（rename の両側と削除を含む。依存更新の例外で外れる分は除く）。
 *   下限は、渡されたポリシーに無くても足し直す（`withApprovalRuleFloor`）
 * - 種別がポリシーの auto_merge に無い
 * - エビデンスが種別の要求に届かない。無い・検査できなかったも届かないとみなす
 * - 新しい依存がある
 * - AI レビューとセキュリティレビューが走り終えていない。数が読めない（NaN など）
 * - AI レビューかセキュリティレビューに未解決の Important がある
 * - レビューと修正が3巡を超えた
 * - LLM の分類器が「人が要る」と判定した
 *
 * どれにも当たらなければ「自動マージ」。当たった理由は**全部**返す。1つ目で止めると、
 * 人が1つ直すたびに次の理由が出てきて、何を直せば通るのかが読めない。
 */
export function decideAutoMerge(input: AutoMergeInput): AutoMergeDecision {
  const { policy, change } = input;
  const reasons: HumanMergeReason[] = [];

  if (input.repo.halted) {
    reasons.push({ code: "halted" });
  }
  const phase = phaseReason(input.repo.phase);
  if (phase !== null) {
    reasons.push(phase);
  }

  const renovate = renovateException(change, {
    renovateAppId: policy.renovateAppId,
    now: input.now,
  });
  for (const hit of effectiveApprovalHits(change, policy.approvalRules, renovate)) {
    reasons.push(approvalReason(hit));
  }

  if (!allowsAutoMerge(policy.autoMerge, change.kind)) {
    reasons.push({ code: "kind_not_auto_merge", kind: change.kind });
  }

  reasons.push(...evidenceReasons(input, renovate));

  const added = filesAddingDependencies(change);
  if (added.length > 0) {
    reasons.push({ code: "new_dependency", files: added });
  }

  reasons.push(...reviewReasons(input.review));
  if (input.classifierNeedsHuman) {
    reasons.push({ code: "classifier_needs_human" });
  }

  return reasons.length === 0
    ? { decision: "auto_merge", reasons: [] }
    : { decision: "human_merge", reasons };
}

/**
 * リポジトリの状態のうち、自動マージを止めるもの。`switch` で全部の値を書くので、状態を
 * 足すとここで型が通らなくなる。足した状態を黙って「通常」と同じに扱わない。
 */
function phaseReason(phase: RepoPhase): HumanMergeReason | null {
  switch (phase) {
    case "normal":
      return null;
    case "onboarding":
      return { code: "repo_onboarding" };
    case "suspended":
      return { code: "repo_suspended" };
  }
}

/**
 * レビューの結果のうち、自動マージを止めるもの。数は「0 より大きいか」ではなく
 * 「0 か」で見る。NaN や負の数は、0 と比べると「指摘なし」に読めてしまう。
 */
function reviewReasons(review: ReviewSummary): HumanMergeReason[] {
  const reasons: HumanMergeReason[] = [];
  const countable = (value: number) => Number.isInteger(value) && value >= 0;
  if (!review.completed) {
    reasons.push({ code: "review_not_completed" });
  }
  if (!countable(review.unresolvedImportant) || !countable(review.rounds)) {
    reasons.push({ code: "review_count_invalid" });
  }
  if (review.unresolvedImportant > 0) {
    reasons.push({ code: "unresolved_important_review", count: review.unresolvedImportant });
  }
  if (review.rounds > MAX_REVIEW_ROUNDS) {
    reasons.push({ code: "review_rounds_exceeded", rounds: review.rounds });
  }
  return reasons;
}

function approvalReason(hit: ApprovalHit): HumanMergeReason {
  return { code: "approval_rule", reason: hit.rule.reason, files: hit.files };
}

function evidenceReasons(
  input: AutoMergeInput,
  renovate: RenovateExceptionResult,
): HumanMergeReason[] {
  const requirement = REQUIREMENTS[input.change.kind];
  switch (requirement.type) {
    case "never":
      // 種別の側で必ず人に回る（auto_merge に書けない）。ここで理由を重ねない。
      return [];
    case "renovate":
      return renovate.holds ? [] : [{ code: "renovate_conditions_unmet", unmet: renovate.unmet }];
    case "level": {
      const evidence = input.evidence;
      if (evidence === null) {
        return [{ code: "evidence_missing" }];
      }
      const reasons: HumanMergeReason[] = [];
      if (!reaches(evidence.level, requirement.level)) {
        reasons.push({
          code: "evidence_insufficient",
          required: requirement.level,
          actual: evidence.level,
        });
      }
      if (requirement.unchangedSurface && (evidence.typesChanged || evidence.snapshotsChanged)) {
        reasons.push({
          code: "surface_changed",
          types: evidence.typesChanged,
          snapshots: evidence.snapshotsChanged,
        });
      }
      return reasons;
    }
  }
}

/**
 * 新しい依存を足している manifest と lockfile。
 *
 * manifest は、追加されたもの、patch の無いもの、既存の行の付け替えで説明できない行を
 * 足したものを数える。依存の行か scripts の行かは区別しない。区別できないので、
 * 多めに人へ回す側に倒す。lockfile は行を読まず、呼ぶ側が新しいパッケージを読めなかった
 * ときと、1つでもあったときに数える。間接の依存は manifest には現れない。
 *
 * どちらも下限の承認ルールにも当たるので、依存更新の例外が成り立たない限りどのみち人が
 * マージする。ここで別の理由として出すのは、explain で「新しい依存」と読めるようにするため。
 */
function filesAddingDependencies(change: ChangeSet): string[] {
  const lockfileAdds = change.addedPackages === undefined || change.addedPackages.length > 0;
  return change.files
    .filter((file) => file.status !== "removed")
    .filter((file) => {
      if (isLockfile(file.path)) {
        return lockfileAdds;
      }
      if (!isManifest(file.path)) {
        return false;
      }
      return file.status === "added" || file.patch === undefined || addsUnmatchedLines(file.patch);
    })
    .map((file) => file.path);
}
