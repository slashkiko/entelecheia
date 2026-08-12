// node:sqlite は Node 22.5 から入り、22.13 まではフラグが要る。package.json の
// engines を ">=24" にしてあるのはこのため。標準ではあるが experimental のままで、
// 起動時に ExperimentalWarning が出る。API が変わったときの移行先は
// better-sqlite3 で、Store インターフェースの内側に閉じている（design.md §6）。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actionSchema, decisionSchema } from "../domain/action.js";
import { errorMessage } from "../domain/error-message.js";
import { type Fact, unresolvedSchema } from "../domain/fact.js";
import { goalStatusSchema } from "../domain/goal-state.js";
import { llmCallSchema } from "../domain/llm-call.js";
import { portErrorKindSchema } from "../domain/port-error.js";
import {
  actorKindSchema,
  actorRoleSchema,
  DEFAULT_ACTOR_ROLE,
  runSchema,
  runStatusSchema,
} from "../domain/run.js";
import { verificationResultSchema } from "../domain/verification.js";
import type { Store } from "./port.js";

/**
 * design.md §4.5 のテーブルを SQLite に持つ。
 *
 * 機械だけが書く実行時状態を、人間が編集する `.goals/*.yaml` から分ける（§4.6）。
 * 同じファイルに入れると reconcile のたびに diff が出て、人間の編集履歴が埋もれる。
 *
 * ファイルではなく DB にする理由は §4.7。履歴がクエリになること、クラッシュ整合性、
 * イベントの冪等性の3つで、並行制御は決め手ではない。
 */

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

  // busy_timeout を**最初に**置く。既定値は 0 で、ロックに当たった瞬間に
  // SQLITE_BUSY を投げる。以前は journal_mode の後ろに並べていたので、
  // その手前で掴まれていると待たずに `database is locked` を投げて openStore が
  // 落ちていた。ティックは1周もせず、lease もスキップの記録も残らないまま
  // exit 1 になる。スキーマの作成（下の db.exec(SCHEMA)）も同じ理由で後ろに置く。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

  // WAL にすれば「複数リーダー + 単一ライター」が同時に動く（design.md §4.7）。
  // ここだけ busy_timeout では待てないので、待つ側を自前で持つ（enableWal を参照）。
  enableWal(db);

  db.exec(`
    PRAGMA synchronous  = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(SCHEMA);
  migrate(db);

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
      const row = parseRow(
        goalRowSchema,
        db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId),
        "getState",
      );
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
        abandonReason: row.abandon_reason,
        guardBaseSha: row.guard_base_sha,
      };
    },

    listGoals() {
      const rows = parseRows(
        goalListRowSchema,
        db
          .prepare(
            "SELECT id, name, status, reconciles, pr_number, resume_after FROM goals ORDER BY id ASC",
          )
          .all(),
        "listGoals",
      );
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

    abandon(goalId, reason) {
      // status と理由を同じ UPDATE で書く。分けると、片方だけ書かれた
      // 「理由の無い ABANDONED」や「ACTIVE なのに理由がある」行を作れてしまう。
      // 観測の履歴（snapshots / facts / verifications）には触らない。
      // あれは最後のティックが何を見たかの記録で、書き換えるのは観測の捏造になる。
      db.prepare("UPDATE goals SET status = 'ABANDONED', abandon_reason = ? WHERE id = ?").run(
        reason,
        goalId,
      );
    },

    setObserveTarget(goalId, prNumber, issueNumber) {
      db.prepare("UPDATE goals SET pr_number = ?, issue_number = ? WHERE id = ?").run(
        prNumber,
        issueNumber,
        goalId,
      );
    },

    setGuardBase(goalId, sha) {
      db.prepare("UPDATE goals SET guard_base_sha = ? WHERE id = ?").run(sha, goalId);
    },

    acquireLease(goalId, owner, until, now) {
      // 期限付きの所有権にすることで、プロセスがクラッシュしても自動で解放される。
      // 更新行数が 0 なら他のワーカーが処理中（design.md §4.5）。
      const result = db
        .prepare(
          `UPDATE goals
              SET lease_owner = ?, lease_until = ?
            WHERE id = ?
              AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
        )
        .run(owner, until.toISOString(), goalId, owner, now.toISOString());
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
      const row = parseRow(
        snapshotHeadSchema,
        db
          .prepare(
            "SELECT id, observed_at FROM snapshots WHERE goal_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(goalId),
        "latestSnapshot",
      );
      if (row === undefined) {
        return null;
      }

      const factRows = parseRows(
        factRowSchema,
        db.prepare("SELECT * FROM facts WHERE snapshot_id = ? ORDER BY seq").all(row.id),
        "latestSnapshot.facts",
      );
      const unresolvedRows = parseRows(
        unresolvedRowSchema,
        db.prepare("SELECT * FROM unresolved WHERE snapshot_id = ? ORDER BY seq").all(row.id),
        "latestSnapshot.unresolved",
      );

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
      const rows = parseRows(
        verificationRowSchema,
        db
          .prepare(
            `SELECT * FROM verifications
            WHERE goal_id = ?
              AND reconcile_seq = (SELECT MAX(reconcile_seq) FROM verifications WHERE goal_id = ?)
            ORDER BY id`,
          )
          .all(goalId, goalId),
        "latestVerifications",
      );
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
      const rows = parseRows(
        decisionRowSchema,
        db.prepare("SELECT * FROM decisions WHERE goal_id = ? ORDER BY id").all(goalId),
        "listDecisions",
      );
      return rows.map((row) => ({
        decidedAt: row.decided_at,
        action: actionSchema.parse(JSON.parse(row.action)),
        rationale: row.rationale,
        // 他の列挙列と同じく Zod で読む。三項で畳んでいたころは、
        // decidedBy に3つ目の値を足しても型エラーにならないまま
        // DB の正しい値が "guard" に化けた。
        decidedBy: decisionSchema.shape.decidedBy.parse(row.decided_by),
      }));
    },

    latestDigest(goalId) {
      const row = parseRow(
        digestRowSchema,
        db
          .prepare(
            "SELECT observed_digest FROM decisions WHERE goal_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(goalId),
        "latestDigest",
      );
      return row?.observed_digest ?? null;
    },

    countTrailingDigest(goalId, digest) {
      // 末尾から数える。間に別の観測が挟まれば連続は切れる。
      // 全件を数えると、過去に同じ状態を通ったぶんまで足してしまう。
      const rows = parseRows(
        digestRowSchema,
        db
          .prepare("SELECT observed_digest FROM decisions WHERE goal_id = ? ORDER BY id DESC")
          .all(goalId),
        "countTrailingDigest",
      );

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
      const rows = parseRows(
        llmCallRowSchema,
        db.prepare("SELECT * FROM llm_calls WHERE goal_id = ? ORDER BY id").all(goalId),
        "listLlmCalls",
      );
      return rows.map((row) => ({
        // 列を捨てて固定値を返していたころは、purpose が union になった瞬間に
        // 全レコードが decide を名乗るようになる形だった（型エラーは出ない）。
        purpose: llmCallSchema.shape.purpose.parse(row.purpose),
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
             (goal_id, intent, actor, role, worktree, attempt, status, started_at, artifacts)
           VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, '[]')`,
        )
        .run(
          goalId,
          intent.intent,
          intent.actor,
          intent.role,
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
                artifacts = ?, detail = ?, error_kind = ?, actor_resume_after = ?
          WHERE id = ?`,
      ).run(
        outcome.status,
        outcome.finishedAt,
        outcome.exitCode,
        outcome.logRef,
        outcome.tokens,
        JSON.stringify(outcome.artifacts),
        outcome.detail,
        outcome.errorKind ?? null,
        outcome.resumeAfter ?? null,
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
      const rows = parseRows(
        runRowSchema,
        db.prepare("SELECT * FROM runs WHERE goal_id = ? ORDER BY id").all(goalId),
        "listRuns",
      );
      return rows.map((row) => ({
        id: String(row.id),
        intent: row.intent,
        actor: actorKindSchema.parse(row.actor),
        // role を持たない DB から読んだ行は実装役として読む（列の既定値と同じ）。
        role: actorRoleSchema.parse(row.role ?? DEFAULT_ACTOR_ROLE),
        worktree: row.worktree,
        attempt: row.attempt,
        startedAt: row.started_at,
        status: runStatusSchema.parse(row.status),
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        logRef: row.log_ref,
        tokens: row.tokens,
        artifacts: parseArtifacts(row.artifacts, "listRuns"),
        detail: row.detail,
        ...(row.error_kind === null ? {} : { errorKind: row.error_kind }),
        ...(row.actor_resume_after === null ? {} : { resumeAfter: row.actor_resume_after }),
      }));
    },

    guardDigest(goalId, ownRunIds = []) {
      return guardDigestOf(db, path, goalId, ownRunIds);
    },

    close() {
      db.close();
    },
  };
}

/**
 * 関門が状態 DB を見る単位。**ファイルのバイト列ではなく、論理的な行から作る**
 * （issue #62）。
 *
 * `.goals/.state/goals.db` は関門が指紋で見る保護対象でありながら、controller
 * 自身の書き込み先でもある。バイト列を見ているかぎり、この2つは同じ差として
 * 現れる。SQLite は WAL なので普段 controller の書き込みは `goals.db-wal` に
 * 載るだけだが、WAL が既定の閾値（1000 ページ）を越えたコミットでは自動
 * checkpoint が走り、`goals.db` の中身が動く。ティックの形が同じでも、その
 * プロセスがそれまでに書いた量が閾値を跨いだ回だけ `protected_path_touched` に
 * なっていた（`tests/state-db-wal-checkpoint.test.ts`）。
 *
 * 論理的な行から作れば、checkpoint も VACUUM もページの再配置も値を動かさない。
 *
 * **Goal ごとに閉じる。** 引数の Goal に属する行だけを見る。同じディレクトリで
 * 2本目の ent が別の Goal を回しても、こちらの値は動かない。行が goal_id を
 * 持つこと自体は最初からそうなっており（`facts` と `unresolved` は
 * `snapshots` 経由で辿れる）、スキーマは変えていない。**行を分けるだけでは
 * 解けなかったのは、WAL が DB ファイルに1つしか無いため**で、論理ダイジェストと
 * 組にして初めて Goal ごとに閉じた観測になる。
 *
 * **controller 自身が ACT の窓の中で書く分だけを射影から外す。** 外すのは2つ。
 * - `goals` の lease 列（`lease_owner` / `lease_until`）。ティックのあいだ
 *   延長し続けるので、必ず動く
 * - `ownRunIds` に渡された Run の行。write-ahead（`startRun`）と確定
 *   （`finishRun`）で、ACT の窓のちょうど真ん中に書かれる
 *
 * ほかは全部見る。スキーマ（`sqlite_master`）も見る。trigger を1つ仕込めば
 * 行を変えずに以降の書き込みへ副作用を付けられる。ファイルの存在も見る。
 * 開いたままのコネクションは unlink されたファイルを読み続けるので、行だけを
 * 見ていると消されたことに気づけない。
 *
 * **バイト列を捨てて諦めたもの。** 「バイト列は違うが、この Goal の論理的な行は
 * 同じ」改竄は通る。具体的には (1) 別の Goal の行、(2) この Goal の lease 列、
 * (3) このティックで controller が作った Run の行、(4) ファイルの差し替えや
 * 破損のうち上の射影に出ないもの。
 *
 * **代わりに1つ強くなっている。** ここは SQLite 経由で読むので、まだ WAL に
 * しか無い行も見える。バイト列の指紋は次の checkpoint まで見えなかった
 * （design.md §10-6 の (g)）。SQLite 経由で DB を書き換える改竄——`goals.db` を
 * 直接開いて `UPDATE goals SET status='COMPLETED'` を流す形——は、いちばん
 * 現実的な攻撃でありながら、バイト列では取りこぼしうるものだった。
 */
function guardDigestOf(
  db: DatabaseSync,
  path: string,
  goalId: string,
  ownRunIds: readonly string[],
): string {
  // 節ごとに別々のクエリを流すので、そのあいだに別プロセスが commit すると
  // 前半と後半で別の時点を読む。1つの読み取りトランザクションに包んで、
  // 全部の節を同じ時点から読む。
  db.exec("BEGIN DEFERRED");
  try {
    return digestSections(db, path, goalId, ownRunIds);
  } finally {
    // 読むだけなので、閉じ方は COMMIT でも ROLLBACK でも同じになる。
    db.exec("COMMIT");
  }
}

function digestSections(
  db: DatabaseSync,
  path: string,
  goalId: string,
  ownRunIds: readonly string[],
): string {
  const hash = createHash("sha256");
  const write = (section: string, rows: readonly Record<string, unknown>[], skip: Set<string>) => {
    // 節の名前も混ぜる。混ぜないと「空のテーブル」と「節ごと無い」が同じになる。
    hash.update(`${section}${SECTION}`);
    for (const row of rows) {
      hash.update(encodeRow(row, skip));
      hash.update(ROW);
    }
    hash.update(SECTION);
  };

  // ファイルの存在。`:memory:` は常に在ることにする（消せる先が無い）。
  hash.update(`file:${path === ":memory:" || existsSync(path) ? "present" : "missing"}${SECTION}`);

  // スキーマ。`sqlite_%` は SQLite が持つ内部テーブルなので外す。とくに
  // `sqlite_sequence` は**最初の AUTOINCREMENT な INSERT で初めて生える**ので、
  // 残すと新しい DB の1回目の ACT が「スキーマが増えた」で鳴る。中身（採番の
  // 現在値）は別の Goal の INSERT でも進むため、いずれにせよ見てはいけない。
  // `rootpage` も読まない。VACUUM で動くが、意味のある変化ではない。
  write(
    "schema",
    db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite~_%' ESCAPE '~'
          ORDER BY type, name, tbl_name`,
      )
      .all() as unknown as Record<string, unknown>[],
    new Set(),
  );

  for (const section of GUARD_SECTIONS) {
    write(
      section.name,
      db.prepare(section.sql).all(goalId) as unknown as Record<string, unknown>[],
      new Set(section.skip ?? []),
    );
  }

  // Run だけは行を落とすので別に組む。落とすのは `ownRunIds` に挙がったものだけで、
  // テーブルごとではない。ACT の窓で誰かに Run を差し込まれたら鳴る。
  const own = new Set(ownRunIds);
  write(
    "runs",
    (
      db
        .prepare("SELECT * FROM runs WHERE goal_id = ? ORDER BY id")
        .all(goalId) as unknown as Record<string, unknown>[]
    ).filter((row) => !own.has(String(row.id))),
    new Set(),
  );

  return hash.digest("hex");
}

/**
 * ダイジェストに載せる節。**列は `SELECT *` で取る。**
 *
 * 列を1つずつ並べると、あとから足した列が黙って射影から落ちる。落ちた列は
 * 書き換えても関門が鳴らないので、増やした本人にも気づく手段が無い。
 * 外す列は `skip` に名指しで書く。
 *
 * `facts` と `unresolved` は goal_id を持たないので `snapshots` 経由で辿る。
 * 並びは主キーで固定する。SQLite は ORDER BY 無しの並びを保証しない。
 */
const GUARD_SECTIONS: readonly { name: string; sql: string; skip?: readonly string[] }[] = [
  {
    name: "goals",
    sql: "SELECT * FROM goals WHERE id = ?",
    // lease は ACT の窓のあいだ controller 自身が延長し続ける。
    skip: ["lease_owner", "lease_until"],
  },
  { name: "snapshots", sql: "SELECT * FROM snapshots WHERE goal_id = ? ORDER BY id" },
  {
    name: "facts",
    sql: `SELECT facts.* FROM facts
            JOIN snapshots ON snapshots.id = facts.snapshot_id
           WHERE snapshots.goal_id = ?
           ORDER BY facts.snapshot_id, facts.seq`,
  },
  {
    name: "unresolved",
    sql: `SELECT unresolved.* FROM unresolved
            JOIN snapshots ON snapshots.id = unresolved.snapshot_id
           WHERE snapshots.goal_id = ?
           ORDER BY unresolved.snapshot_id, unresolved.seq`,
  },
  { name: "verifications", sql: "SELECT * FROM verifications WHERE goal_id = ? ORDER BY id" },
  { name: "llm_calls", sql: "SELECT * FROM llm_calls WHERE goal_id = ? ORDER BY id" },
  { name: "decisions", sql: "SELECT * FROM decisions WHERE goal_id = ? ORDER BY id" },
];

/** 節・行・列の区切り。制御文字を使う（下の `encodeCell` が文字列側を必ず逃がす） */
const SECTION = "\u001d";
const ROW = "\u001e";
const CELL = "\u001f";

/**
 * 1行を決定的な文字列にする。
 *
 * 列名で並べ替えてから連結する。`SELECT *` の列順はスキーマの順で、`ALTER TABLE`
 * で足した列は末尾に付く。同じ中身の DB でも、作られ方（最初から在ったか
 * migrate で足したか）で順が変わりうるので、順に依存しない形にする。
 * 列名そのものも混ぜる。混ぜないと、値が隣の列へずれても同じ値になる。
 */
function encodeRow(row: Record<string, unknown>, skip: ReadonlySet<string>): string {
  return Object.keys(row)
    .filter((key) => !skip.has(key))
    .sort()
    .map((key) => `${key}=${encodeCell(row[key])}`)
    .join(CELL);
}

/**
 * 1つの値を決定的な文字列にする。型ごとに接頭辞を付けて、別の型の同じ見た目を
 * 混ぜない（`1` と `"1"` と `NULL` と `""` は別のもの）。
 *
 * 文字列は `JSON.stringify` に通す。上の区切り（`\u001d`〜`\u001f`）はすべて
 * 制御文字なので必ずエスケープされ、値の中身で区切りを偽装できない。
 *
 * 知らない型は throw する。黙って `String(value)` に落とすと、その列だけが
 * 実質的に射影から外れる。関門は throw を `guard_unavailable` に倒すので、
 * 「確かめられなかった」が「変わっていない」にはならない（design.md §3.1）。
 */
function encodeCell(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `s:${JSON.stringify(value)}`;
  }
  if (typeof value === "bigint") {
    // node:sqlite は 2^53 を越える INTEGER を bigint で返す。`JSON.stringify` は
    // bigint を渡されると throw するので、文字列側とは別に扱う。
    return `i:${value.toString()}`;
  }
  if (typeof value === "number") {
    return `d:${String(value)}`;
  }
  if (value instanceof Uint8Array) {
    return `b:${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error(`状態 DB のダイジェストに載せられない型の値がある: ${typeof value}`);
}

/** ロックが空くのを待つ上限（ミリ秒）。busy_timeout と WAL への切り替え待ちに使う */
const BUSY_TIMEOUT_MS = 5000;

/**
 * WAL への切り替えを待ち直す間隔（ミリ秒）。
 *
 * 揺らぎを混ぜる。同時に起動したプロセスは同じ瞬間に SQLITE_BUSY を受け取るので、
 * 固定間隔で待つと足並みが揃ったまま何度もぶつかりうる。
 */
const WAL_RETRY_BASE_MS = 10;
const WAL_RETRY_JITTER_MS = 30;

/** ロック待ちのあいだスレッドを止めるための領域。値は使わない */
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

/**
 * journal_mode を WAL にする。既に WAL なら SQLite 側で何も起きない。
 *
 * **ここだけ busy_timeout に任せられない。** rollback journal から WAL への変換は
 * データベース全体の排他ロックを要求するが、変換を試みる接続は既に共有ロックを
 * 持っている。SQLite は「共有ロックを持ったまま排他ロックへ昇格する」要求に対して、
 * 両者が待ち合うデッドロックを避けるため、busy handler を呼ばずにその場で
 * SQLITE_BUSY を返す（sqlite3_busy_handler の "could result in a deadlock" の項）。
 *
 * 実測でも、`.goals/.state/` を消した状態から4プロセスを同時に起動すると、
 * 落ちる側は **2ms** で throw していた。busy_timeout の 5000ms を1度も待っていない。
 * PRAGMA の並びを直しただけでは 100 プロセス中 2 が落ちたままだった。
 *
 * なので待つ側を自前で持つ。相手が変換を終えてしまえば、こちらの
 * `PRAGMA journal_mode = WAL` は既に WAL の DB に対する no-op になって通る。
 * WAL をやめて切り抜けることはしない（design.md §4.7）。
 *
 * 同期のまま待つ。openStore は同期で、Promise に変えると呼び出し側が全部
 * 非同期になる。`Atomics.wait` はイベントループを回さずにスレッドを止めるだけなので、
 * ロックを握っている**別プロセス**の進行は妨げない。
 */
function enableWal(db: DatabaseSync): void {
  let waited = 0;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      if (waited >= BUSY_TIMEOUT_MS) {
        // 待ち切っても通らないのは、開き合いの競合ではなく別の異常にあたる。
        // 握り潰すと WAL でない DB を黙って使い続けることになるので、投げる。
        throw error;
      }
      const delay = WAL_RETRY_BASE_MS + Math.floor(Math.random() * WAL_RETRY_JITTER_MS);
      Atomics.wait(SLEEPER, 0, 0, delay);
      waited += delay;
    }
  }
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

/**
 * SQLite の行をスキーマに通す。
 *
 * `node:sqlite` は行を `any` 相当で返すので、これまでは `as unknown as XRow[]` で
 * 名乗らせていた。列挙の列だけは後段で zod にかけていたが、素の string / number は
 * 素通りしていた。列名を1つ変えると——`log_ref` を `log_path` にする、のような——
 * `z.string().min(1)` と宣言されたフィールドに `undefined` が入ったまま外へ出る。
 * tsc も実行時も何も言わない。DB のスキーマ（SCHEMA）と手書きの型が別々の
 * 真実源になっていたのが原因なので、型をスキーマから導いて突き合わせる。
 *
 * 落ちたら throw する。読めなかった行を黙って捨てると、Fact が1件消えたことに
 * 誰も気づけない（design.md §3.1）。
 */
function parseRows<S extends z.ZodType>(schema: S, raw: unknown, source: string): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: DB の行が想定と違う: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * `runs.artifacts` の JSON を、文字列の配列として読む。
 *
 * `runRowSchema` は `artifacts: z.string()` までしか見ない。列の名前と型は
 * それで止まるが、JSON の**中身**は素通りしていた。読む側が
 * `JSON.parse(row.artifacts) as string[]` だったので、パースした結果は誰も
 * 見ておらず、オブジェクトでも数値の配列でもそのまま外へ出る。
 * `as` を挟んだ場所は実行時に何も検査しない、というのが元の問題（tests/store-rows.test.ts）
 * なので、列の名前で止まって中身で止まらないなら直りきっていない。
 *
 * 効き先は関門になる。`Run.artifacts` は Agent が編集したパスの一覧で、
 * controller の `guardedDecision` が `findViolations` に渡す入力の1つにあたる。
 * 文字列でないものが混ざると、`resolve()` が投げるか、文字列化された別物を
 * 照合することになる。関門の入力は、関門の一部になる。
 *
 * 宣言（`Run.artifacts`）をそのまま検査に使う。ここで `z.array(z.string())` と
 * 書き写すと、宣言と読み方がまた別々の真実源になる。
 *
 * 落ちたら throw する。読めなかった行を黙って捨てると、Agent が触ったパスが
 * 消えたことに誰も気づけない（design.md §3.1）。DB のスキーマ（SCHEMA）は
 * TEXT のままで、migration は要らない。
 */
function parseArtifacts(raw: string, source: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source}: DB の行が想定と違う: artifacts が JSON として読めない: ${errorMessage(error)}`,
    );
  }

  const parsed = runSchema.shape.artifacts.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`${source}: DB の行が想定と違う: artifacts: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 1行版。行が無ければ undefined */
function parseRow<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  source: string,
): z.infer<S> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: DB の行が想定と違う: ${parsed.error.message}`);
  }
  return parsed.data;
}

const snapshotHeadSchema = z.object({ id: z.number(), observed_at: z.string() });
const digestRowSchema = z.object({ observed_digest: z.string() });

const goalRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  lease_owner: z.string().nullable(),
  lease_until: z.string().nullable(),
  resume_after: z.string().nullable(),
  activated_at: z.string().nullable(),
  reconciles: z.number(),
  pr_number: z.number().nullable(),
  issue_number: z.number().nullable(),
  // migrate() が後から足した列。古い DB を開いた直後は NULL になる。
  abandon_reason: z.string().nullable(),
  guard_base_sha: z.string().nullable(),
});

const goalListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  reconciles: z.number(),
  pr_number: z.number().nullable(),
  resume_after: z.string().nullable(),
});

const factRowSchema = z.object({
  key: z.string(),
  value: z.string(),
  observed_at: z.string(),
  confidence: z.string(),
  evidence_source: z.string().nullable(),
  evidence_detail: z.string().nullable(),
});
type FactRow = z.infer<typeof factRowSchema>;

const unresolvedRowSchema = z.object({
  key: z.string(),
  reason: z.string(),
  detail: z.string(),
});

const decisionRowSchema = z.object({
  action: z.string(),
  rationale: z.string(),
  decided_by: z.string(),
  decided_at: z.string(),
});

const verificationRowSchema = z.object({
  criterion_id: z.string(),
  result: z.string(),
  reason: z.string().nullable(),
  evidence_source: z.string().nullable(),
  evidence_detail: z.string().nullable(),
  detail: z.string(),
  verified_at: z.string(),
});

const llmCallRowSchema = z.object({
  purpose: z.string(),
  tokens: z.number(),
  log_ref: z.string(),
  ok: z.number(),
  called_at: z.string(),
});

const runRowSchema = z.object({
  id: z.number(),
  intent: z.string(),
  actor: z.string(),
  /** role を足す前に書かれた行には無い。読む側で実装役に倒す */
  role: z.string().nullable(),
  worktree: z.string(),
  attempt: z.number(),
  status: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  exit_code: z.number().nullable(),
  log_ref: z.string().nullable(),
  tokens: z.number().nullable(),
  artifacts: z.string(),
  detail: z.string().nullable(),
  error_kind: portErrorKindSchema.nullable(),
  actor_resume_after: z.string().nullable(),
});

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
  issue_number  INTEGER,
  -- 人間が「もう追わない」と宣言した理由。ABANDONED でなければ NULL。
  -- 既にある DB には migrate() が足す。
  abandon_reason TEXT,
  -- 関門が差分を取る相手。start した時点の repoRoot の HEAD（GoalState を参照）。
  -- 既にある DB には migrate() が足す。
  guard_base_sha TEXT
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
  role        TEXT NOT NULL DEFAULT 'implement',
  worktree    TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  exit_code   INTEGER,
  log_ref     TEXT,
  tokens      INTEGER,
  artifacts   TEXT NOT NULL,
  detail      TEXT,
  error_kind  TEXT,
  actor_resume_after TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_goal ON snapshots(goal_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_goal_status ON runs(goal_id, status);
CREATE INDEX IF NOT EXISTS idx_verifications_goal ON verifications(goal_id, reconcile_seq);
`;

/**
 * 既にあるテーブルに、あとから足した列を付ける。
 *
 * `CREATE TABLE IF NOT EXISTS` は、テーブルが既にあれば列の差を埋めない。
 * 自己ホストの goals.db は Phase 2 から動き続けているので、新しい列は
 * ここで足さないと `INSERT` が落ちる。
 *
 * 既定値は実装役にする。role を持たなかった頃の Run は、作業ツリーが
 * 1つしか無かった時期のもので、すべて実装役として走っている。
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as unknown as { name: string }[];
  if (!columns.some((column) => column.name === "role")) {
    // 埋め込むのは自前の定数だけ。外から来た値は入らない。
    db.exec(`ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT '${DEFAULT_ACTOR_ROLE}'`);
  }
  if (!columns.some((column) => column.name === "error_kind")) {
    db.exec("ALTER TABLE runs ADD COLUMN error_kind TEXT");
  }
  if (!columns.some((column) => column.name === "actor_resume_after")) {
    db.exec("ALTER TABLE runs ADD COLUMN actor_resume_after TEXT");
  }

  // 人間が「もう追わない」と宣言した理由（`ent abandon --reason`）。
  // 既定は NULL にする。ABANDONED でない Goal に理由は無く、空文字を既定に
  // すると「理由を書かずに降りた」と「そもそも降りていない」が同じ形になる。
  const goalColumns = db.prepare("PRAGMA table_info(goals)").all() as unknown as { name: string }[];
  if (!goalColumns.some((column) => column.name === "abandon_reason")) {
    db.exec("ALTER TABLE goals ADD COLUMN abandon_reason TEXT");
  }

  // 関門が差分を取る相手（`GoalState.guardBaseSha`）。既定は NULL にする。
  // 走行中の Goal に後から sha を当てると、それまで default_branch と比べて
  // 通っていた差分が別の基準で並び直す。読む側が null を default_branch に
  // 落とすことで、この列より前に start した Goal は挙動が変わらない。
  if (!goalColumns.some((column) => column.name === "guard_base_sha")) {
    db.exec("ALTER TABLE goals ADD COLUMN guard_base_sha TEXT");
  }
}
