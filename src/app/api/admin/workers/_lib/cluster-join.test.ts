import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Cluster join (Docker Swarm-like): join token lifecycle, /api/worker/join|leave, node availability
// and the admin routes, against a throwaway database with a mocked session cookie.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-cluster-join-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");
process.env.CARBON_WORKER_CLAIM_WAIT_MS = "0";

let sessionToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "carbon_session" && sessionToken ? { value: sessionToken } : undefined) }),
}));

type Modules = {
  db: typeof import("@/server/db");
  users: typeof import("@/server/repo/users");
  settings: typeof import("@/server/repo/settings");
  workers: typeof import("@/server/repo/workers");
  joinTokens: typeof import("@/server/auth/join-tokens");
  fleet: typeof import("./fleet");
  join: typeof import("../../../worker/join/route");
  leave: typeof import("../../../worker/leave/route");
  hello: typeof import("../../../worker/hello/route");
  claim: typeof import("../../../worker/_lib/claim");
  joinToken: typeof import("../join-token/route");
  availability: typeof import("../[id]/availability/route");
  prune: typeof import("../prune/route");
};
let m: Modules;
let adminToken = "";
let memberToken = "";
let adminId = "";
let ipCounter = 0;

beforeAll(async () => {
  m = {
    db: await import("@/server/db"),
    users: await import("@/server/repo/users"),
    settings: await import("@/server/repo/settings"),
    workers: await import("@/server/repo/workers"),
    joinTokens: await import("@/server/auth/join-tokens"),
    fleet: await import("./fleet"),
    join: await import("../../../worker/join/route"),
    leave: await import("../../../worker/leave/route"),
    hello: await import("../../../worker/hello/route"),
    claim: await import("../../../worker/_lib/claim"),
    joinToken: await import("../join-token/route"),
    availability: await import("../[id]/availability/route"),
    prune: await import("../prune/route"),
  };
  const admin = m.users.createUser({ email: "admin@x.dev", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false });
  const member = m.users.createUser({ email: "member@x.dev", name: "Bia", passwordHash: "x", persona: "product", role: "member", mustChangePassword: false });
  adminId = admin.id;
  adminToken = m.users.createSession(admin.id).token;
  memberToken = m.users.createSession(member.id).token;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  sessionToken = adminToken;
  m.db.getDb().exec("DELETE FROM workers; DELETE FROM join_tokens; DELETE FROM tasks");
  m.settings.saveSettings({ panelPublicUrl: "https://painel.exemplo.com", workers: { ...m.settings.getSettings().workers, requireJoinApproval: false } });
});

interface Envelope<T> {
  readonly success: boolean;
  readonly data: T;
  readonly error: string | null;
}
const body = async <T>(res: Response) => (await res.json()) as Envelope<T>;

