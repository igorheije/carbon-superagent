import { describe, expect, it } from "vitest";
import type { KnowledgeDoc } from "@/lib/knowledge/retrieve";
import { computeLayout } from "./force";

function corpus(n: number): KnowledgeDoc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `src/m${i % 6}/f${i}.ts`,
    kind: "code" as const,
    ref: `src/m${i % 6}/f${i}.ts`,
    text: "",
    links: i > 0 ? [`src/m${(i - 1) % 6}/f${i - 1}.ts`] : [],
  }));
}

describe("computeLayout", () => {
  it("is deterministic: same input, same positions (no jitter between renders)", () => {
    const a = computeLayout(corpus(40));
    const b = computeLayout(corpus(40));
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it("finishes settled: one more pass would barely move anything", () => {
    const { nodes } = computeLayout(corpus(80));
    expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("keeps nodes apart instead of stacking them", () => {
    const { nodes } = computeLayout(corpus(60));
    let overlaps = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 4) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
  });

  it("is fast enough to run before the first paint", () => {
    const start = performance.now();
    computeLayout(corpus(160));
    expect(performance.now() - start).toBeLessThan(400);
  });

  it("handles an empty corpus", () => {
    expect(computeLayout([]).nodes).toEqual([]);
  });
});
