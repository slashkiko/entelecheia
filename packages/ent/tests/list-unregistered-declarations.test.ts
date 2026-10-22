import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declarationsIn,
  listEntries,
  listEntryTotal,
  listPayload,
  main,
  parseCommand,
  unregisteredDeclarations,
} from "../src/cli.js";
import type { Goal } from "../src/domain/goal.js";
import { CONFIG_FILENAME } from "../src/domain/goal-config.js";
import type { Store } from "../src/store/port.js";
import { openStore } from "../src/store/sqlite.js";

/**
 * `.goals/` にあるのに状態ストアに登録されていない宣言を、`ent list` から見る。
 *
 * このリポジトリには36本の宣言があるのに `ent list --json` は登録済みの4本しか
 * 返さず、残りはどのコマンドからも見えなかった。次に何を start するかを決めるのに
 * `ls .goals/` と `ent list` を人間が突き合わせる必要があった。
 *
 * ここが固定するのは4つになる。
 *
 *   1. 未登録の宣言が list から見える
 *   2. `--json` の1要素だけを見て、登録済みか未登録かが分かる。**キーの有無から
 *      推測させない**（欠けたフィールドを読ませる形は、キーが1つ増えた日に壊れる）
 *   3. `config.yaml` は Goal ではないので、数えも並べもしない
 *   4. 既定の `ent list --json` が出す登録済み要素の形は1文字も変わらない。
 *      あの出力を読んでいるスクリプトを壊さない
 *
 * **なぜ未登録なのかは書かない。** 実装まで終わっていて状態 DB を作り直しただけの
 * ものと、まだ始めていないものは、ent からは同じに見える。分けるのは人間の判断で、
 * ent が推測して名前を付けると、その推測が観測として記録に残る（design.md §3.1）。
 */

const AT = "2026-08-26T09:00:00.000Z";

/** 既定の `ent list --json` が返す1要素のキー。**ここが増減したら消費側が壊れる** */
const REGISTERED_KEYS = [
  "criteria",
  "id",
  "lastDecidedAt",
  "name",
  "prNumber",
  "reconciles",
  "resumeAfter",
  "status",
  "stopped",
];

/** 未登録の宣言が持ってよいキー。事実（在り処）だけで、理由は持たない */
const UNREGISTERED_KEYS = ["id", "kind", "path"];

/**
 * ent が言ってはならない語。どれも「なぜ未登録か」の推測にあたる。
 *
 * 出力のどこにも現れないことを見る。1語でも混ざれば、人間の判断であるはずの
 * 「実装済みだが登録が消えた」と「まだ始めていない」を ent が決めたことになる。
 */
const GUESSES = /implemented|not yet started|never started|deregister|parked|abandoned|stale/i;

function goalWith(id: string, name: string): Goal {
  return {
    version: 1,
    goal: { id, name, desired_state: "何かが完成している", depends_on: [] },
    repository: {
      provider: "github",
      owner: "slashkiko",
      name: "entelecheia",
      default_branch: "main",
    },
    setup: [],
    acceptance_criteria: [
      {
        id: "ac-1",
        description: "テストが通る",
        verification: { type: "command", run: "mise run test" },
      },
    ],
    context: { background: "背景", constraints: [], references: [] },
    policies: { require_human_approval: ["merge"], protected_paths: [] },
    budget: {
      max_actor_runs: 10,
      max_reconciles: 20,
      max_wall_clock: "2h",
      max_consecutive_failures: 3,
      max_unchanged_reconciles: 3,
    },
  };
}

