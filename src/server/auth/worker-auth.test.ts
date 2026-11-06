import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-worker-auth-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

type Modules = {
  auth: typeof import("./worker-auth");
  workers: typeof import("../repo/workers");
  db: typeof import("../db");
  http: typeof import("../http");
};
let m: Modules;

beforeAll(async () => {
  m = {
    auth: await import("./worker-auth"),
    workers: await import("../repo/workers"),
    db: await import("../db"),
    http: await import("../http"),
  };
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const req = (authorization?: string) => new Request("http://localhost/api/worker/hello", { method: "POST", headers: authorization ? { authorization } : {} });

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof m.http.HttpError) return error.status;
    throw error;
  }
}

describe("createWorker", () => {
  it("returns the plain token once and stores only its sha256", () => {
    const { worker, token } = m.auth.createWorker("  pc-sala ", "pool", "admin-1");
    expect(token).toMatch(/^cwk_[A-Za-z0-9_-]{43}$/);
    expect(worker).toMatchObject({ name: "pc-sala", kind: "pool", createdBy: "admin-1" });
    expect(JSON.stringify(worker)).not.toContain(token);
    const stored = m.db.getDb().prepare("SELECT token_hash FROM workers WHERE id = ?").get(worker.id) as { token_hash: string };
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(token.slice(4));
    const all = JSON.stringify(m.db.getDb().prepare("SELECT * FROM workers").all());
    expect(all).not.toContain(token);
    expect(m.workers.listWorkers().find((w) => w.id === worker.id)).not.toHaveProperty("token");
  });

  it("generates distinct tokens and rejects empty or long names", () => {
    const a = m.auth.createWorker("a", "pool", "u");
    const b = m.auth.createWorker("b", "agentcore", "u");
    expect(a.token).not.toBe(b.token);
    expect(statusOf(() => m.auth.createWorker("   ", "pool", "u"))).toBe(400);
    expect(statusOf(() => m.auth.createWorker("x".repeat(81), "pool", "u"))).toBe(400);
  });
});

describe("requireWorker", () => {
  it("accepts the Bearer token and throttles last_seen_at", () => {
    const { worker, token } = m.auth.createWorker("pc-1", "pool", "u");
    expect(m.auth.requireWorker(req(`Bearer ${token}`), 10_000)).toMatchObject({ id: worker.id, lastSeenAt: 10_000 });
    m.auth.requireWorker(req(`Bearer ${token}`), 20_000);
    expect(m.workers.findWorker(worker.id)?.lastSeenAt).toBe(10_000);
    m.auth.requireWorker(req(`bearer ${token}`), 10_000 + m.auth.LAST_SEEN_THROTTLE_MS);
    expect(m.workers.findWorker(worker.id)?.lastSeenAt).toBe(10_000 + m.auth.LAST_SEEN_THROTTLE_MS);
  });

  it("gives the same generic 401 for missing, malformed, unknown and revoked tokens", () => {
    const { worker, token } = m.auth.createWorker("pc-2", "pool", "u");
    const unknown = `cwk_${"A".repeat(43)}`;
    for (const header of [undefined, "Basic abc", "Bearer", `Bearer ${token.slice(0, -1)}`, "Bearer ctk_" + "A".repeat(43), `Bearer ${unknown}`]) {
      expect(statusOf(() => m.auth.requireWorker(req(header)))).toBe(401);
    }
    expect(statusOf(() => m.auth.requireWorker(req(`Bearer ${token}`)))).toBeNull();
    expect(m.auth.revokeWorker(worker.id)).toBe(true);
    expect(m.auth.revokeWorker(worker.id)).toBe(false);
    let message = "";
    try {
      m.auth.requireWorker(req(`Bearer ${token}`));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("não autenticado");
  });

  it("rate limits repeated failures with the same token (429)", () => {
    const bad = `Bearer cwk_${"B".repeat(43)}`;
    const now = 1_000_000;
    const statuses = Array.from({ length: 11 }, () => statusOf(() => m.auth.requireWorker(req(bad), now)));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("rate limits a valid token that floods the API, then recovers in the next window", () => {
    const { token } = m.auth.createWorker("pc-flood", "pool", "u");
    const start = 5_000_000;
    for (let i = 0; i < m.auth.WORKER_REQUESTS_PER_WINDOW; i += 1) m.auth.requireWorker(req(`Bearer ${token}`), start);
    expect(statusOf(() => m.auth.requireWorker(req(`Bearer ${token}`), start + 1))).toBe(429);
    expect(statusOf(() => m.auth.requireWorker(req(`Bearer ${token}`), start + m.auth.WORKER_REQUEST_WINDOW_MS))).toBeNull();
  });
});

describe("task tokens", () => {
  it("are single use and bound to their task", () => {
    const token = m.auth.issueTaskToken("t1", 60_000, 1000);
    expect(token).toMatch(/^ctk_[A-Za-z0-9_-]{43}$/);
    expect(m.auth.consumeTaskToken(token, "t2", 2000)).toBe(false);
    expect(m.auth.consumeTaskToken(token, "t1", 2000)).toBe(true);
    expect(m.auth.consumeTaskToken(token, "t1", 2001)).toBe(false);
  });

  it("expire after their TTL and reject malformed or unknown values", () => {
    const token = m.auth.issueTaskToken("t3", 60_000, 1000);
    expect(m.auth.consumeTaskToken(token, "t3", 1000 + 60_001)).toBe(false);
    expect(m.auth.consumeTaskToken("ctk_short", "t3", 1000)).toBe(false);
    expect(m.auth.consumeTaskToken(`ctk_${"C".repeat(43)}`, "t3", 1000)).toBe(false);
    const stored = JSON.stringify(m.db.getDb().prepare("SELECT * FROM task_tokens").all());
    expect(stored).not.toContain(token);
  });
});
