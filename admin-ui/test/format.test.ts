import { describe, expect, it } from "vitest";
import { formatBytes, formatRelative } from "../src/format";

describe("formatBytes", () => {
  it("uses MB, GB and TB with one decimal", () => {
    expect(formatBytes(0, "en")).toBe("0 MB");
    expect(formatBytes(41 * 1024 * 1024, "en")).toBe("41 MB");
    expect(formatBytes(1.55 * 1024 ** 3, "en")).toBe("1.6 GB");
    expect(formatBytes(1.6 * 1024 ** 4, "en")).toBe("1.6 TB");
    expect(formatBytes(1000, "en")).toBe("< 0.1 MB");
  });

  it("follows the language's decimal mark", () => {
    expect(formatBytes(1.6 * 1024 ** 4, "cs")).toContain("1,6");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const ago = (s: number) => now / 1000 - s;
  it("says minutes, hours and days", () => {
    expect(formatRelative(ago(4 * 60 + 5), "en", now)).toMatch(/4 min/);
    expect(formatRelative(ago(4 * 60 + 5), "cs", now)).toMatch(/před 4 min/);
    expect(formatRelative(ago(3 * 3600), "en", now)).toMatch(/3 hr/);
    expect(formatRelative(ago(2 * 86400), "en", now)).toMatch(/2 days/);
  });
  it("says now for the last minute and a date after a month", () => {
    expect(formatRelative(ago(10), "en", now)).toBe("now");
    expect(formatRelative(ago(40 * 86400), "en", now)).toMatch(/2026/);
  });
});
