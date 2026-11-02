import { describe, expect, it } from "vitest";
import { DEMO_CORPUS } from "./corpus";
import { retrieve, tokenize } from "./retrieve";

describe("tokenize", () => {
  it("strips accents, lowercases and drops short tokens", () => {
    expect(tokenize("Paginação de AGENDAMENTOS no v2")).toEqual(["paginacao", "agendamentos"]);
  });
});

describe("retrieve", () => {
  it("returns nothing for an empty query", () => {
    expect(retrieve("  ", DEMO_CORPUS)).toEqual([]);
  });

  it("ranks the rate-limit code and lesson first for a rate limit query", () => {
    const hits = retrieve("rate limit login 429", DEMO_CORPUS, 4);
    const ids = hits.map((h) => h.doc.id);
    expect(ids).toContain("c2");
    expect(ids).toContain("l1");
    expect(hits[0]?.score).toBe(1);
  });

  it("normalizes scores to a descending 0..1 range and respects k", () => {
    const hits = retrieve("paginação cursor", DEMO_CORPUS, 3);
    expect(hits).toHaveLength(3);
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores.every((s) => s > 0 && s <= 1)).toBe(true);
  });

  it("ignores documents with no matching term", () => {
    const hits = retrieve("kubernetes", DEMO_CORPUS);
    expect(hits).toEqual([]);
  });
});
