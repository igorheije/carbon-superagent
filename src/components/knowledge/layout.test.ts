import { describe, expect, it } from "vitest";
import { groupKey, layoutGroups, shortLabel } from "./layout";

describe("groupKey", () => {
  it("groups by module under common roots and by top folder otherwise", () => {
    expect(groupKey("src/payments/routes.ts")).toBe("src/payments");
    expect(groupKey("tests/e2e/a.test.ts")).toBe("tests");
    expect(groupKey("README.md")).toBe(".");
  });
});

describe("layoutGroups", () => {
  it("keeps the biggest clusters and folds the rest into 'outros'", () => {
    const refs = Array.from({ length: 14 }, (_, i) => `src/m${i}/a.ts`).concat(["src/m0/b.ts", "src/m0/c.ts"]);
    const { names, groupOf, anchors } = layoutGroups(refs);
    expect(names).toHaveLength(10);
    expect(names[0]).toBe("src/m0");
    expect(names.at(-1)).toBe("outros");
    expect(anchors).toHaveLength(10);
    expect(Math.max(...groupOf)).toBe(9);
  });

  it("keeps every anchor inside the canvas", () => {
    const { anchors } = layoutGroups(["a/x", "b/x", "c/x", "d/x"]);
    for (const [x, y] of anchors) {
      expect(x).toBeGreaterThan(0.1);
      expect(x).toBeLessThan(0.9);
      expect(y).toBeGreaterThan(0.1);
      expect(y).toBeLessThan(0.9);
    }
  });
});

describe("shortLabel", () => {
  it("disambiguates repeated file names with their folder", () => {
    expect(shortLabel(["src/a/routes.ts", "src/b/routes.ts", "src/c/logger.ts"])).toEqual(["a/routes.ts", "b/routes.ts", "logger.ts"]);
  });
});
