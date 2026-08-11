import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  APPROVAL_GATE_FLOOR,
  goalSchema,
  goalTemplate,
  PROTECTED_PATH_FLOOR,
  TEMPLATE_SLUG,
  withApprovalGateFloor,
  withProtectedPathFloor,
} from "../src/domain/goal.js";

/**
 * 保護パスの下限が、どの Goal からも外せないことを固定する。
 *
 * `protected_paths` は既定が空で、Goal ごとに人間が書く。実際に
 * `agent-friendly-cli` は `.goals/**` だけを、`commit-what-the-actor-wrote` は
 * `src/controller/**` を外した残りだけを保護した状態でマージされている。
 * その間 Actor は、自分の拒否ツール一覧（src/adapters/claude.ts）も関門の
 * マッチャ（src/domain/protected-paths.ts）も、検知されずに編集できた。
 *
 * 「関門の適用範囲を Goal が決める」設計のままだと、関門を外したい Goal が
 * いつでも外せる。スキーマ側で必ず混ぜる。
 */

const MINIMAL = {
  version: 1,
  goal: { id: "sample-goal", name: "サンプル", desired_state: "何かが完成している" },
  repository: {
    provider: "github",
    owner: "slashkiko",
    name: "entelecheia",
    default_branch: "main",
  },
  acceptance_criteria: [
    {
      id: "ac-1",
      description: "テストが通る",
      verification: { type: "command", run: "mise run test" },
    },
  ],
  context: { background: "背景", constraints: [] },
  budget: {
    max_actor_runs: 1,
    max_reconciles: 1,
    max_wall_clock: "1h",
    max_consecutive_failures: 1,
    max_unchanged_reconciles: 1,
  },
};

/**
 * YAML を parse した直後の形を作る。スキーマに通す前なので型は付けない。
 * `declared` を省くと `protected_paths` のキーごと無い YAML になる。
 */
function source(declared?: string[]): Record<string, unknown> {
  const policies: Record<string, unknown> = { require_human_approval: ["merge"] };
  if (declared !== undefined) {
    policies.protected_paths = declared;
  }
  return { ...structuredClone(MINIMAL), policies };
}