/** Each call comes from its own IP so the per-IP failure limiter never leaks between tests. */
function workerRequest(route: string, token: string | null, payload: unknown = {}, ip = `10.0.0.${(ipCounter += 1) % 250}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${route}`, { method: "POST", headers, body: JSON.stringify(payload) });
}
const joinBody = (name = "srv-1") => ({ name, hostname: name, version: 1, executors: ["claude"], git: true, maxParallel: 2, workerVersion: "0.9.0" });
const adminPost = (url: string, payload: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

async function joinWith(token: string, name = "srv-1") {
  const res = await m.join.POST(workerRequest("/api/worker/join", token, joinBody(name)));
  return { status: res.status, data: res.status === 201 ? (await body<{ nodeId: string; token: string; availability: string }>(res)).data : null };
}

describe("join tokens", () => {
  it("rotating revokes the previous token and stores only the hash", () => {
    const first = m.joinTokens.rotateJoinToken(adminId);
    const second = m.joinTokens.rotateJoinToken(adminId);
    expect(first.token).toMatch(/^cjt_[A-Za-z0-9_-]{43}$/);
    expect(m.joinTokens.consumeJoinToken(first.token)).toBeNull();
    expect(m.joinTokens.consumeJoinToken(second.token)?.uses).toBe(1);
    const rows = m.db.getDb().prepare("SELECT token_hash FROM join_tokens").all() as { token_hash: string }[];
    expect(JSON.stringify(rows)).not.toContain(second.token);
  });

  it("honours max uses and expiry", () => {
    const once = m.joinTokens.rotateJoinToken(adminId, { maxUses: 1 });
    expect(m.joinTokens.consumeJoinToken(once.token)).not.toBeNull();
    expect(m.joinTokens.consumeJoinToken(once.token)).toBeNull();
    expect(m.joinTokens.joinTokenInfo()).toBeNull();

    const shortLived = m.joinTokens.rotateJoinToken(adminId, { ttlMs: 1_000 }, 10_000);
    expect(m.joinTokens.consumeJoinToken(shortLived.token, 10_500)).not.toBeNull();
    expect(m.joinTokens.consumeJoinToken(shortLived.token, 11_000)).toBeNull();
  });

  it("disabling stops every join until a new token exists", () => {
    const { token } = m.joinTokens.rotateJoinToken(adminId);
    expect(m.joinTokens.disableJoinToken()).toBe(true);
    expect(m.joinTokens.consumeJoinToken(token)).toBeNull();
  });
});

describe("POST /api/worker/join", () => {
  it("creates an active pool node with its own credential, reusable for hello", async () => {
    const { token } = m.joinTokens.rotateJoinToken(adminId);
    const joined = await joinWith(token, "srv-a");
    expect(joined.status).toBe(201);
    expect(joined.data?.token).toMatch(/^cwk_/);
    expect(joined.data?.availability).toBe("active");
    const node = m.workers.findWorker(joined.data?.nodeId ?? "");
    expect(node).toMatchObject({ name: "srv-a", kind: "pool", joinedVia: "join", hostname: "srv-a", availability: "active", capabilities: { maxParallel: 2 } });

    const hello = await m.hello.POST(workerRequest("/api/worker/hello", joined.data?.token ?? "", { version: 1, executors: ["claude"] }));
    expect(hello.status).toBe(200);
    expect((await body<{ availability: string }>(hello)).data.availability).toBe("active");
  });

  it("the same token lets many servers join (one node each)", async () => {
    const { token } = m.joinTokens.rotateJoinToken(adminId);
    const ids = await Promise.all(["a", "b", "c"].map(async (n) => (await joinWith(token, n)).data?.nodeId));
    expect(new Set(ids).size).toBe(3);
    expect(m.joinTokens.joinTokenInfo()?.uses).toBe(3);
  });

  it("max-uses=1 under concurrent joins lets exactly one in", async () => {
    const { token } = m.joinTokens.rotateJoinToken(adminId, { maxUses: 1 });
    const results = await Promise.all([1, 2, 3, 4].map((i) => joinWith(token, `n${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
  });

  it("generic 401 for missing, wrong-prefix, unknown and rotated tokens; never a worker token", async () => {
    const { token: old } = m.joinTokens.rotateJoinToken(adminId);
    m.joinTokens.rotateJoinToken(adminId);
    const cases = [null, "cwk_" + "A".repeat(43), "cjt_" + "B".repeat(43), old];
    for (const t of cases) {
      const res = await m.join.POST(workerRequest("/api/worker/join", t, joinBody()));
      expect(res.status).toBe(401);
      expect((await body(res)).error).not.toContain("expir");
    }
    expect(m.workers.listWorkers()).toHaveLength(0);
  });

  it("429 after repeated failures from one IP", async () => {
    let last = 0;
    for (let i = 0; i < 60; i += 1) last = (await m.join.POST(workerRequest("/api/worker/join", "cjt_" + "C".repeat(43), joinBody(), "10.9.9.9"))).status;
    expect(last).toBe(429);
  });

  it("nodes start pending when approval is required, and pending nodes claim nothing", async () => {
    m.settings.saveSettings({ workers: { ...m.settings.getSettings().workers, requireJoinApproval: true } });
    const { token } = m.joinTokens.rotateJoinToken(adminId);
    const joined = await joinWith(token);
    expect(joined.data?.availability).toBe("pending");
    expect(m.fleet.listFleet(60_000).find((w) => w.id === joined.data?.nodeId)?.status).toBe("pending");
  });
});

describe("node availability", () => {
  async function activeNode() {
    const { token } = m.joinTokens.rotateJoinToken(adminId);
    return (await joinWith(token)).data as { nodeId: string; token: string };
  }

  it("claim polling skips paused and pending nodes", async () => {
    const node = await activeNode();
    const spy = vi.spyOn(await import("@/server/runner/scheduler"), "claimNext");
    m.workers.setAvailability(node.nodeId, "paused");
    await m.claim.pollClaim({ id: node.nodeId, name: "x" }, ["claude"], { waitMs: 0, intervalMs: 1, leaseMs: 60_000 });
    expect(spy).not.toHaveBeenCalled();
    m.workers.setAvailability(node.nodeId, "active");
    await m.claim.pollClaim({ id: node.nodeId, name: "x" }, ["claude"], { waitMs: 0, intervalMs: 1, leaseMs: 60_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("admin pauses, resumes and approves; members are refused", async () => {
    const node = await activeNode();
    const ctx = { params: Promise.resolve({ id: node.nodeId }) };
    expect((await m.availability.POST(adminPost(`/x`, { availability: "paused" }), ctx)).status).toBe(200);
    expect(m.workers.findWorker(node.nodeId)?.availability).toBe("paused");
    expect(m.fleet.listFleet(60_000)[0]?.status).toBe("paused");
    expect((await m.availability.POST(adminPost(`/x`, { availability: "active" }), { params: Promise.resolve({ id: node.nodeId }) })).status).toBe(200);
    expect((await m.availability.POST(adminPost(`/x`, { availability: "pending" }), { params: Promise.resolve({ id: node.nodeId }) })).status).toBe(400);
    sessionToken = memberToken;
    expect((await m.availability.POST(adminPost(`/x`, { availability: "paused" }), { params: Promise.resolve({ id: node.nodeId }) })).status).toBe(403);
  });

  it("leave revokes the node's own credential", async () => {
    const node = await activeNode();
    expect((await m.leave.POST(workerRequest("/api/worker/leave", node.token))).status).toBe(200);
    expect(m.workers.findWorker(node.nodeId)?.revokedAt).not.toBeNull();
    expect((await m.hello.POST(workerRequest("/api/worker/hello", node.token, { version: 1 }))).status).toBe(401);
  });

  it("prune removes only offline join nodes", async () => {
    const node = await activeNode();
    const manual = m.workers.createWorkerRecord({ name: "manual", kind: "pool", tokenHash: "h-manual", createdBy: adminId });
    m.db.getDb().prepare("UPDATE workers SET last_seen_at = 1").run();
    const res = await m.prune.POST();
    expect((await body<{ removed: string[] }>(res)).data.removed).toEqual([node.nodeId]);
    expect(m.workers.findWorker(manual.id)?.revokedAt).toBeNull();
  });
});

describe("admin join-token route", () => {
  it("POST returns the token once with ready commands; GET never shows it", async () => {
    const res = await m.joinToken.POST(adminPost("/api/admin/workers/join-token", { maxUses: 5 }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = (await body<{ token: string; commands: { cli: string; docker: string } }>(res)).data;
    expect(created.commands.cli).toBe(`npx carbon join 'https://painel.exemplo.com' --token '${created.token}'`);
    expect(created.commands.docker).toContain(`CARBON_JOIN_TOKEN='${created.token}'`);
    expect(created.commands.docker).toContain("-v carbon-worker-state:/home/carbon/state");

    const info = await m.joinToken.GET();
    const text = await info.text();
    expect(text).not.toContain(created.token);
    expect(JSON.parse(text).data.token).toMatchObject({ maxUses: 5, uses: 0 });

    expect((await m.joinToken.DELETE()).status).toBe(200);
    expect((await body<{ token: unknown }>(await m.joinToken.GET())).data.token).toBeNull();
  });

  it("is admin only", async () => {
    sessionToken = memberToken;
    expect((await m.joinToken.POST(adminPost("/x", {}))).status).toBe(403);
    expect((await m.joinToken.GET()).status).toBe(403);
  });
});
