import { describe, expect, it } from "vitest";
import { findViolations } from "../src/domain/protected-paths.js";

/**
 * 関門が守るのは Goal の宣言部であって、controller が書く実行時状態ではない。
 *
 * `.goals/**` は `.goals/*.yaml`——人間が書く宣言部——を守るために書かれている。
 * ところがこのパターンは worktree の中の `.goals/.state/**` にも一致する。
 * Agent が自分の作業ツリーの中に一時ファイルを1つ置いただけで
 * `ESCALATE(protected_path_touched)` になり、Goal が WAITING_HUMAN で止まる。
 *
 * 実際に起きた。`validate-what-crosses-the-boundary` の1ティック目で、Actor が
 * `<worktree>/.goals/.state/tmp-readcheck/read.ts` を作って消した。関門は
 * `Run.artifacts`（Agent の自己申告）に残っていたそのパスを拾って停止した。
 * **止まった時点でファイルはもう存在しない。** `protected_path_touched` は
 * 「人間が片付けるのを待っている」停止（SKILL.md）なのに、片付けるものが無い。
 *
 * 関門が鳴るべきでない場面で鳴ると、関門そのものが信用されなくなる。
 * `src/domain/protected-paths.ts` が既に「判定できないものは違反にしない。
 * 捏造した違反で人間を呼ぶと、関門そのものが信用されなくなる」と書いている
 * のと同じ理由になる。
 *
 * 除外してよい根拠は3つある。
 *
 * 1. `.goals/.state/` は controller が書く実行時状態で、gitignore 済み。
 *    `.goals/*.yaml` とは別物で、design.md §4.6 が「宣言部だけを Git 管理する」
 *    として分けている当のもの
 * 2. worktree の中の `.goals/.state/` は、**本体の state dir ですらない**。
 *    goals.db も Run のログも本体リポジトリ側にある
 * 3. 本体側の state dir への書き込みは worktree の外なので、
 *    `escaped_worktree` として先に捕まる。判定の順序は変わらない
 *
 * 外すのは `.goals/.state/` の下だけにする。`.goals/` 直下も、
 * `.goals/` の他のサブディレクトリも、これまでどおり保護する。
 *
 * **根拠3には穴があった。** 「worktree の外なので `..` から始まる」が成り立つのは
 * 絶対パスで来るものだけで、本体側の観測は `.goals/.state/goals.db` を
 * repoRoot 相対の**文字列**で返す（人間が読める形で残すため）。脱出の判定に
 * 引っかからず、そのままこの除外に落ちていた。goals.db を偽造されても関門が
 * 鳴らない、という形になる。除外を掛けてよいかは文字列ではなく出どころで決める。
 * 下の「本体リポジトリ側を出どころとするパス」を参照。
 */

const ROOT = "/tmp/entelecheia/worktrees/sample-goal";
const PROTECTED = ["src/controller/**", ".goals/**"];

describe("worktree の中の .goals/.state/ は違反にしない", () => {
  it("Agent が置いた一時ファイルで止まらない", () => {
    // 実際に踏んだパス。ティックが止まった時点で、このファイルは存在しない。
    expect(
      findViolations([`${ROOT}/.goals/.state/tmp-readcheck/read.ts`], ROOT, PROTECTED),
    ).toEqual([]);
  });

  it("何段深くても違反にしない", () => {
    expect(
      findViolations([`${ROOT}/.goals/.state/runs/run-1/logs/a/b/c.txt`], ROOT, PROTECTED),
    ).toEqual([]);
  });

  it(".goals/.state 直下のファイルも違反にしない", () => {
    expect(findViolations([`${ROOT}/.goals/.state/goals.db`], ROOT, PROTECTED)).toEqual([]);
  });

  it("相対パスで渡されても同じ", () => {
    // artifacts は絶対パスで来るが、changedPaths は worktree からの相対で来る。
    expect(findViolations([".goals/.state/tmp/x.ts"], ROOT, PROTECTED)).toEqual([]);
  });

  it("ディレクトリ自身も違反にしない", () => {
    expect(findViolations([`${ROOT}/.goals/.state`], ROOT, PROTECTED)).toEqual([]);
  });
});

