import { describe, expect, it } from "vitest";
import { isUsageLimit, PortError, resumeAfterOf } from "../src/domain/port-error.js";

describe("PortError", () => {
  it("usage_limit は再開時刻を持てる", () => {
    const error = new PortError("usage_limit", "5時間の上限", "2026-08-09T10:00:00.000Z");

    expect(isUsageLimit(error)).toBe(true);
    expect(resumeAfterOf(error)).toBe("2026-08-09T10:00:00.000Z");
  });

  it("再開時刻が分からなければ null", () => {
    // リセット時刻が取れないこともある。分からないことを分からないまま返す。
    const error = new PortError("usage_limit", "上限に達した");
    expect(resumeAfterOf(error)).toBeNull();
  });

  it("unavailable は usage_limit ではない", () => {
    const error = new PortError("unavailable", "502 Bad Gateway");

    expect(isUsageLimit(error)).toBe(false);
    expect(resumeAfterOf(error)).toBeNull();
  });

  it("ただの Error は usage_limit ではない", () => {
    expect(isUsageLimit(new Error("何か"))).toBe(false);
    expect(isUsageLimit(null)).toBe(false);
    expect(isUsageLimit("上限")).toBe(false);
  });

  it("別インスタンスの PortError も判定できる", () => {
    // 多重インストールで instanceof が効かない構成でも取りこぼさない。
    const duck = {
      name: "PortError",
      kind: "usage_limit",
      resumeAfter: "2026-08-09T10:00:00.000Z",
    };

    expect(isUsageLimit(duck)).toBe(true);
    expect(resumeAfterOf(duck)).toBe("2026-08-09T10:00:00.000Z");
  });

  it("Error として throw / catch できる", () => {
    expect(() => {
      throw new PortError("usage_limit", "上限に達した");
    }).toThrow(Error);
  });
});
