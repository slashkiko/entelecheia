import type { AcceptanceCriterion } from "../domain/goal.js";
import type { CommandRunnerPort } from "../verify/index.js";
import { alreadyDone } from "./plan.js";

/**
 * `ent start` の着手検査。**やることが残っていない Goal を ACTIVE にしない。**
 *
 * `ent plan` は「宣言時点で `type: command` の criteria が全部通る提案」を書かずに
 * 落とす（`alreadyDone`）。理由は、Gap が無ければ DECIDE は COMPLETE を選ぶので
 * （`src/decide/index.ts`）、そのまま `ent start` すると何もせず1ティック目で完了
 * 扱いになること。**ここが受け持つのは、その判定を通っていない Goal になる。**
 * 手で書いた Goal と、`ent plan` が書いたあとに人間が criteria を足した Goal が
 * それにあたる。
 *
 * ここは「テストを先に書く」を機械で確かめられる唯一の形でもある。順序そのものは
 * criteria に還元できない（design.md §3.2）が、「着手時点で落ちる criterion が
 * ある」は状態なので確かめられる。
 *
 * 判定そのものは `alreadyDone` を呼ぶ。plan 側の挙動は変えない。
 */

/** 着手検査が外に触る口。合成ルートが実装を挿す（`src/wiring/index.ts`） */
export interface StartProbes {
  /**
   * `type: command` の criterion を1本ずつ実行する口。
   *
   * **基点は呼び出し側のチェックアウト（repoRoot）になる。** 判定したいのは
   * 「いま人間が見ているチェックアウトで、その criterion がもう通るのか」で、
   * worktree はまだ1つも無い（`PlanProbes.criterionProbe` と同じ立場）。
   */
  criterionProbe: CommandRunnerPort;
}

/**
 * その Goal に着手できるか。**できるなら null、できないなら断る理由を返す。**
 *
 * 断るのは「`type: command` の criterion が1本以上あり、その全部が通った」ときだけに
 * する。積極的な証拠が揃ったときだけ断る形にしておかないと、`--force` を持たない
 * この入口では、誤って断られた Goal に宣言を書き換える以外の逃げ道が無い。
 *
 * - **`type: fact` と `type: human` は数えない。** 前者は OBSERVE の結果が要り、
 *   後者は VERIFY ですら pending を返す（`src/verify/index.ts`）。数えると、
 *   fact と human だけで書かれた Goal が「全部通っている」と誤判定されて止まる
 * - **`type: command` が1本も無い Goal は通す。** 空集合を「全部通った」と読むのが
 *   その誤判定そのものになる。controller の commit も同じ読み方をしていて、
 *   `machineCriteriaSatisfied`（`src/domain/guard-rules.ts`）は空集合に false を
 *   返す。あちらが断るのは commit で、こちらが断るのは着手だが、**空集合を
 *   「満たされている」と読まない**点で揃う。そういう Goal が書き残しを抱えたまま
 *   進めば、未 commit の関門が `ESCALATE(uncommitted_changes)` で拾って人間を呼ぶ
 * - **実行できなかったコマンドも「通った」に数えない。** 起動に失敗した criterion は
 *   `alreadyDone` が `unknown` にする（design.md §3.1 の「観測できなかったものは
 *   Fact にしない」と同じ分け方）
 *
 * **`setup` は流さない。** 流す口を持つのは VERIFY で、こちらは criteria を1本ずつ
 * 走らせるだけになる。依存を入れていないチェックアウトでは criterion が起動に失敗
 * するが、その失敗は `unknown` として着手を通す側に倒れるので、人間が止められる
 * ことはない。
 */
export async function nothingToDo(
  id: string,
  criteria: readonly AcceptanceCriterion[],
  probes: StartProbes,
): Promise<string | null> {
  const machine = criteria.filter((criterion) => criterion.verification.type === "command");
  if (machine.length === 0) {
    return null;
  }

  // 何を待っているのかを、走らせる前に出す。criterion のコマンドは検証一式で
  // あることが多く、20秒前後かかる。`ent start` は人間が対話的に叩くコマンドなので、
  // 黙って止まっているように見せない。**stdout には書かない。** あそこは
  // `--json` の1本だけを流す口で、混ぜると読む側の JSON が壊れる。
  process.stderr.write(
    `Checking ${machine.length} type: command criteria of ${id} before starting it. ` +
      "This takes as long as the commands do\n",
  );

  const announced: CommandRunnerPort = {
    run: async (command) => {
      process.stderr.write(`  ${command}\n`);
      return probes.criterionProbe.run(command);
    },
  };

  const done = await alreadyDone([{ id, acceptance_criteria: criteria }], announced, new Map());
  if (done.length === 0) {
    return null;
  }

  // 通ってしまった criterion を名指しする。断られた側が次に読むのはこの id で、
  // 「どれを書き直せば着手できるのか」がそこで決まる。
  const passing = machine.map((criterion) => criterion.id).join(", ");
  return (
    `${id} has nothing to do: every type: command criterion already passes in this checkout ` +
    `(${passing}). ent would reach COMPLETE on the first tick without changing anything, and ` +
    "COMPLETED is terminal, so ent start cannot take it back. Replace those criteria with " +
    "commands that fail until the work is actually done, then start it again"
  );
}
