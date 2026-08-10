#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentContextPayload } from "./cli/agent-context.js";
import { type Command, parseCommand, USAGE } from "./cli/parse.js";
import {
  type ReportRecord,
  reportPayload,
  reportSink,
  summarize,
  writeTruncationHint,
} from "./cli/present.js";
import { type TickResult, tick } from "./controller/index.js";
import { errorMessage } from "./domain/error-message.js";
import type { Goal } from "./domain/goal.js";
import { isTerminal } from "./domain/goal-state.js";
import type { Store } from "./store/port.js";
import { doctorPayload } from "./usecase/doctor.js";
import { initRepository } from "./usecase/init.js";
import { listPayload, showPayload } from "./usecase/inspect.js";
import {
  doctorProbes,
  initProbes,
  loadGoalFile,
  openStore,
  repoHeadSha,
  tickPorts,
} from "./wiring/index.js";

/**
 * `ent` コマンドの入口。常駐しない（design.md §3.6）。
 *
 * ここが持つのは**サブコマンドごとの手順**だけにする。引数の解釈は
 * `src/cli/parse.ts`、出力の整形は `src/cli/present.ts`、それぞれのコマンドの
 * 中身は `src/usecase/**`、どの Adapter を挿すかは `src/wiring/index.ts` にある。
 *
 * 1ファイルに 1,779 行あった頃は、この4つが同じ場所に積まれていた。増えた理由は
 * 書き方ではなく、`src/adapters/**` を import してよいのがここだけだったこと
 * （design.md §3.3）。合成ルートを外に出したので、分ける先が自明になった。
 *
 * **外から読む口はこのファイルに集める。** テストと `tests/docs-contract.test.ts` が
 * ここを import しているので、内部の置き場が動いても呼ぶ側は変わらない。
 */
export { agentContextPayload } from "./cli/agent-context.js";
export { type Command, parseCommand, type ReportTarget } from "./cli/parse.js";
export { type ReportRecord, reportSink } from "./cli/present.js";
export { type DoctorProbes, type DoctorReport, doctorPayload } from "./usecase/doctor.js";
export {
  type LimitOptions,
  listPayload,
  type ShowPayload,
  showPayload,
  truncationHint,
} from "./usecase/inspect.js";

