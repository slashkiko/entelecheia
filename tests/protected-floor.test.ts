import { describe, expect, it } from "vitest";
import { goalSchema, PROTECTED_PATH_FLOOR, withProtectedPathFloor } from "../src/domain/goal.js";

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
  policies: { require_human_approval: ["merge"], protected_paths: [] },
  budget: {
    max_actor_runs: 1,
    max_reconciles: 1,
    max_wall_clock: "1h",
    max_consecutive_failures: 1,
    max_unchanged_reconciles: 1,
  },
} as const;

describe("保護パスの下限", () => {
  it("protected_paths を空で宣言しても下限が入る", () => {
    const goal = goalSchema.parse(structuredClone(MINIMAL));

    for (const path of PROTECTED_PATH_FLOOR) {
      expect(goal.policies.protected_paths).toContain(path);
    }
  });

  it("protected_paths のキーごと省いても下限が入る", () => {
    const source = structuredClone(MINIMAL) as {
      policies: { require_human_approval: string[]; protected_paths?: string[] };
    };
    source.policies.protected_paths = undefined;
    delete source.policies.protected_paths;

    const goal = goalSchema.parse(source);

    for (const path of PROTECTED_PATH_FLOOR) {
      expect(goal.policies.protected_paths).toContain(path);
    }
  });

  it("Goal が宣言した分は消えない", () => {
    const source = structuredClone(MINIMAL) as {
      policies: { require_human_approval: string[]; protected_paths: string[] };
    };
    source.policies.protected_paths = ["docs/**"];

    const goal = goalSchema.parse(source);

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
    expect(PROTECTED_PATH_FLOOR).toContain("src/adapters/local.ts");
    expect(PROTECTED_PATH_FLOOR).toContain("src/domain/withheld-env.ts");
  });
});