describe("宣言部の保護は弱めない", () => {
  it(".goals/*.yaml はこれまでどおり違反", () => {
    const violations = findViolations([`${ROOT}/.goals/sample-goal.yaml`], ROOT, PROTECTED);

    expect(violations).toEqual([
      { kind: "protected_path", path: `${ROOT}/.goals/sample-goal.yaml`, pattern: ".goals/**" },
    ]);
  });

  it(".goals/ の他のサブディレクトリは違反のまま", () => {
    // 外すのは .state/ の下だけ。`.goals/` の下を丸ごと開けない。
    expect(findViolations([`${ROOT}/.goals/archive/old.yaml`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it("ドットの無い .goals/state/ は違反のまま", () => {
    // 実行時状態の置き場は `.state`。名前が似ているだけのものを通さない。
    expect(findViolations([`${ROOT}/.goals/state/x.yaml`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it("前方一致でごまかせない", () => {
    // `.goals/.stateful.yaml` は `.goals/.state/` の下ではない。
    // パスの区切りで判定しないと、名前を寄せるだけで宣言部を編集できる。
    expect(findViolations([`${ROOT}/.goals/.stateful.yaml`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it(".goals/.state という名前のファイルは違反のまま", () => {
    // ディレクトリではなくファイルとして置かれた場合。`.goals/**` の対象になる。
    // 「.state という名前ならすべて通す」にすると、ここが抜け道になる。
    expect(findViolations([`${ROOT}/.goals/.state.yaml`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it("除外は .goals/** に紐づく。他のパターンには効かない", () => {
    // `src/controller/.goals/.state/x.ts` のような場所まで通さない。
    // 除外の基点は worktree の直下にある `.goals/.state/` だけになる。
    expect(
      findViolations([`${ROOT}/src/controller/.goals/.state/x.ts`], ROOT, PROTECTED),
    ).toHaveLength(1);
  });
});

describe("隔離の検知は弱めない", () => {
  it("worktree の外の .goals/.state/ は escaped_worktree のまま", () => {
    // 本体リポジトリ側の state dir。ここへの書き込みは隔離が破れたということで、
    // 保護パスの照合より先に判定される。除外を足してもこの順序は変わらない。
    const violations = findViolations(
      ["/repo/entelecheia/.goals/.state/goals.db"],
      ROOT,
      PROTECTED,
    );

    expect(violations[0]?.kind).toBe("escaped_worktree");
  });

  it("worktree の外は保護パスの指定が無くても違反にする", () => {
    expect(findViolations([`${ROOT}/../other/.goals/.state/x.db`], ROOT, [])).toHaveLength(1);
  });

  it("`..` で worktree の外の .goals/.state/ を指しても通さない", () => {
    expect(findViolations([`${ROOT}/.goals/.state/../../../etc/hosts`], ROOT, PROTECTED)).toEqual([
      { kind: "escaped_worktree", path: `${ROOT}/.goals/.state/../../../etc/hosts`, pattern: null },
    ]);
  });
});

describe("本体リポジトリ側を出どころとするパスには、除外を掛けない", () => {
  // 本体側の観測が返すキーは repoRoot 相対の表示用パスで、worktree の中の同名パスと
  // 文字列では見分けが付かない。出どころを渡して判定を分ける。状態 DB のキーは
  // controller が置く（`observedRepoState`）が、値の作り方が変わっても
  // **このキーが `.goals/**` に一致し続けること**がここで固定される。
  it("repoRoot 相対で来た goals.db の改竄を違反にする", () => {
    const violations = findViolations([".goals/.state/goals.db"], ROOT, PROTECTED, "repo_root");

    expect(violations).toEqual([
      { kind: "protected_path", path: ".goals/.state/goals.db", pattern: ".goals/**" },
    ]);
  });

  it("同じ文字列でも worktree 側なら、これまでどおり違反にしない", () => {
    // 除外そのものは残す。Agent が自分の作業ツリーに一時ファイルを置いても
    // 止まらない、という上の性質を弱めない。
    expect(findViolations([".goals/.state/goals.db"], ROOT, PROTECTED)).toEqual([]);
  });

  it("hooks の書き換えはこれまでどおり違反", () => {
    // 除外に落ちていなかった側。出どころを分けても判定は変わらない。
    expect(findViolations([".git/hooks/pre-push"], ROOT, [".git/**"], "repo_root")).toHaveLength(1);
  });

  it("本体側の絶対パスは escaped_worktree のまま", () => {
    // `repoDirtyState` は絶対パスを返す。脱出の判定が先に立つ順序は変えない。
    const violations = findViolations(
      ["/repo/entelecheia/README.md"],
      ROOT,
      PROTECTED,
      "repo_root",
    );

    expect(violations[0]?.kind).toBe("escaped_worktree");
  });
});

describe("他の保護パスは変わらない", () => {
  it("src/controller/** はこれまでどおり違反", () => {
    expect(findViolations([`${ROOT}/src/controller/index.ts`], ROOT, PROTECTED)).toHaveLength(1);
  });

  it("`.goals/**` を指定していなければ、そもそも何も起きない", () => {
    // 除外は `.goals/**` を書いた Goal の話。書いていない Goal の判定は変わらない。
    expect(
      findViolations([`${ROOT}/.goals/sample-goal.yaml`], ROOT, ["src/controller/**"]),
    ).toEqual([]);
  });

  it("複数の違反はこれまでどおり全て返す", () => {
    const violations = findViolations(
      [
        `${ROOT}/src/controller/index.ts`,
        `${ROOT}/.goals/x.yaml`,
        `${ROOT}/.goals/.state/tmp/y.ts`,
        `${ROOT}/src/cli.ts`,
      ],
      ROOT,
      PROTECTED,
    );

    expect(violations.map((v) => v.path)).toEqual([
      `${ROOT}/src/controller/index.ts`,
      `${ROOT}/.goals/x.yaml`,
    ]);
  });
});