describe("declarationsIn", () => {
  it("`.goals/` のファイル名から Goal の宣言だけを取り出す", () => {
    expect(declarationsIn(["bravo.yaml", "alpha.yaml"])).toEqual([
      { id: "alpha", path: ".goals/alpha.yaml" },
      { id: "bravo", path: ".goals/bravo.yaml" },
    ]);
  });

  it("config.yaml を Goal として数えない", () => {
    // repo スコープの宣言（CONFIG_SLUG）で、Goal ではない。外さないと
    // 「未登録の Goal が1本ある」と毎回報告し、start しようとした人間は
    // CLI に断られる（src/cli/parse.ts が名指しで拒否する）。
    const found = declarationsIn([CONFIG_FILENAME, "alpha.yaml"]);

    expect(found.map((declaration) => declaration.id)).toEqual(["alpha"]);
  });

  it("YAML でないものを数えない", () => {
    // `.goals/` には `.state/` も置かれる。拾うと存在しない Goal が並ぶ。
    expect(declarationsIn([".state", "README.md", "notes.txt"])).toEqual([]);
  });

  it("`.yml` も宣言として読み、同じ id は1本にまとめる", () => {
    expect(declarationsIn(["alpha.yml"])).toEqual([{ id: "alpha", path: ".goals/alpha.yml" }]);
    expect(declarationsIn(["alpha.yaml", "alpha.yml"])).toHaveLength(1);
  });

  it("ファイルシステムを読まない", () => {
    // 規則（何を Goal と数えるか）だけをここに置いてある。実在しない名前でも
    // 答えが返るので、除外の規則は一時ディレクトリ無しで確かめられる。
    expect(declarationsIn(["no-such-file.yaml"])).toEqual([
      { id: "no-such-file", path: ".goals/no-such-file.yaml" },
    ]);
  });
});

describe("未登録の宣言", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  const declared = declarationsIn([CONFIG_FILENAME, "alpha.yaml", "bravo.yaml", "charlie.yaml"]);

  it("登録済みの id を差し引いた分だけを返す", () => {
    store.upsertGoal(goalWith("alpha", "1番目"));

    expect(unregisteredDeclarations(store, declared)).toEqual([
      { kind: "unregistered", id: "bravo", path: ".goals/bravo.yaml" },
      { kind: "unregistered", id: "charlie", path: ".goals/charlie.yaml" },
    ]);
  });

  it("宣言が消えている登録済み Goal を未登録として並べない", () => {
    // 突き合わせるのは片方向だけ。`.goals/` に無い登録済み Goal は登録済みのまま。
    store.upsertGoal(goalWith("deleted-declaration", "宣言が消えた Goal"));

    expect(unregisteredDeclarations(store, declared).map((entry) => entry.id)).not.toContain(
      "deleted-declaration",
    );
  });

  it("なぜ未登録かを持たない", () => {
    const [entry] = unregisteredDeclarations(store, declarationsIn(["alpha.yaml"]));

    // 事実（登録されていないこと）と在り処だけ。status も理由も持たない。
    expect(Object.keys(entry ?? {}).sort()).toEqual(UNREGISTERED_KEYS);
    expect(JSON.stringify(entry)).not.toMatch(GUESSES);
  });
});

describe("listEntries", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.setStatus("alpha", "ACTIVE", null, AT);
  });

  afterEach(() => {
    store.close();
  });

  const declared = declarationsIn([CONFIG_FILENAME, "alpha.yaml", "bravo.yaml"]);

  it("登録済みと未登録を1つの配列で返す", () => {
    expect(listEntries(store, declared)).toEqual([
      {
        kind: "registered",
        id: "alpha",
        name: "1番目",
        status: "ACTIVE",
        reconciles: 0,
        prNumber: null,
        resumeAfter: null,
        stopped: null,
        criteria: null,
        lastDecidedAt: null,
      },
      { kind: "unregistered", id: "bravo", path: ".goals/bravo.yaml" },
    ]);
  });

  it("どの要素も kind を持つ。欠けたフィールドから推測させない", () => {
    const entries = listEntries(store, declared);

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toHaveProperty("kind");
      expect(["registered", "unregistered"]).toContain(entry.kind);
    }
  });

  it("登録済みの要素は、既定の出力に kind を足しただけの形になる", () => {
    // 消費側が `--include-unregistered` へ移っても、読んでいたキーはそのまま残る。
    const [registered] = listEntries(store, declared);
    const [byDefault] = listPayload(store);

    expect(Object.keys(registered ?? {}).sort()).toEqual([...REGISTERED_KEYS, "kind"].sort());
    expect(registered).toEqual({ kind: "registered", ...byDefault });
  });

  it("config.yaml を並べない", () => {
    expect(listEntries(store, declared).map((entry) => entry.id)).not.toContain("config");
  });

  it("なぜ未登録かを1語も書かない", () => {
    expect(JSON.stringify(listEntries(store, declared))).not.toMatch(GUESSES);
  });

  it("上限は登録済みと未登録の合計に掛かる。切ったことは全件数から読める", () => {
    expect(listEntries(store, declared, { limit: 1 })).toEqual([
      expect.objectContaining({ kind: "registered", id: "alpha" }),
    ]);
    expect(listEntryTotal(store, declared)).toBe(2);
  });

  it("宣言が1本も無ければ、既定の出力に kind を足したものと同じになる", () => {
    expect(listEntries(store, [])).toEqual(
      listPayload(store).map((entry) => ({ kind: "registered", ...entry })),
    );
  });
});

