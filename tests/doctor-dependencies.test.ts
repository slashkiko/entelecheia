import { describe, expect, it } from "vitest";
import { type DoctorGoal, type DoctorProbes, doctorPayload } from "../src/cli.js";

/**
 * `ent doctor` に、`goal.depends_on` の壊れ方2つを見つけさせる。
 *
 * 依存の判定は `tick` の入口にあり、依存が揃わないティックは lease も取らずに
 * return する（design.md §10-12）。**そのティックは何も書かない。** reconciles は
 * 進まず Decision も残らないので、`max_reconciles` にも `max_wall_clock` にも
 * 当たらない。つまり depends_on の書き間違いは、**どの停止条件にも掛からないまま
 * 永久に止まる**という壊れ方をする。
 *
 * 見つけ方は2つある。
 *
 *   循環      a → b → a のように依存が閉じている。全員が待ちのまま進まない。
 *             自己参照はスキーマが弾くが、2本以上をまたぐ循環は Goal YAML 1本
 *             からは見えない
 *   不在      依存先の `.goals/<id>.yaml` が無い。`ent start` を打ち忘れただけの
 *             「待てば進む」と、実行時には区別が付かない（どちらも `pending`）。
 *             宣言を全部読める doctor だけが分けられる
 *
 * **doctor は読むだけで、実行時の判定は変えない。** 「先に進んでよいか」は
 * 停止条件なので `dependencyGate`（`src/domain/guard-rules.ts`）が持ち続ける。
 * こちらが答えるのは「回す前の宣言が壊れていないか」で、層が違う。
 */

function goal(slug: string, dependsOn: string[] = []): DoctorGoal {
  return { slug, error: null, dependsOn };
}

function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    githubToken: () => "gho_xxx",
    loadGoals: async () => [goal("record-the-tick"), goal("list-goals")],
    stateWritable: async () => true,
    nodeVersion: () => "v24.18.1",
    gitRepository: async () => true,
    stateIgnored: async () => true,
    ...over,
  };
}

async function dependencies(over: Partial<DoctorProbes> = {}) {
  const report = await doctorPayload(probes(over));
  const check = report.checks.find((c) => c.name === "dependencies");
  if (check === undefined) {
    throw new Error("dependencies の検査が report に無い");
  }
  return { check, exitCode: report.exitCode };
}

describe("依存の宣言を回す前に調べる", () => {
  it("depends_on を1本も書いていなければ ok", async () => {
    const { check } = await dependencies();

    expect(check.result).toBe("ok");
  });

  it("依存先が実在して循環が無ければ ok", async () => {
    const { check } = await dependencies({
      loadGoals: async () => [goal("build-it"), goal("wire-it", ["build-it"])],
    });

    expect(check.result).toBe("ok");
  });
});

describe("依存先が無いことを見つける", () => {
  it("宣言だけあって Goal YAML が無い依存を failed にする", async () => {
    const { check, exitCode } = await dependencies({
      loadGoals: async () => [goal("wire-it", ["build-it"])],
    });

    expect(check.result).toBe("failed");
    expect(exitCode).not.toBe(0);
  });

  it("どの Goal のどの依存が無いのかを名指しする", async () => {
    // 件数だけでは直せない。doctor の他の検査と同じ方針にする。
    const { check } = await dependencies({
      loadGoals: async () => [goal("wire-it", ["build-it", "ship-it"])],
    });

    expect(check.detail).toContain("wire-it");
    expect(check.detail).toContain("build-it");
    expect(check.detail).toContain("ship-it");
  });

  it("実在する依存は名指しに混ぜない", async () => {
    const { check } = await dependencies({
      loadGoals: async () => [goal("build-it"), goal("wire-it", ["build-it", "ship-it"])],
    });

    expect(check.detail).toContain("ship-it");
    expect(check.detail).not.toContain("build-it");
  });
});

describe("循環を見つける", () => {
  it("2本の循環を failed にする", async () => {
    const { check, exitCode } = await dependencies({
      loadGoals: async () => [goal("alpha", ["bravo"]), goal("bravo", ["alpha"])],
    });

    expect(check.result).toBe("failed");
    expect(exitCode).not.toBe(0);
  });

  it("3本以上をまたぐ循環も見つける", async () => {
    const { check } = await dependencies({
      loadGoals: async () => [
        goal("alpha", ["bravo"]),
        goal("bravo", ["charlie"]),
        goal("charlie", ["alpha"]),
      ],
    });

    expect(check.result).toBe("failed");
  });

  it("循環に入っている id を名指しする", async () => {
    const { check } = await dependencies({
      loadGoals: async () => [goal("alpha", ["bravo"]), goal("bravo", ["alpha"])],
    });

    expect(check.detail).toContain("alpha");
    expect(check.detail).toContain("bravo");
  });

  it("循環に入っていない Goal を巻き込まない", async () => {
    const { check } = await dependencies({
      loadGoals: async () => [goal("alpha", ["bravo"]), goal("bravo", ["alpha"]), goal("innocent")],
    });

    expect(check.detail).not.toContain("innocent");
  });

  it("同じ Goal を2本が指しているだけなら循環ではない", async () => {
    // 菱形（alpha → base、bravo → base）は閉じていない。ここを循環と読むと、
    // 分解した本数が増えるほど誤検知する。
    const { check } = await dependencies({
      loadGoals: async () => [goal("base"), goal("alpha", ["base"]), goal("bravo", ["base"])],
    });

    expect(check.result).toBe("ok");
  });
});

describe("読めなかった Goal は依存の検査に持ち込まない", () => {
  it("壊れた YAML があるときは、その Goal を依存の検査から外す", async () => {
    // 読めなかった時点で depends_on も読めていない。無いものを「依存が不在」と
    // 読むと、原因が1つなのに検査が2つ鳴る。goals の検査が先に failed にする。
    const { check } = await dependencies({
      loadGoals: async () => [
        { slug: "broken", error: "version は 1 を書く", dependsOn: [] },
        goal("wire-it", ["broken"]),
      ],
    });

    expect(check.result).not.toBe("failed");
  });
});
