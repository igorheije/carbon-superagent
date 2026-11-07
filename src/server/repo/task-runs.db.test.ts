import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-task-runs-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

let runs: typeof import("./task-runs");
let workers: typeof import("./workers");

beforeAll(async () => {
  runs = await import("./task-runs");
  workers = await import("./workers");
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("task runs across machines (DB)", () => {
  it("records a mixed trail (local then worker) with machine names, oldest first", () => {
    const vps = workers.createWorkerRecord({ name: "vps-sp-01", kind: "pool", tokenHash: "h1", createdBy: "u" });

    runs.startRun("t1", null, 1_000);
    runs.finishRun("t1", "failed", 2_000);
    runs.startRun("t1", vps.id, 3_000);

    const trail = runs.runsByTask(["t1", "nobody"]).get("t1");

    expect(trail).toEqual([
      { where: "esta máquina", isLocal: true, startedAt: 1_000, finishedAt: 2_000, outcome: "failed" },
      { where: "vps-sp-01", isLocal: false, startedAt: 3_000, finishedAt: null, outcome: null },
    ]);
  });

  it("a new start closes a run left open (crash) as lost, and keeps only the last few", () => {
    for (let i = 0; i < runs.RUNS_PER_TASK + 2; i += 1) runs.startRun("t2", null, i * 10);

    const trail = runs.runsByTask(["t2"]).get("t2") ?? [];

    expect(trail).toHaveLength(runs.RUNS_PER_TASK);
    expect(trail.slice(0, -1).every((r) => r.outcome === "lost")).toBe(true);
    expect(trail.at(-1)).toMatchObject({ finishedAt: null, outcome: null });
  });

  it("returns nothing for an empty id list", () => {
    expect(runs.runsByTask([]).size).toBe(0);
  });
});