describe("保護パスの下限", () => {
  it("protected_paths を空で宣言しても下限が入る", () => {
    const goal = goalSchema.parse(source([]));

    for (const path of PROTECTED_PATH_FLOOR) {
      expect(goal.policies.protected_paths).toContain(path);
    }
  });

  it("protected_paths のキーごと省いても下限が入る", () => {
    const goal = goalSchema.parse(source());

    for (const path of PROTECTED_PATH_FLOOR) {
      expect(goal.policies.protected_paths).toContain(path);
    }
  });

  it("Goal が宣言した分は消えない", () => {
    const goal = goalSchema.parse(source(["docs/**"]));

    expect(goal.policies.protected_paths).toContain("docs/**");
    expect(goal.policies.protected_paths).toContain("src/controller/**");
  });

  it("同じパスを宣言しても重複しない", () => {
    const merged = withProtectedPathFloor(["src/controller/**", "src/controller/**"]);

    expect(merged.filter((path) => path === "src/controller/**")).toHaveLength(1);
  });

  it("下限は関門そのものを覆う", () => {
    // ここが欠けると、関門を無効化する変更を関門が見逃す。
    // 「検証系（mise.toml など）」は下限に入れない側なので、ここでは見ない。
    expect(PROTECTED_PATH_FLOOR).toContain("src/controller/**");
    expect(PROTECTED_PATH_FLOOR).toContain(".goals/**");
    expect(PROTECTED_PATH_FLOOR).toContain("src/domain/protected-paths.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/domain/goal.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/adapters/claude.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/adapters/codex.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/adapters/agent-prompt.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/adapters/local.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/domain/withheld-env.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/domain/guard-rules.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/wiring/index.ts");
  });

  it("guard が読む規則は、下限に入っているファイルの中に居る", () => {
    // 下限はパスのリテラルなので、**コードを別のファイルへ移すだけで保護が外れる。**
    // `guardBaseOf` や `elapsedSecondsSince` はもともと `src/controller/**` の中に
    // あって下限に覆われていた。依存を持たない規則だからという理由でドメインへ
    // 出したので、出した先も下限に入っていなければ、リファクタが静かに関門を弱める。
    //
    // 上の列挙（`toContain`）だけでは足りない。あれはファイルが下限にあることしか
    // 見ないので、規則だけを下限の外のファイルへ移しても落ちない。ここでは
    // **規則が実際にどのファイルで宣言されているか**をソースから確かめ、
    // そのファイルが下限にあることまで見る。
    const floor = new Set<string>(PROTECTED_PATH_FLOOR);

    for (const name of GUARD_RULES) {
      const homes = SOURCE_FILES.filter((file) =>
        readFileSync(join(REPO_ROOT, file), "utf8").includes(`export function ${name}(`),
      );

      expect(homes, `${name} を export しているファイルが1つに定まらない`).toHaveLength(1);
      expect(floor.has(homes[0] ?? ""), `${name} の置き場 ${homes[0]} が下限に無い`).toBe(true);
    }
  });

  it("guard が読む規則の置き場が、CODEOWNERS のレビュー必須にも入っている", () => {
    // 下限と同じ問題が CODEOWNERS にもある。どちらもパスのリテラルで、
    // `/src/controller/` の1行が中身ごと覆っていたものを外へ出すと、レビュー必須の
    // 範囲から静かに落ちる。守りたいのは同じ不変条件——**guard の規則を変える差分は、
    // 関門の下限にも人間のレビューにも必ず掛かる**——なので、ここで一緒に見る。
    const owners = readFileSync(join(REPO_ROOT, "CODEOWNERS"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => (line.split(/\s+/)[0] ?? "").replace(/^\//, ""));

    for (const name of GUARD_RULES) {
      const home = SOURCE_FILES.find((file) =>
        readFileSync(join(REPO_ROOT, file), "utf8").includes(`export function ${name}(`),
      );
      const covered = owners.some(
        (owned) => owned === home || (owned.endsWith("/") && (home ?? "").startsWith(owned)),
      );

      expect(covered, `${name} の置き場 ${home} が CODEOWNERS に無い`).toBe(true);
    }
  });

  it("関門への入力を決める配線も、下限と CODEOWNERS の中に居る", () => {
    // 規則と同じ理由で押さえる。`guardBaseOf` を守っても、その規則へ渡る観測を
    // 作る Adapter の注入と `verifyRoot` が外に出ていれば、関門は別の作業ツリーを
    // 見たまま毎ティック緑を返す。規則側と同じく、**宣言が実際にどのファイルに
    // あるか**をソースから読んで、その置き場が両方に入っていることまで見る。
    const floor = new Set<string>(PROTECTED_PATH_FLOOR);
    const owners = codeownerPaths();

    for (const name of WIRING_RULES) {
      const homes = SOURCE_FILES.filter((file) =>
        readFileSync(join(REPO_ROOT, file), "utf8").includes(`function ${name}(`),
      );

      expect(homes, `${name} を宣言しているファイルが1つに定まらない`).toHaveLength(1);
      const home = homes[0] ?? "";
      expect(floor.has(home), `${name} の置き場 ${home} が下限に無い`).toBe(true);
      expect(
        owners.some((owned) => owned === home || (owned.endsWith("/") && home.startsWith(owned))),
        `${name} の置き場 ${home} が CODEOWNERS に無い`,
      ).toBe(true);
    }
  });
});

/** CODEOWNERS が覆うパス。先頭の `/` を落として repoRoot 相対に揃える */
function codeownerPaths(): string[] {
  return readFileSync(join(REPO_ROOT, "CODEOWNERS"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.split(/\s+/)[0] ?? "").replace(/^\//, ""));
}

/**
 * guard（純ロジック）が読む判断規則。design.md §7 の停止条件はここが決める。
 *
 * 書き換えられると関門そのものが働かなくなるので、置き場は必ず
 * `PROTECTED_PATH_FLOOR` の中でなければならない。
 */
const GUARD_RULES = [
  "guardBaseOf",
  "claimsNothingLeft",
  "leavesWorkUncommitted",
  "observedValue",
  "sleepingUntil",
  "elapsedSecondsSince",
  "waitedSeconds",
  "consecutiveFailuresOf",
] as const;

/**
 * 関門への**入力**を決める配線。規則（`GUARD_RULES`）と対にして押さえる。
 *
 * 規則を1文字も触らなくても、関門が読む観測を差し替えれば関門は無力になる。
 * `tickPorts` は `localRepo` / `commandRunner` / `gitWorktree` を注入する場所で、
 * `verifyRoot` は未 commit の関門と VERIFY が見る作業ツリーを決める。
 * どちらもリファクタで `src/cli.ts` から合成ルートへ移った。**下限も CODEOWNERS も
 * パスのリテラルなので、移設のたびに一緒に動かさないと保護が付いてこない。**
 */
const WIRING_RULES = ["tickPorts", "verifyRoot"] as const;

const REPO_ROOT = new URL("../", import.meta.url).pathname;

/** repoRoot からの相対パスで、`src/**` の .ts を全部並べる */
function sourceFiles(): string[] {
  return readdirSync(join(REPO_ROOT, "src"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)));
}

const SOURCE_FILES = sourceFiles();

/**
 * 承認ゲートの下限。`protected_paths` と同じ理由で、Goal から外せなくする。
 *
 * `require_human_approval` に書いたゲートだけが `DENIED_TOOLS`（src/adapters/claude.ts）
 * の拒否パターンになる。**書かなければ許可される。** 既存の Goal YAML は全部が
 * 6ゲートを列挙していたので誰も気づかなかったが、`ent init` の雛形が `merge` だけを
 * 書いた時点で、そこから始めたリポジトリは全部それで回ることになった。
 */
function gated(declared?: string[]): Record<string, unknown> {
  const policies: Record<string, unknown> = { protected_paths: [] };
  if (declared !== undefined) {
    policies.require_human_approval = declared;
  }
  return { ...structuredClone(MINIMAL), policies };
}

describe("承認ゲートの下限", () => {
  it("require_human_approval を空で宣言しても下限が入る", () => {
    const goal = goalSchema.parse(gated([]));

    for (const gate of APPROVAL_GATE_FLOOR) {
      expect(goal.policies.require_human_approval).toContain(gate);
    }
  });

  it("キーごと省いても下限が入る", () => {
    const goal = goalSchema.parse(gated());

    for (const gate of APPROVAL_GATE_FLOOR) {
      expect(goal.policies.require_human_approval).toContain(gate);
    }
  });

  it("merge だけを書いた Goal でも、自己承認と資格情報の取り直しは塞がる", () => {
    // `ent init` の雛形が実際にこの形だった。gh pr comment が許可されたままだと、
    // Agent が /ent approve を投げて type: human の criteria を自分で通せる。
    const goal = goalSchema.parse(gated(["merge"]));

    expect(goal.policies.require_human_approval).toContain("external_send");
    expect(goal.policies.require_human_approval).toContain("secret_access");
    expect(goal.policies.require_human_approval).toContain("merge");
  });

  it("同じゲートを宣言しても重複しない", () => {
    const merged = withApprovalGateFloor(["external_send", "external_send"]);

    expect(merged.filter((gate) => gate === "external_send")).toHaveLength(1);
  });

  it("下限は関門そのものが働かなくなるものだけにする", () => {
    // merge / force_push / push_to_default_branch / deploy は危ないが、関門は
    // 無効化しない。Goal によっては正当に触るので、下限は最小に保つ。
    expect([...APPROVAL_GATE_FLOOR].sort()).toEqual(["external_send", "secret_access"]);
  });
});

/**
 * `ent init` が置く雛形。中身が関門の一部なので、下限と同じ場所で押さえる。
 *
 * 雛形が緩いゲートを配れば、そこから始めたリポジトリは全部それで回る。
 * 「スキーマとして妥当」だけでは足りない。
 */
describe("ent init の雛形", () => {
  const parsed = () => goalSchema.parse(parseYaml(goalTemplate(TEMPLATE_SLUG)));

  it("スキーマとして妥当で、ファイル名の slug と goal.id が揃う", () => {
    expect(parsed().goal.id).toBe(TEMPLATE_SLUG);
  });

  it("6ゲート全部を書く", () => {
    // 下限が混ぜるのは2つだけなので、残り4つは雛形が書かないと許可されたままになる。
    for (const gate of [
      "merge",
      "force_push",
      "push_to_default_branch",
      "deploy",
      "secret_access",
      "external_send",
    ]) {
      expect(parsed().policies.require_human_approval).toContain(gate);
    }
  });

  it("人間が埋める箇所に案内を置く", () => {
    // repository を埋め忘れても ent start は通り、最初のティックで GitHub の
    // 404 として初めて出る。「ent の話だと分かるところで止める」という doctor の
    // 方針と、雛形だけがずれることになる。
    const yaml = goalTemplate(TEMPLATE_SLUG);

    expect(yaml).toContain("対象リポジトリに合わせて埋める");
    expect(yaml).toContain("ファイル名の slug と一致させる");
  });
});