/**
 * CLI の入口。終了コードの契約はここで閉じる。
 *
 * GITHUB_TOKEN が無ければ、GitHub の Port は PortError(unavailable) を投げる。
 * observe がそれを握って unobserved に落とすので、ティック自体は最後まで回り、
 * 状態が DB に残る。捏造した観測は作らない。
 *
 * 以前は throw がそのまま呼び出し元へ抜け、1 を返していたのはモジュール末尾の
 * エントリだった。`agent-context` が「終了コードはこれが正」と宣言しているのに、
 * `main()` を呼ぶ側からは 1 を観測できず、テストも書けなかった。実際
 * 「Goal YAML が無い」は 1 と文書化されているのに、`main()` は throw していた。
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "error") {
    process.stderr.write(`${command.message}\n\n${USAGE}`);
    return 2;
  }
  if (command.kind === "agent-context") {
    // CLI の構造を出すだけなので、Goal も DB も読まない。
    process.stdout.write(`${JSON.stringify(agentContextPayload(), null, 2)}\n`);
    return 0;
  }

  const repoRoot = process.cwd();
  const stateDir = join(repoRoot, ".goals", ".state");

  if (command.kind === "init") {
    // Goal も DB も読まない。読める状態を作るのがこのコマンドなので、
    // 読めないことを理由に落とすと最初の1回が通らない。
    return initRepository(repoRoot, command.json === true, initProbes());
  }

  if (command.kind === "doctor") {
    // 読み取り専用にする。state ディレクトリを作るのも書き込みなので、
    // mkdirSync より前に返す。doctor は調べるだけで、直さない。
    const report = await doctorPayload(doctorProbes(repoRoot, stateDir));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }

  // --dry-run は覗くだけ。state ディレクトリを作るのも DB を作るのも書き込みなので、
  // ここより前に返す。SKILL.md は「Actor の起動と PR への書き込みは起きない。
  // snapshot / verifications / decision / status も書かない」と書いている。
  if (command.kind === "run" && command.dryRun === true) {
    return previewOnly(command, repoRoot, stateDir);
  }

  mkdirSync(join(stateDir, "worktrees"), { recursive: true });

  if (command.kind === "list") {
    // list は slug を取らない。Goal YAML を読まずに DB だけ見る。
    const store = openStore(join(stateDir, "goals.db"));
    try {
      const items = listPayload(store, { limit: command.limit });
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      writeTruncationHint(items.length, store.listGoals().length);
      return 0;
    } finally {
      store.close();
    }
  }

  const goal = loadGoalFile(join(repoRoot, ".goals", `${command.slug}.yaml`));
  const store = openStore(join(stateDir, "goals.db"));

  try {
    // run は登録済みの Goal だけを進める。upsert より先に見る。
    //
    // design.md は「Goal YAML のレビューがそのまま承認ゲートを担うので、
    // ent start は DRAFT から ACTIVE に直行する」と書いている。ここで先に
    // upsert していたので tick 側の「Goal が登録されていない」は本番で到達せず、
    // start を挟まない run が Actor を起動して予算を使い、1ティックで
    // DRAFT から COMPLETED まで進めた。唯一の承認ゲートが飛ばせていた。
    if (command.kind === "run" && store.getState(goal.goal.id) === null) {
      process.stderr.write(
        `${goal.goal.id} は登録されていない。先に ent start ${goal.goal.id} を叩くこと\n`,
      );
      process.stdout.write(`${JSON.stringify(summarize(draftIdle()), null, 2)}\n`);
      return 0;
    }

    // abandon は upsert より先に片付ける。降りるのは実行時状態の話で、宣言部を
    // 読み直す必要が無い。upsert を通すと未登録の Goal に DRAFT の行ができ、
    // 「一度も動いていないのに放棄済み」という読めない記録を作れてしまう。
    if (command.kind === "abandon") {
      return abandonGoal(command, goal, store);
    }

    store.upsertGoal(goal);

    if (command.kind === "start") {
      // 終端の Goal を黙って ACTIVE に戻さない。nextStatus と tick は終端を
      // 守るのに、この経路だけ素通りしていた。COMPLETED を後から取り消せると、
      // §9 の完了判定そのものが意味を失う。
      const current = store.getState(goal.goal.id);
      if (current !== null && isTerminal(current.status)) {
        process.stderr.write(
          `${goal.goal.id} は ${current.status} なので start できない。` +
            "やり直すなら .goals/.state/goals.db の状態を明示的に戻すこと\n",
        );
        // 2 ではなく 1 を返す。2 は「引数が不正」で、SKILL.md はそこに
        // 「stderr に有効値が並ぶ」と書いている。argv は妥当で打ち直せる値も
        // 無いので、2 を返すとエージェントが argv を変えて無限に再試行する。
        // 実行できない状態は 1 にあたる。
        return 1;
      }

      const now = new Date().toISOString();
      store.setStatus(goal.goal.id, "ACTIVE", null, now);

      // 関門が差分を取る相手を、ここで1回だけ固定する（`GoalState.guardBaseSha`）。
      //
      // 読むのは呼び出し側の HEAD で、`repository.default_branch` ではない。
      // 人間はこの commit の上に Goal の宣言と仕様を書いており、Actor が書くのは
      // その先になる。default_branch を基準にすると、人間が書いた分まで
      // Actor の編集として関門に並ぶ。
      //
      // **書くのは、まだ worktree が無い Goal に対してだけ。** 条件を
      // 「記録がまだ無い」だけにすると、この列より前に start して既に走っている
      // Goal（worktree は default_branch から切られている）に基準だけを今の HEAD で
      // 与えてしまう。そうなると「切った元」と「比べる相手」がずれ、切った元に
      // 無いものを「Actor が書いた」と読む。Run が1件でもあれば worktree はある。
      //
      // 記録できなかったら黙って進めず、何が起きるかを stderr に出す。start 自体は
      // 止めない。関門は null を default_branch に落とすので、これまでどおり動く。
      try {
        const started = store.listRuns(goal.goal.id).length > 0;
        if (current?.guardBaseSha == null && !started) {
          store.setGuardBase(goal.goal.id, await repoHeadSha(repoRoot));
        }
      } catch (error) {
        process.stderr.write(
          `関門の基準にする HEAD を読めなかったので、${goal.repository.default_branch} を基準にする` +
            `（人間が書いた分も Actor の編集として並ぶ）: ${errorMessage(error)}\n`,
        );
      }
      // --json を渡さないときの出力は変えない。cron と既存の呼び出しが読んでいる。
      process.stdout.write(
        command.json === true
          ? `${JSON.stringify({ id: goal.goal.id, status: "ACTIVE" }, null, 2)}\n`
          : `${goal.goal.id}: ACTIVE\n`,
      );
      return 0;
    }

    if (command.kind === "show") {
      const payload = showPayload(goal, store, { limit: command.limit });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      writeTruncationHint(payload.runs.length, store.listRuns(goal.goal.id).length);
      return 0;
    }

    // 観測対象。指定があったものだけ書き換え、指定が無い方は前回の値を保つ。
    // 片方だけ渡したときにもう片方が消えると、次のティックが観測をやめる。
    if (command.prNumber !== undefined || command.issueNumber !== undefined) {
      const current = store.getState(goal.goal.id);
      store.setObserveTarget(
        goal.goal.id,
        command.prNumber ?? current?.prNumber ?? null,
        command.issueNumber ?? current?.issueNumber ?? null,
      );
    }

    // SIGTERM を受けたら走行中の Actor に伝播する。Ctrl+C が効かない状態を作らない。
    const aborter = new AbortController();
    const stop = (): void => aborter.abort();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    // 進捗の宛先。指定が無ければ publish は従来どおり PR コメントに書く。
    const record: ReportRecord = { body: null, error: null };
    const report = command.report === undefined ? undefined : reportSink(command.report, record);

    const result = await tick(goal, {
      ...tickPorts(goal, store, repoRoot, stateDir),
      store,
      signal: aborter.signal,
      report,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ...summarize(result),
          ...(command.report === undefined
            ? {}
            : { report: reportPayload(command.report, record) }),
        },
        null,
        2,
      )}\n`,
    );
    if (record.error !== null) {
      // 終了コードは変えない。通知の失敗でティックの成否を塗り替えない
      // （design.md §9）。ただし黙らない。stdout は JSON 専用なので stderr に出す。
      process.stderr.write(`進捗を書けなかった: ${record.error}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * 「もう追わない」と宣言して終端にする。
 *
 * 満たすべき性質:
 * - 書けるのは status（ABANDONED）と理由だけ。観測の履歴には触らない。
 *   snapshots / facts / verifications は「最後のティックが何を見たか」の記録で、
 *   書き換えるのは観測の捏造になる（design.md §3.1）
 * - 落とせない場合は何も書かずに 1 を返す。部分的に書いて失敗しない
 * - 完了は名乗らせない。ここから書ける終端は ABANDONED だけで、対になる
 *   `complete` は用意しない
 *
 * `upsertGoal` を通さずに呼ぶ。降りるのは実行時状態の話なので宣言部を書き直す
 * 理由が無く、通すと未登録の Goal に DRAFT の行ができてしまう。
 */
