import { DatabaseSync } from "node:sqlite";
import { actionSchema, type Decision } from "../domain/action.js";
import { type Fact, type Unresolved, unresolvedSchema } from "../domain/fact.js";
import type { Goal } from "../domain/goal.js";
import { type GoalStatus, goalStatusSchema } from "../domain/goal-state.js";
import type { LlmCall } from "../domain/llm-call.js";
import {
  actorKindSchema,
  type Run,
  type RunIntent,
  type RunOutcome,
  runStatusSchema,
} from "../domain/run.js";
import { type Verification, verificationResultSchema } from "../domain/verification.js";

/**
 * design.md §4.5 のテーブルを SQLite に持つ。
 *
 * 機械だけが書く実行時状態を、人間が編集する `.goals/*.yaml` から分ける（§4.6）。
 * 同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
 *
 * ファイルではなく DB にする理由は §4.7。履歴がクエリになること、クラッシュ整合性、
 * イベントの冪等性の3つで、並行制御は決め手ではない。
 */

/** Goal の実行時状態。Goal YAML には現れない側 */
export interface GoalState {
  id: string;
  status: GoalStatus;
  /** lease の所有者。誰も持っていなければ null */
  leaseOwner: string | null;
  leaseUntil: string | null;
  /** 使用量上限などで待つ場合の再開時刻。分からなければ null */
  resumeAfter: string | null;
  /** ACTIVE にした時刻。経過時間の上限判定に使う */
  activatedAt: string | null;
  /** これまでに回した reconcile の回数 */
  reconciles: number;
  /**
   * 観測対象。Goal YAML は宣言部だけを持つので、ここが置き場になる。
   * PR が未作成なら null。
   */
  prNumber: number | null;
  issueNumber: number | null;
}

/** `ent list` / Store.listGoals が返す1件分。宣言部と実行時状態の要点だけをまとめる */
export interface GoalListItem {
  id: string;
  name: string;
  status: GoalStatus;
  reconciles: number;
  prNumber: number | null;
  resumeAfter: string | null;
}

export interface Snapshot {
  observedAt: string;
  facts: readonly Fact[];
  /** 観測・検証できなかった対象。DB 層で落とすと §3.1 が DB で再発する */
  unresolved: readonly Unresolved[];
}

export interface Store {
  /** Goal を登録する。既にあれば宣言部だけ更新し、実行時状態は触らない */
  upsertGoal(goal: Goal): void;
  getState(goalId: string): GoalState | null;
  /** 登録済みの Goal を id の昇順で一覧する */
  listGoals(): GoalListItem[];
  /**
   * 状態を書く。時刻は store が作らず、呼び出し側の時計から受け取る。
   * store が `new Date()` を使うと、注入した時計で動くティックと時間軸がずれる。
   *
   * `activatedAt` を渡すと、ACTIVE に入る時点でだけ activated_at を埋める。
   * 経過時間の上限（design.md §7）の起点になる。
   */
  setStatus(
    goalId: string,
    status: GoalStatus,
    resumeAfter: string | null,
    activatedAt?: string,
  ): void;
  setObserveTarget(goalId: string, prNumber: number | null, issueNumber: number | null): void;

  /**
   * lease を取る。取れたら true。
   * 行ロックではなく期限付きの所有権にすることで、クラッシュしても自動で解放される。
   */
  acquireLease(goalId: string, owner: string, until: Date): boolean;
  releaseLease(goalId: string, owner: string): void;

  /** 1ティックの観測結果をまとめて書く。reconciles もここで進める */
  saveSnapshot(goalId: string, snapshot: Snapshot): void;
  /** 直近のスナップショット。facts は次ティックの carriedFacts になる */
  latestSnapshot(goalId: string): Snapshot | null;

  /**
   * design.md §4.5 の Verification テーブル。criteria 単位の索引になる。
   * facts の `criteria.<id>.passed` と二重表現になるが、§4.5 の役割分担に従う。
   */
  saveVerifications(goalId: string, verifications: readonly Verification[]): void;
  /** 直近のティックの検証結果。§9 の完了判定はこれを読む */
  latestVerifications(goalId: string): Verification[];

