import { describe, expect, it } from "vitest";
import { createLimiter } from "./rate-limit";

describe("createLimiter (M3)", () => {
  it("limits after maxAttempts failures inside the window and forgets them after it", () => {
    const limiter = createLimiter({ windowMs: 1_000, maxAttempts: 3, maxKeys: 10 });
    for (let i = 0; i < 3; i++) limiter.recordFailure("k", 100 + i);
    expect(limiter.isLimited("k", 200)).toBe(true);
    expect(limiter.isLimited("k", 1_200)).toBe(false);
    expect(limiter.size()).toBe(0);
  });

  it("checking a key never stores it (no growth from successful lookups)", () => {
    const limiter = createLimiter({ windowMs: 1_000, maxAttempts: 3, maxKeys: 10 });
    for (let i = 0; i < 100; i++) expect(limiter.isLimited(`ok-${i}`, 0)).toBe(false);
    expect(limiter.size()).toBe(0);
  });

  it("caps the number of keys, evicting the least recently touched first", () => {
    const limiter = createLimiter({ windowMs: 60_000, maxAttempts: 2, maxKeys: 3 });
    limiter.recordFailure("a", 1);
    limiter.recordFailure("b", 2);
    limiter.recordFailure("c", 3);
    limiter.recordFailure("a", 4); // refreshes "a"
    limiter.recordFailure("d", 5); // evicts "b"
    expect(limiter.size()).toBe(3);
    expect(limiter.isLimited("a", 6)).toBe(true);
    limiter.recordFailure("b", 7);
    expect(limiter.isLimited("b", 8)).toBe(false);
  });

  it("periodic sweep drops expired keys even if they are never checked again", () => {
    const limiter = createLimiter({ windowMs: 1_000, maxAttempts: 5, maxKeys: 1_000, sweepEveryMs: 500 });
    for (let i = 0; i < 50; i++) limiter.recordFailure(`k${i}`, 0);
    expect(limiter.size()).toBe(50);
    limiter.recordFailure("fresh", 2_000);
    expect(limiter.size()).toBe(1);
  });

  it("keeps at most maxAttempts timestamps per key", () => {
    const limiter = createLimiter({ windowMs: 60_000, maxAttempts: 2, maxKeys: 10 });
    for (let i = 0; i < 1_000; i++) limiter.recordFailure("k", i);
    expect(limiter.isLimited("k", 1_001)).toBe(true);
  });
});