describe("parseCommand", () => {
  it("list は --include-unregistered を受け取る", () => {
    expect(parseCommand(["list", "--include-unregistered"])).toEqual({
      kind: "list",
      includeUnregistered: true,
    });
  });

  it("付けなければキーごと増やさない。既定の解釈を動かさない", () => {
    expect(parseCommand(["list"])).toEqual({ kind: "list" });
  });

  it("get には置かない。1本の Goal に未登録の宣言は現れない", () => {
    expect(parseCommand(["get", "alpha", "--include-unregistered"]).kind).toBe("error");
  });
});

describe("ent list", () => {
  let repoRoot: string;
  let cwd: string;
  let stdout: string[];

  function lastJson(): Record<string, unknown>[] {
    return JSON.parse(stdout.at(-1) ?? "null") as Record<string, unknown>[];
  }

  beforeEach(() => {
    cwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), "ent-unregistered-"));
    process.chdir(repoRoot);

    const goalsDir = join(repoRoot, ".goals");
    mkdirSync(join(goalsDir, ".state"), { recursive: true });

    // 宣言そのものは読まれない（読むのはファイル名だけ）ので、中身は目印で足りる。
    for (const name of ["alpha.yaml", "bravo.yaml", "charlie.yml"]) {
      writeFileSync(join(goalsDir, name), "version: 1\n");
    }
    writeFileSync(join(goalsDir, CONFIG_FILENAME), "version: 1\n");

    // alpha だけを登録する。CLI が開く DB と同じ場所に直接置く——ここで見たいのは
    // 一覧の出力で、start の経路（git / 関門の基準）ではない。
    const store = openStore(join(goalsDir, ".state", "goals.db"));
    store.upsertGoal(goalWith("alpha", "1番目"));
    store.close();

    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("既定では登録済みだけを、これまでと同じ形で出す", async () => {
    expect(await main(["list"])).toBe(0);

    const listed = lastJson();
    expect(listed.map((entry) => entry.id)).toEqual(["alpha"]);
    // kind は既定では付かない。付けた時点で「形は変えない」という約束が破れる。
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(REGISTERED_KEYS);
  });

  it("--include-unregistered で未登録の宣言まで見える", async () => {
    expect(await main(["list", "--include-unregistered"])).toBe(0);

    expect(lastJson()).toEqual([
      expect.objectContaining({ kind: "registered", id: "alpha" }),
      { kind: "unregistered", id: "bravo", path: ".goals/bravo.yaml" },
      { kind: "unregistered", id: "charlie", path: ".goals/charlie.yml" },
    ]);
  });

  it("どの要素も kind を持ち、config.yaml は出てこない", async () => {
    await main(["list", "--include-unregistered"]);

    const listed = lastJson();
    expect(listed.every((entry) => typeof entry.kind === "string")).toBe(true);
    expect(listed.map((entry) => entry.id)).not.toContain("config");
  });

  it("未登録である理由を書かない", async () => {
    await main(["list", "--include-unregistered"]);

    expect(stdout.at(-1)).not.toMatch(GUESSES);
  });

  it("`.goals/` が無くても落ちない", async () => {
    rmSync(join(repoRoot, ".goals"), { recursive: true, force: true });

    expect(await main(["list", "--include-unregistered"])).toBe(0);
    expect(lastJson()).toEqual([]);
  });
});