  /** design.md §4.5 の Decision テーブル。L5 に食わせる履歴なので必ず残す */
  saveDecision(goalId: string, observedDigest: string, decision: Decision): void;
  /** 古い順。収束したかを見るには並びが要る */
  listDecisions(goalId: string): Decision[];
  /**
   * 直近の Decision に付いた観測ダイジェスト。1件も無ければ null。
   * 「前のティックから状態が変わったか」を、Fact を読み直さずに判定する。
   */
  latestDigest(goalId: string): string | null;
  /**
   * 末尾から数えて、同じ観測ダイジェストが何回連続しているか。
   * ループ検知（design.md §7 の `max_unchanged_reconciles`）が読む。
   */
  countTrailingDigest(goalId: string, digest: string): number;

  /**
   * LlmPort を1回呼んだ記録。Run とは別に持つ（design.md §7）。
   * 呼んだ直後に書く。まとめて後から書くと、途中で kill されたぶんが消える。
   */
  recordLlmCall(goalId: string, call: LlmCall): void;
  /** 古い順。トークンの合計はここから出す */
  listLlmCalls(goalId: string): LlmCall[];

  /** 副作用の前に意図を書く（§3.6）。戻り値は Run の id */
  startRun(goalId: string, intent: RunIntent): string;
  finishRun(runId: string, outcome: RunOutcome): void;
  /**
   * starting のまま残った Run を interrupted で確定し、その件数を返す。
   * 前のプロセスが死んだまま残った Run を回収する。
   */
  reclaimOrphanRuns(goalId: string, detail: string, finishedAt: string): number;
  listRuns(goalId: string): Run[];

  close(): void;
}

