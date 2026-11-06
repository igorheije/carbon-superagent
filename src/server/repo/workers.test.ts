import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-workers-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

let workers: typeof import("./workers");

beforeAll(async () => {
  workers = await import("./workers");
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("workers repository", () => {
  it("creates a worker and finds it by token hash", () => {
    const w = workers.createWorkerRecord({ name: "pc-sala", kind: "pool", tokenHash: "hash-a", createdBy: "u1" }, 1000);
    expect(w).toMatchObject({ name: "pc-sala", kind: "pool", createdBy: "u1", createdAt: 1000, revokedAt: null, lastSeenAt: null, version: null, capabilities: {} });
    expect(workers.findWorkerByTokenHash("hash-a")?.id).toBe(w.id);
    expect(workers.findWorkerByTokenHash("nope")).toBeNull();
  });

  it("revoked workers are no longer found by token, and revoking twice reports false", () => {
    const w = workers.createWorkerRecord({ name: "pc-2", kind: "agentcore", tokenHash: "hash-b", createdBy: "u1" });
    expect(workers.revokeWorkerRecord(w.id, 5000)).toBe(true);
    expect(workers.revokeWorkerRecord(w.id)).toBe(false);
    expect(workers.findWorkerByTokenHash("hash-b")).toBeNull();
    expect(workers.findWorker(w.id)?.revokedAt).toBe(5000);
    expect(workers.revokeWorkerRecord("missing")).toBe(false);
  });

  it("touches last seen, stores capabilities and lists workers", () => {
    const w = workers.createWorkerRecord({ name: "pc-3", kind: "pool", tokenHash: "hash-c", createdBy: "u1" });
    workers.touchLastSeen(w.id, 42);
    expect(workers.findWorker(w.id)).toMatchObject({ lastSeenAt: 42, version: null });
    workers.touchLastSeen(w.id, 43, "0.3.0");
    workers.setCapabilities(w.id, { executors: ["claude"], git: true, maxParallel: 2 });
    expect(workers.findWorker(w.id)).toMatchObject({ lastSeenAt: 43, version: "0.3.0", capabilities: { executors: ["claude"], git: true, maxParallel: 2 } });
    expect(workers.listWorkers().map((x) => x.name)).toEqual(expect.arrayContaining(["pc-sala", "pc-2", "pc-3"]));
  });

  it("rejects a duplicated token hash", () => {
    expect(() => workers.createWorkerRecord({ name: "dup", kind: "pool", tokenHash: "hash-a", createdBy: "u1" })).toThrow(/UNIQUE/);
  });
});
