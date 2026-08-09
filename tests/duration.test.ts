import { describe, expect, it } from "vitest";
import { durationSeconds, goalSchema } from "../src/domain/goal.js";

/**
 * `max_wall_clock` の単位が、宣言と変換で1つの表から来ることを固定する。
 *
 * 以前は正規表現が `[smh]` を許し、変換側が `switch` の `default` で時間に
 * 落としていた。単位を1つ足すと——この関数のコメント自身が例に挙げている `d` の
 * 追加がまさにそれ——正規表現は通るのに変換が `default` に落ちる。`2d` が
 * 7200 秒になり、24分の1に潰れる。どこにもエラーは出ない。
 *
 * この値は壁時計の停止条件なので、潰れると Goal が1日早く
 * `budget_exhausted` で止まる。
 */

describe("duration の変換", () => {
  it("秒・分・時をそれぞれの倍率で返す", () => {
    expect(durationSeconds("30s")).toBe(30);
    expect(durationSeconds("10m")).toBe(600);
    expect(durationSeconds("6h")).toBe(21600);
  });

  it("知らない単位は null にする", () => {
    // ここが `default` で時間に落ちていた。表に無い単位は解釈しない。
    expect(durationSeconds("2d")).toBeNull();
    expect(durationSeconds("2w")).toBeNull();
    expect(durationSeconds("2")).toBeNull();
    expect(durationSeconds("")).toBeNull();
  });

  it("スキーマが受け付ける形と、変換できる形が一致する", () => {
    // 片方だけ広い状態を作らない。スキーマを通った値は必ず秒に直せる。
    const accepted = ["1s", "90m", "24h"];
    const rejected = ["1d", "1w", "1", "h", "-1s", "1.5h"];

    for (const value of accepted) {
      expect(goalSchema.shape.budget.shape.max_wall_clock.safeParse(value).success).toBe(true);
      expect(durationSeconds(value)).not.toBeNull();
    }
    for (const value of rejected) {
      expect(goalSchema.shape.budget.shape.max_wall_clock.safeParse(value).success).toBe(false);
      expect(durationSeconds(value)).toBeNull();
    }
  });
});