/**
 * SQLite を開いて Store を返す。
 *
 * 実装は Node 24 標準の `node:sqlite` を使う。better-sqlite3 と Drizzle は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 *
 * 満たすべき性質:
 * - WAL を有効にする。複数リーダー + 単一ライターが同時に動く（design.md §4.7）
 * - スキーマは開いた時点で用意する。存在すれば何もしない
 * - `:memory:` を渡せばファイルを作らない。テストはこれを使う
 * - unresolved を落とさない。facts と同じスナップショットに属する行として残す
 */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);

  // WAL にすれば「複数リーダー + 単一ライター」が同時に動く（design.md §4.7）。
  // :memory: では journal_mode が memory のまま変わらないが、エラーにはならない。
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(SCHEMA);

  const inTransaction = (write: () => void): void => {
    db.exec("BEGIN");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    upsertGoal(goal) {
      // 宣言部だけを更新する。ここで status を書くと、YAML を直すたびに進捗が消える。
      db.prepare(
        `INSERT INTO goals (id, name, desired_state, status)
         VALUES (?, ?, ?, 'DRAFT')
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, desired_state = excluded.desired_state`,
      ).run(goal.goal.id, goal.goal.name, goal.goal.desired_state);
    },

    getState(goalId) {
      const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        status: goalStatusSchema.parse(row.status),
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
        resumeAfter: row.resume_after,
        activatedAt: row.activated_at,
        reconciles: row.reconciles,
        prNumber: row.pr_number,
        issueNumber: row.issue_number,
      };
    },

    listGoals() {
      const rows = db
        .prepare(
          "SELECT id, name, status, reconciles, pr_number, resume_after FROM goals ORDER BY id ASC",
        )
        .all() as unknown as GoalListRow[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: goalStatusSchema.parse(row.status),
        reconciles: row.reconciles,
        prNumber: row.pr_number,
        resumeAfter: row.resume_after,
      }));
    },

    setStatus(goalId, status, resumeAfter, activatedAt) {
      // ACTIVE に入った時刻を残す。経過時間の上限（§7）の起点になる。
      // activatedAt を渡さなければ触らない。store が勝手に時刻を作らない。
      db.prepare(
        `UPDATE goals
            SET status = ?,
                resume_after = ?,
                activated_at = CASE
                  WHEN ? = 'ACTIVE' AND activated_at IS NULL THEN COALESCE(?, activated_at)
                  ELSE activated_at
                END
          WHERE id = ?`,
      ).run(status, resumeAfter, status, activatedAt ?? null, goalId);
    },

    setObserveTarget(goalId, prNumber, issueNumber) {
      db.prepare("UPDATE goals SET pr_number = ?, issue_number = ? WHERE id = ?").run(
        prNumber,
        issueNumber,
        goalId,
      );
    },

    acquireLease(goalId, owner, until) {
      // 期限付きの所有権にすることで、プロセスがクラッシュしても自動で解放される。
      // 更新行数が 0 なら他のワーカーが処理中（design.md §4.5）。
      const result = db
        .prepare(
          `UPDATE goals
              SET lease_owner = ?, lease_until = ?
            WHERE id = ?
              AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
        )
        .run(owner, until.toISOString(), goalId, owner, new Date().toISOString());
      return result.changes > 0;
    },

    releaseLease(goalId, owner) {
      // 他人の lease は解放しない。奪えるのは期限切れのときだけ。
      db.prepare(
        "UPDATE goals SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?",
      ).run(goalId, owner);
    },

    saveSnapshot(goalId, snapshot) {
      inTransaction(() => {
        const inserted = db
          .prepare("INSERT INTO snapshots (goal_id, observed_at) VALUES (?, ?)")
          .run(goalId, snapshot.observedAt);
        const snapshotId = Number(inserted.lastInsertRowid);

        const insertFact = db.prepare(
          `INSERT INTO facts
             (snapshot_id, seq, key, value, observed_at, confidence, evidence_source, evidence_detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        snapshot.facts.forEach((fact, seq) => {
          insertFact.run(
            snapshotId,
            seq,
            fact.key,
            JSON.stringify(fact.value ?? null),
            fact.observedAt,
            fact.confidence,
            fact.evidence?.source ?? null,
            fact.evidence?.detail ?? null,
          );
        });

        // 結論が出なかった対象も残す。落とすと §3.1 の問題が DB 層で再発する。
        const insertUnresolved = db.prepare(
          "INSERT INTO unresolved (snapshot_id, seq, key, reason, detail) VALUES (?, ?, ?, ?, ?)",
        );
        snapshot.unresolved.forEach((entry, seq) => {
          insertUnresolved.run(snapshotId, seq, entry.key, entry.reason, entry.detail);
        });

        db.prepare("UPDATE goals SET reconciles = reconciles + 1 WHERE id = ?").run(goalId);
      });
    },

    latestSnapshot(goalId) {
      const row = db
        .prepare("SELECT id, observed_at FROM snapshots WHERE goal_id = ? ORDER BY id DESC LIMIT 1")
        .get(goalId) as { id: number; observed_at: string } | undefined;
      if (row === undefined) {
        return null;
      }

      const factRows = db
        .prepare("SELECT * FROM facts WHERE snapshot_id = ? ORDER BY seq")
        .all(row.id) as unknown as FactRow[];
      const unresolvedRows = db
        .prepare("SELECT * FROM unresolved WHERE snapshot_id = ? ORDER BY seq")
        .all(row.id) as unknown as UnresolvedRow[];

      return {
        observedAt: row.observed_at,
        facts: factRows.map(toFact),
        unresolved: unresolvedRows.map((u) => ({
          key: u.key,
          reason: unresolvedSchema.shape.reason.parse(u.reason),
          detail: u.detail,
        })),
      };
    },

    saveVerifications(goalId, verifications) {
      // 1ティック分をまとめて1つの reconcile_seq に載せる。criteria をまたいで
      // 時点がずれると、「このティックの検証結果」を引けなくなる。
      inTransaction(() => {
        const insert = db.prepare(
          `INSERT INTO verifications
             (goal_id, reconcile_seq, criterion_id, result, reason,
              evidence_source, evidence_detail, detail, verified_at)
           VALUES (?, (SELECT reconciles FROM goals WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const verification of verifications) {
          insert.run(
            goalId,
            goalId,
            verification.criterionId,
            verification.result,
            verification.reason,
            verification.evidence?.source ?? null,
            verification.evidence?.detail ?? null,
            verification.detail,
            verification.verifiedAt,
          );
        }
      });
    },

    latestVerifications(goalId) {
      // 最後に書いたティックの分だけを返す。過去のティックと混ぜると、
      // 直したはずの criteria が failed のまま残って見える。
      const rows = db
        .prepare(
          `SELECT * FROM verifications
            WHERE goal_id = ?
              AND reconcile_seq = (SELECT MAX(reconcile_seq) FROM verifications WHERE goal_id = ?)
            ORDER BY id`,
        )
        .all(goalId, goalId) as unknown as VerificationRow[];
      return rows.map((row) => ({
        criterionId: row.criterion_id,
        result: verificationResultSchema.parse(row.result),
        reason: row.reason,
        evidence:
          row.evidence_source === null
            ? null
            : { source: row.evidence_source, detail: row.evidence_detail ?? "" },
        detail: row.detail,
        verifiedAt: row.verified_at,
      }));
    },

    saveDecision(goalId, observedDigest, decision) {
      // L5 の改善レイヤーに食わせる履歴。必ず残す（design.md §4.5）。
      db.prepare(
        `INSERT INTO decisions
           (goal_id, reconcile_seq, observed_digest, action, rationale, decided_by, decided_at)
         VALUES (?, (SELECT reconciles FROM goals WHERE id = ?), ?, ?, ?, ?, ?)`,
      ).run(
        goalId,
        goalId,
        observedDigest,
        JSON.stringify(decision.action),
        decision.rationale,
        decision.decidedBy,
        decision.decidedAt,
      );
    },

    listDecisions(goalId) {
      const rows = db
        .prepare("SELECT * FROM decisions WHERE goal_id = ? ORDER BY id")
        .all(goalId) as unknown as DecisionRow[];
      return rows.map((row) => ({
        decidedAt: row.decided_at,
        action: actionSchema.parse(JSON.parse(row.action)),
        rationale: row.rationale,
        decidedBy: row.decided_by === "llm" ? "llm" : "guard",
      }));
    },

    latestDigest(goalId) {
      const row = db
        .prepare("SELECT observed_digest FROM decisions WHERE goal_id = ? ORDER BY id DESC LIMIT 1")
        .get(goalId) as { observed_digest: string } | undefined;
      return row?.observed_digest ?? null;
    },

    countTrailingDigest(goalId, digest) {
      // 末尾から数える。間に別の観測が挟まれば連続は切れる。
      // 全件を数えると、過去に同じ状態を通ったぶんまで足してしまう。
      const rows = db
        .prepare("SELECT observed_digest FROM decisions WHERE goal_id = ? ORDER BY id DESC")
        .all(goalId) as unknown as { observed_digest: string }[];

      let count = 0;
      for (const row of rows) {
        if (row.observed_digest !== digest) {
          break;
        }
        count += 1;
      }
      return count;
    },

    recordLlmCall(goalId, call) {
      db.prepare(
        `INSERT INTO llm_calls (goal_id, purpose, tokens, log_ref, ok, called_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(goalId, call.purpose, call.tokens, call.logRef, call.ok ? 1 : 0, call.calledAt);
    },

    listLlmCalls(goalId) {
      const rows = db
        .prepare("SELECT * FROM llm_calls WHERE goal_id = ? ORDER BY id")
        .all(goalId) as unknown as LlmCallRow[];
      return rows.map((row) => ({
        purpose: "decide" as const,
        tokens: row.tokens,
        logRef: row.log_ref,
        ok: row.ok === 1,
        calledAt: row.called_at,
      }));
    },

    startRun(goalId, intent) {
      const inserted = db
        .prepare(
          `INSERT INTO runs
             (goal_id, intent, actor, worktree, attempt, status, started_at, artifacts)
           VALUES (?, ?, ?, ?, ?, 'starting', ?, '[]')`,
        )
        .run(
          goalId,
          intent.intent,
          intent.actor,
          intent.worktree,
          intent.attempt,
          intent.startedAt,
        );
      return String(inserted.lastInsertRowid);
    },

    finishRun(runId, outcome) {
      db.prepare(
        `UPDATE runs
            SET status = ?, finished_at = ?, exit_code = ?, log_ref = ?, tokens = ?,
                artifacts = ?, detail = ?
          WHERE id = ?`,
      ).run(
        outcome.status,
        outcome.finishedAt,
        outcome.exitCode,
        outcome.logRef,
        outcome.tokens,
        JSON.stringify(outcome.artifacts),
        outcome.detail,
        Number(runId),
      );
    },

    reclaimOrphanRuns(goalId, detail, finishedAt) {
      // starting のまま残っているのは、前のプロセスが確定を書けずに死んだということ。
      // 消さずに interrupted で確定させる（design.md §3.6）。
      const result = db
        .prepare(
          `UPDATE runs
              SET status = 'interrupted', finished_at = ?, detail = ?
            WHERE goal_id = ? AND status = 'starting'`,
        )
        .run(finishedAt, detail, goalId);
      return Number(result.changes);
    },

    listRuns(goalId) {
      const rows = db
        .prepare("SELECT * FROM runs WHERE goal_id = ? ORDER BY id")
        .all(goalId) as unknown as RunRow[];
      return rows.map((row) => ({
        id: String(row.id),
        intent: row.intent,
        actor: actorKindSchema.parse(row.actor),
        worktree: row.worktree,
        attempt: row.attempt,
        startedAt: row.started_at,
        status: runStatusSchema.parse(row.status),
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        logRef: row.log_ref,
        tokens: row.tokens,
        artifacts: JSON.parse(row.artifacts) as string[],
        detail: row.detail,
      }));
    },

    close() {
      db.close();
    },
  };
}

/**
 * Fact の再構成。
 *
 * INFERRED で evidence が無い場合はキーごと落とす。null を入れると
 * 「evidence がある」と読めてしまい、§3.1 の VERIFIED / INFERRED の分離が濁る。
 */
function toFact(row: FactRow): Fact {
  const base = {
    key: row.key,
    value: JSON.parse(row.value) as unknown,
    observedAt: row.observed_at,
  };

  if (row.confidence === "VERIFIED") {
    return {
      ...base,
      confidence: "VERIFIED",
      evidence: { source: row.evidence_source ?? "", detail: row.evidence_detail ?? "" },
    };
  }

  if (row.evidence_source === null) {
    return { ...base, confidence: "INFERRED" };
  }
  return {
    ...base,
    confidence: "INFERRED",
    evidence: { source: row.evidence_source, detail: row.evidence_detail ?? "" },
  };
}

interface GoalRow {
  id: string;
  status: string;
  lease_owner: string | null;
  lease_until: string | null;
  resume_after: string | null;
  activated_at: string | null;
  reconciles: number;
  pr_number: number | null;
  issue_number: number | null;
}

interface GoalListRow {
  id: string;
  name: string;
  status: string;
  reconciles: number;
  pr_number: number | null;
  resume_after: string | null;
}

interface FactRow {
  key: string;
  value: string;
  observed_at: string;
  confidence: string;
  evidence_source: string | null;
  evidence_detail: string | null;
}

interface UnresolvedRow {
  key: string;
  reason: string;
  detail: string;
}

interface DecisionRow {
  action: string;
  rationale: string;
  decided_by: string;
  decided_at: string;
}

interface VerificationRow {
  criterion_id: string;
  result: string;
  reason: string | null;
  evidence_source: string | null;
  evidence_detail: string | null;
  detail: string;
  verified_at: string;
}

interface LlmCallRow {
  tokens: number;
  log_ref: string;
  ok: number;
  called_at: string;
}

interface RunRow {
  id: number;
  intent: string;
  actor: string;
  worktree: string;
  attempt: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log_ref: string | null;
  tokens: number | null;
  artifacts: string;
  detail: string | null;
}

/**
 * design.md §4.5 のテーブル。
 *
 * Criteria / Plan / Task / Event はまだ作らない（§4.5 にもそう書いてある）。
 * criteria は Goal YAML が正で、残りは Plan の永続化と webhook を入れる Goal で足す。
 * 使う前に作ると、空のテーブルがスキーマの意図を曖昧にする。
 *
 * llm_calls は §4.5 に後から足したテーブル。DECIDE を Actor 層経由に寄せた（§3.5）結果、
 * Run を作らない LLM 呼び出しが生まれ、そのトークンを §7 のとおり残す場所が
 * 要るようになった。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  status        TEXT NOT NULL,
  lease_owner   TEXT,
  lease_until   TEXT,
  resume_after  TEXT,
  activated_at  TEXT,
  reconciles    INTEGER NOT NULL DEFAULT 0,
  pr_number     INTEGER,
  issue_number  INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL REFERENCES goals(id),
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
  seq             INTEGER NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  evidence_source TEXT,
  evidence_detail TEXT,
  PRIMARY KEY (snapshot_id, seq)
);

CREATE TABLE IF NOT EXISTS unresolved (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  seq         INTEGER NOT NULL,
  key         TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, seq)
);

CREATE TABLE IF NOT EXISTS verifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id         TEXT NOT NULL REFERENCES goals(id),
  reconcile_seq   INTEGER NOT NULL,
  criterion_id    TEXT NOT NULL,
  result          TEXT NOT NULL,
  reason          TEXT,
  evidence_source TEXT,
  evidence_detail TEXT,
  detail          TEXT NOT NULL,
  verified_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id   TEXT NOT NULL REFERENCES goals(id),
  purpose   TEXT NOT NULL,
  tokens    INTEGER NOT NULL,
  log_ref   TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  called_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id         TEXT NOT NULL REFERENCES goals(id),
  reconcile_seq   INTEGER NOT NULL,
  observed_digest TEXT NOT NULL,
  action          TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  decided_by      TEXT NOT NULL,
  decided_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL REFERENCES goals(id),
  intent      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  worktree    TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  exit_code   INTEGER,
  log_ref     TEXT,
  tokens      INTEGER,
  artifacts   TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_goal ON snapshots(goal_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_goal_status ON runs(goal_id, status);
CREATE INDEX IF NOT EXISTS idx_verifications_goal ON verifications(goal_id, reconcile_seq);
`;
