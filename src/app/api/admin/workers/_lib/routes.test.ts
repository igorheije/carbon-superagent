import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Admin → Máquinas routes called directly with a throwaway database and a mocked session cookie.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-admin-workers-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

let sessionToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "carbon_session" && sessionToken ? { value: sessionToken } : undefined) }),
}));

type Modules = {
  db: typeof import("@/server/db");
  users: typeof import("@/server/repo/users");
  settings: typeof import("@/server/repo/settings");
  tasks: typeof import("@/server/repo/tasks");
  projects: typeof import("@/server/repo/projects");
  workers: typeof import("@/server/repo/workers");
  auth: typeof import("@/server/auth/worker-auth");
  fleet: typeof import("./fleet");
  list: typeof import("../route");
  revoke: typeof import("../[id]/revoke/route");
  agentcore: typeof import("../../agentcore-kit/route");
};
let m: Modules;
let adminToken = "";
let memberToken = "";
let adminId = "";

const PANEL_URL = "https://painel.exemplo.com";

beforeAll(async () => {
  m = {
    db: await import("@/server/db"),
    users: await import("@/server/repo/users"),
    settings: await import("@/server/repo/settings"),
    tasks: await import("@/server/repo/tasks"),
    projects: await import("@/server/repo/projects"),
    workers: await import("@/server/repo/workers"),
    auth: await import("@/server/auth/worker-auth"),
    fleet: await import("./fleet"),
    list: await import("../route"),
    revoke: await import("../[id]/revoke/route"),
    agentcore: await import("../../agentcore-kit/route"),
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
  m.db.getDb().exec("DELETE FROM workers; DELETE FROM tasks");
  m.settings.saveSettings({ panelPublicUrl: PANEL_URL });
});

interface Envelope<T> {
  readonly success: boolean;
  readonly data: T;
  readonly error: string | null;
}

interface CreatedBody {
  readonly worker: { readonly id: string; readonly name: string; readonly kind: string };
  readonly token: string;
  readonly kitBase64: string;
  readonly filename: string;
  readonly folder: string;
}

const body = async <T>(response: Response): Promise<Envelope<T>> => (await response.json()) as Envelope<T>;

function postMachine(payload: unknown): Request {
  return new Request("http://127.0.0.1/api/admin/workers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const untar = (base64: string): string => gunzipSync(Buffer.from(base64, "base64")).toString("latin1");

describe("admin guard", () => {
  it("returns 401 without a session and 403 for members on every route", async () => {
    sessionToken = null;
    expect((await m.list.GET()).status).toBe(401);
    sessionToken = memberToken;
    expect((await m.list.GET()).status).toBe(403);
    expect((await m.list.POST(postMachine({ name: "x", target: "compose" }))).status).toBe(403);
    expect((await m.revoke.POST(new Request("http://127.0.0.1/"), params("nope"))).status).toBe(403);
    expect((await m.agentcore.GET()).status).toBe(403);
    expect(m.workers.listWorkers()).toHaveLength(0);
  });
});

describe("POST /api/admin/workers", () => {
  it("creates a pool worker, returns the token once and a compose kit named after the slug", async () => {
    const response = await m.list.POST(postMachine({ name: "Máquina São Paulo 01", target: "compose", replicas: 2, parallel: 3, executors: ["claude", "codex"] }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await body<CreatedBody>(response);
    expect(data.token).toMatch(/^cwk_[A-Za-z0-9_-]{43}$/);
    expect(data.worker).toMatchObject({ name: "Máquina São Paulo 01", kind: "pool" });
    expect(data.filename).toBe("carbon-worker-maquina-sao-paulo-01.tar.gz");
    expect(data.folder).toBe("carbon-worker-maquina-sao-paulo-01");

    const tar = untar(data.kitBase64);
    expect(tar).toContain("carbon-worker-maquina-sao-paulo-01/docker-compose.yml");
    expect(tar).toContain("carbon-worker-maquina-sao-paulo-01/.env");
    expect(tar).toContain(data.token);
    expect(tar).toContain(PANEL_URL);

    // Stored only as a hash; never retrievable again.
    const row = m.db.getDb().prepare("SELECT token_hash FROM workers WHERE id = ?").get(data.worker.id) as { token_hash: string };
    expect(row.token_hash).not.toContain(data.token);
    const listed = JSON.stringify(await body(await m.list.GET()));
    expect(listed).not.toContain(data.token);
    expect(listed).not.toContain(row.token_hash);
    expect(m.auth.requireWorker(new Request("http://127.0.0.1/api/worker/hello", { headers: { authorization: `Bearer ${data.token}` } })).id).toBe(data.worker.id);
  });

  it("renders a Kubernetes kit with the token only in secret.yaml", async () => {
    const { data } = await body<CreatedBody>(await m.list.POST(postMachine({ name: "cluster-a", target: "k8s" })));
    const tar = untar(data.kitBase64);
    expect(tar).toContain("carbon-worker-cluster-a/kustomization.yaml");
    expect(tar).toContain("carbon-worker-cluster-a/secret.yaml");
    expect(tar.split(data.token)).toHaveLength(2);
  });

  it("returns 400 and creates nothing when the public panel URL is not set", async () => {
    m.settings.saveSettings({ panelPublicUrl: "" });
    const response = await m.list.POST(postMachine({ name: "sem-url", target: "compose" }));
    expect(response.status).toBe(400);
    expect((await body(response)).error).toContain("URL pública do painel");
    expect(m.workers.listWorkers()).toHaveLength(0);
  });

  it("rejects invalid options before creating the worker", async () => {
    expect((await m.list.POST(postMachine({ name: "img", target: "compose", image: "evil image; rm -rf /" }))).status).toBe(400);
    expect((await m.list.POST(postMachine({ name: "x", target: "docker" }))).status).toBe(400);
    expect((await m.list.POST(postMachine({ name: "x", target: "compose", executors: [] }))).status).toBe(400);
    expect((await m.list.POST(postMachine({ name: "x", target: "compose", replicas: 0 }))).status).toBe(400);
    expect((await m.list.POST(postMachine({ name: "   ", target: "compose" }))).status).toBe(400);
    expect(m.workers.listWorkers()).toHaveLength(0);
  });
});

describe("GET /api/admin/workers", () => {
  it("lists status from last_seen_at and leased tasks, with the current task key", async () => {
    const now = Date.now();
    const leaseMs = m.settings.getSettings().workers.leaseMs;
    const busy = m.auth.createWorker("ocupada", "pool", adminId).worker;
    const idle = m.auth.createWorker("ociosa", "pool", adminId).worker;
    const stale = m.auth.createWorker("sumida", "pool", adminId).worker;
    const never = m.auth.createWorker("nova", "pool", adminId).worker;
    const revoked = m.auth.createWorker("revogada", "pool", adminId).worker;
    m.workers.touchLastSeen(busy.id, now, "0.2.0+p1");
    m.workers.touchLastSeen(idle.id, now);
    m.workers.touchLastSeen(stale.id, now - 2 * leaseMs - 1);
    m.workers.touchLastSeen(revoked.id, now);
    m.auth.revokeWorker(revoked.id);

    const project = m.projects.createProject({ name: "p", repoPath: sandbox, baseBranch: "main" });
    const task = m.tasks.createTask({
      projectId: project.id, key: null, title: "t", description: "", source: "github", sourceRef: null, requesterId: adminId, requesterName: "Ana",
      persona: "engineering", executor: "claude", model: "", effort: "", priority: "medium", runtime: "pool", repo: "p", modelLabel: "",
    });
    m.db.getDb().prepare("UPDATE tasks SET status = 'running', lease_worker = ?, lease_expires_at = ? WHERE id = ?").run(busy.id, now + leaseMs, task.id);

    const { data } = await body<{ workers: readonly { id: string; status: string; version: string | null; currentTasks: readonly { key: string }[] }[] }>(await m.list.GET());
    const byId = new Map(data.workers.map((w) => [w.id, w]));
    expect(byId.get(busy.id)).toMatchObject({ status: "busy", version: "0.2.0+p1", currentTasks: [{ key: task.key }] });
    expect(byId.get(idle.id)?.status).toBe("idle");
    expect(byId.get(stale.id)?.status).toBe("offline");
    expect(byId.get(never.id)?.status).toBe("offline");
    expect(byId.get(revoked.id)?.status).toBe("revoked");
  });

  it("workerStatus: offline only past 2× leaseMs", () => {
    const now = 1_000_000;
    expect(m.fleet.workerStatus({ revokedAt: null, lastSeenAt: now - 120_000 }, 0, 60_000, now)).toBe("idle");
    expect(m.fleet.workerStatus({ revokedAt: null, lastSeenAt: now - 120_001 }, 1, 60_000, now)).toBe("offline");
  });
});

describe("POST /api/admin/workers/[id]/revoke", () => {
  it("revokes once, then 404; the token stops authenticating", async () => {
    const { data } = await body<CreatedBody>(await m.list.POST(postMachine({ name: "revogar", target: "compose" })));
    const first = await m.revoke.POST(new Request("http://127.0.0.1/"), params(data.worker.id));
    expect(first.status).toBe(200);
    expect((await m.revoke.POST(new Request("http://127.0.0.1/"), params(data.worker.id))).status).toBe(404);
    expect((await m.revoke.POST(new Request("http://127.0.0.1/"), params("inexistente"))).status).toBe(404);
    expect(() => m.auth.requireWorker(new Request("http://127.0.0.1/api/worker/hello", { headers: { authorization: `Bearer ${data.token}` } }))).toThrow();
  });
});

describe("GET /api/admin/agentcore-kit", () => {
  it("serves a .tar.gz with the panel URL and no worker token", async () => {
    const response = await m.agentcore.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toContain("carbon-agentcore.tar.gz");
    const tar = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("latin1");
    expect(tar).toContain("carbon-agentcore/deploy.sh");
    expect(tar).toContain(PANEL_URL);
    expect(tar).not.toMatch(/cwk_[A-Za-z0-9_-]{43}/);
  });
});
