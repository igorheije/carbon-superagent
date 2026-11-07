import { describe, expect, it } from "vitest";
import { outcomeOfStatus, statsFor, summarizeRuns, type RunRow } from "./task-runs";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;
const run = (workerId: string | null, startedAt: number, finishedAt: number | null, outcome: string | null): RunRow => ({ workerId, startedAt, finishedAt, outcome });

describe("summarizeRuns", () => {
  it("summarizes each machine inside the window and clips busy time to it", () => {
    const rows = [
      run("w1", NOW - 2 * HOUR, NOW - HOUR, "done"),
      run("w1", NOW - 30 * 60_000, NOW - 10 * 60_000, "failed"),
      run("w1", NOW - 5 * 60_000, null, null),
      run(null, NOW - 26 * HOUR, NOW - 23 * HOUR, "done"), // started before the window
    ];

    const stats = summarizeRuns(rows, 24 * HOUR, NOW);

    expect(statsFor(stats, "w1")).toEqual({
      finished: 2,
      done: 1,
      failed: 1,
      running: 1,
      successRate: 0.5,
      avgDoneMs: HOUR,
      busyMs: HOUR + 20 * 60_000 + 5 * 60_000,
    });
    expect(statsFor(stats, null)).toMatchObject({ finished: 1, done: 1, busyMs: HOUR, avgDoneMs: 3 * HOUR });
  });

  it("counts a lost lease as a failure and leaves success empty without finished runs", () => {
    const stats = summarizeRuns([run("w2", NOW - HOUR, NOW - 1, "lost"), run("w3", NOW - 1000, null, null)], 24 * HOUR, NOW);
    expect(statsFor(stats, "w2")).toMatchObject({ failed: 1, successRate: 0 });
    expect(statsFor(stats, "w3")).toMatchObject({ finished: 0, running: 1, successRate: null, avgDoneMs: null, busyMs: 1000 });
  });

  it("returns empty stats for a machine without runs", () => {
    expect(statsFor(summarizeRuns([], HOUR, NOW), "nobody")).toEqual({ finished: 0, done: 0, failed: 0, running: 0, successRate: null, avgDoneMs: null, busyMs: 0 });
  });
});

describe("outcomeOfStatus", () => {
  it("keeps terminal statuses and maps the rest to canceled", () => {
    expect(outcomeOfStatus("done")).toBe("done");
    expect(outcomeOfStatus("failed")).toBe("failed");
    expect(outcomeOfStatus("waiting")).toBe("waiting");
    expect(outcomeOfStatus("queued")).toBe("canceled");
  });
});