function abandonGoal(
  command: { slug: string; reason: string; json?: true },
  goal: Goal,
  store: Store,
): number {
  const current = store.getState(goal.goal.id);

  // 回したことのない Goal を終端にすると、「一度も動いていないのに放棄済み」
  // という読めない記録ができる。
  if (current === null) {
    process.stderr.write(
      `${goal.goal.id} は登録されていない。降りる先の状態が無い（ent start から始める）\n`,
    );
    return 1;
  }

  // 終端から別の終端へ移さない。design.md §4.4 は「終端の Goal を ACTIVE に
  // 戻さない。COMPLETED を後から取り消せると、完了判定そのものが意味を失う」と
  // 書いている。COMPLETED を ABANDONED で塗り替えられるなら、同じことになる。
  if (isTerminal(current.status)) {
    process.stderr.write(
      `${goal.goal.id} は既に ${current.status} なので abandon できない。終端は塗り替えない\n`,
    );
    return 1;
  }

  // lease を持っているなら、別のプロセスがそのティックを回している。
  // 横から終端へ落とすと、走っている controller が終端の Goal に書き戻す。
  if (current.leaseOwner !== null) {
    process.stderr.write(
      `${goal.goal.id} は ${current.leaseOwner} が回している。` +
        "終わるのを待つか、lease が切れてから叩くこと\n",
    );
    return 1;
  }

  store.abandon(goal.goal.id, command.reason);
  process.stdout.write(
    command.json === true
      ? `${JSON.stringify({ id: goal.goal.id, status: "ABANDONED", reason: command.reason }, null, 2)}\n`
      : `${goal.goal.id}: ABANDONED（${command.reason}）\n`,
  );
  return 0;
}

/**
 * 登録されていない Goal に対して返すティック結果。
 *
 * `tick()` が state を読めなかったときに返すものと同じ形にする。DB を作らずに
 * 同じことを言う必要があるので、ここで組み立てる。
 */
function draftIdle(): TickResult {
  return {
    ran: false,
    skipped: "Goal が登録されていない",
    reclaimed: 0,
    decision: null,
    run: null,
    status: "DRAFT",
  };
}

/**
 * `ent run <slug> --dry-run` の本体。何も書かずに次のティックの中身だけを出す。
 *
 * 通常の経路と分けてあるのは、書き込みが tick() より前に3つあったため。
 * state ディレクトリの作成・DB を開くこと（無ければ作られる）・upsertGoal と
 * setObserveTarget がそれにあたる。とくに setObserveTarget は、覗いたつもりの
 * `--dry-run --pr 42` が観測先を恒久的に差し替え、次の本番ティックが違う PR を
 * 見る状態を作っていた。`--pr` / `--issue` は永続化せず、この1回にだけ効かせる。
 */
async function previewOnly(
  command: Extract<Command, { kind: "run" }>,
  repoRoot: string,
  stateDir: string,
): Promise<number> {
  const goal = loadGoalFile(join(repoRoot, ".goals", `${command.slug}.yaml`));
  const dbPath = join(stateDir, "goals.db");

  if (!existsSync(dbPath)) {
    // DB を開くと作られる。作るのも書き込みなので、その前に返す。
    process.stdout.write(
      `${JSON.stringify(summarize({ ...draftIdle(), dryRun: true }), null, 2)}\n`,
    );
    return 0;
  }

  const store = openStore(dbPath);
  try {
    const result = await tick(goal, {
      ...tickPorts(goal, store, repoRoot, stateDir),
      store,
      dryRun: true,
      observeOverride: {
        ...(command.prNumber === undefined ? {} : { prNumber: command.prNumber }),
        ...(command.issueNumber === undefined ? {} : { issueNumber: command.issueNumber }),
      },
    });

    process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // main() が終了コードの契約を閉じているので、ここでは受け取るだけにする。
  // reject しないことは main() 側の try/catch が保証している。
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
