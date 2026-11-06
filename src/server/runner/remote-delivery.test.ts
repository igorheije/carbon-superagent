import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { NO_COMMITS_REF, type ClaimedTask, type ResultRequest } from "@/shared/worker-protocol";

// Worker-like flow against the real route handlers: claim → GET base bundle → "worker" commits in
// its own clone → PUT result bundle (or push to a bare remote) → POST result → branch imported.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-remote-delivery-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");
process.env.CARBON_WORKER_CLAIM_WAIT_MS = "50";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Modules = {
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  settings: typeof import("../repo/settings");
  auth: typeof import("../auth/worker-auth");
  live: typeof import("./live");
  local: typeof import("./local-delivery");
  remote: typeof import("./remote-delivery");
  runner: typeof import("./runner");
  claim: typeof import("@/app/api/worker/claim/route");
  bundle: typeof import("@/app/api/worker/tasks/[id]/bundle/route");
  result: typeof import("@/app/api/worker/tasks/[id]/result/route");
};
let m: Modules;
let ownerId = "";
let token = "";
let otherToken = "";
let counter = 0;

beforeAll(async () => {
  m = {
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    settings: await import("../repo/settings"),
    auth: await import("../auth/worker-auth"),
    live: await import("./live"),
    local: await import("./local-delivery"),
    remote: await import("./remote-delivery"),
    runner: await import("./runner"),
    claim: await import("@/app/api/worker/claim/route"),
    bundle: await import("@/app/api/worker/tasks/[id]/bundle/route"),
    result: await import("@/app/api/worker/tasks/[id]/result/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  token = m.auth.createWorker("maquina-a", "pool", ownerId).token;
  otherToken = m.auth.createWorker("maquina-b", "pool", ownerId).token;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks");
  m.settings.saveSettings({ autoPush: false, workers: { leaseMs: 60_000, pollMs: 25_000, requeueOnLeaseLoss: false, maxBundleMb: 200 } });
});

// ---------------------------------------------------------------- helpers

const unique = (name: string) => `${name}-${(counter += 1)}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

function repo(name: string, withCommit = true): string {
  const dir = path.join(sandbox, unique(name));
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# projeto\n");
  writeFileSync(path.join(dir, "app.txt"), "linha 1\n");
  if (withCommit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

/** Repo whose origin is a bare repo with main pushed (git transport). */
function repoWithRemote(name: string): { dir: string; bare: string } {
  const dir = repo(name);
  const bare = `${dir}.git`;
  git(sandbox, "init", "-q", "--bare", bare);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return { dir, bare };
}

function poolTask(repoPath: string) {
  const project = m.projects.findProjectByRepo(repoPath) ?? m.projects.createProject({ name: path.basename(repoPath), repoPath, baseBranch: "main" });
  return m.tasks.createTask({
    projectId: project.id, key: "CAR-9", title: "Ajustar app", description: "trocar a linha do app", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "pool",
  });
}

async function claim(): Promise<ClaimedTask> {
  const request = new Request("http://127.0.0.1/api/worker/claim", { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ executors: ["claude"] }) });
  const response = await m.claim.POST(request);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ClaimedTask }).data;
}

async function getBundle(taskId: string, bearer = token): Promise<Response> {
  return m.bundle.GET(new Request(`http://127.0.0.1/api/worker/tasks/${taskId}/bundle`, { headers: auth(bearer) }), params(taskId));
}

async function putBundle(taskId: string, body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, bearer = token, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit & { duplex: "half" } = { method: "PUT", headers: { ...auth(bearer), "content-type": "application/octet-stream", ...headers }, body, duplex: "half" };
  return m.bundle.PUT(new Request(`http://127.0.0.1/api/worker/tasks/${taskId}/bundle`, init), params(taskId));
}

async function postResult(taskId: string, body: ResultRequest, bearer = token): Promise<Response> {
  const request = new Request(`http://127.0.0.1/api/worker/tasks/${taskId}/result`, { method: "POST", headers: { ...auth(bearer), "content-type": "application/json" }, body: JSON.stringify(body) });
  return m.result.POST(request, params(taskId));
}

const ticketOf = (taskId: string) => m.tasks.findTask(taskId)?.snapshot as Ticket;

/** What a worker does with the base bundle: clone, check out baseRef, branch, change, commit. */
async function workerCommitFromBundle(claimed: ClaimedTask): Promise<{ clone: string; base: string | null; sha: string }> {
  const response = await getBundle(claimed.taskId);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  const file = path.join(sandbox, `${unique("base")}.bundle`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const clone = path.join(sandbox, unique("clone"));
  git(sandbox, "clone", "-q", file, clone);
  if (claimed.code.baseRef !== NO_COMMITS_REF) git(clone, "checkout", "-q", claimed.code.baseRef);
  const base = git(clone, "rev-parse", "HEAD");
  git(clone, "checkout", "-q", "-b", claimed.code.branch);
  writeFileSync(path.join(clone, "app.txt"), "linha 1 alterada pelo agente\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "feat: ajustar app");
  return { clone, base, sha: git(clone, "rev-parse", "HEAD") };
}

function resultBundle(clone: string, base: string | null, branch: string): Uint8Array<ArrayBuffer> {
  const out = path.join(sandbox, `${unique("result")}.bundle`);
  git(clone, "bundle", "create", "-q", out, base ? `${base}..${branch}` : branch);
  return new Uint8Array(readFileSync(out));
}

const incomingFiles = () => {
  const dir = path.join(sandbox, "data", "incoming");
  return existsSync(dir) ? readdirSync(dir) : [];
};

// ---------------------------------------------------------------- tests

describe("bundle transport", () => {
  it("imports the branch, fills workspace and diff, emits done, and 'apply to folder' works", async () => {
    const dir = repo("com-commits");
    const task = poolTask(dir);
    const claimed = await claim();
    expect(claimed.code.transport).toBe("bundle");
    const { clone, base, sha } = await workerCommitFromBundle(claimed);
    expect(git(dir, "rev-parse", "main")).toBe(base);

    const put = await putBundle(task.id, resultBundle(clone, base, claimed.code.branch));
    expect(put.status).toBe(200);
    const events: unknown[] = [];
    const onTask = (event: unknown) => events.push(event);
    m.live.liveEvents().on(m.runner.TASK_EVENT, onTask);
    try {
      const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: sha.slice(0, 7), transport: "bundle" });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: unknown }).data).toEqual({ status: "done" });
    } finally {
      m.live.liveEvents().off(m.runner.TASK_EVENT, onTask);
    }

    expect(git(dir, "rev-parse", claimed.code.branch)).toBe(sha);
    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.workspace).toMatchObject({ branch: claimed.code.branch, base: "main", prBase: "main", isActive: false, path: "" });
    expect(sha.startsWith(ticket.workspace?.commit ?? "x")).toBe(true);
    expect(ticket.diff).toEqual([expect.objectContaining({ path: "app.txt", additions: 1, deletions: 1 })]);
    expect(ticket.logs.some((l) => l.text.includes(`branch ${claimed.code.branch} importado`))).toBe(true);
    expect(events).toEqual([{ type: "done", taskId: task.id, detail: "ticket concluído" }]);
    expect(incomingFiles()).toEqual([]);
    expect(readdirSync(path.join(sandbox, "data", "outgoing"))).toEqual([]);
    const lease = m.db.getDb().prepare("SELECT lease_worker FROM tasks WHERE id = ?").get(task.id) as { lease_worker: string | null };
    expect(lease.lease_worker).toBeNull();
    expect(git(dir, "for-each-ref", "refs/carbon")).toBe("");

    const applied = await m.local.applyToWorkingDir(task.id, "Ana");
    expect(applied).toMatchObject({ ok: true });
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("linha 1 alterada pelo agente\n");
  });

  it("works for a repository without commits (snapshot baseline)", async () => {
    const dir = repo("sem-commits", false);
    const task = poolTask(dir);
    const claimed = await claim();
    expect(claimed.code).toMatchObject({ transport: "bundle", baseRef: NO_COMMITS_REF });
    const { clone, sha } = await workerCommitFromBundle(claimed);
    expect(git(clone, "rev-list", "--count", "HEAD")).toBe("2");

    expect((await putBundle(task.id, resultBundle(clone, null, claimed.code.branch))).status).toBe(200);
    const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: sha, transport: "bundle" });
    expect(response.status).toBe(200);

    expect(git(dir, "rev-parse", claimed.code.branch)).toBe(sha);
    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.diff.map((d) => d.path)).toEqual(["app.txt"]);
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);

    const applied = await m.local.applyToWorkingDir(task.id, "Ana");
    expect(applied).toMatchObject({ ok: true });
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("linha 1 alterada pelo agente\n");
  });

  it("autoPush on a repo without a remote logs it and still finishes", async () => {
    m.settings.saveSettings({ autoPush: true });
    const task = poolTask(repo("sem-remoto"));
    const claimed = await claim();
    const { clone, base, sha } = await workerCommitFromBundle(claimed);
    await putBundle(task.id, resultBundle(clone, base, claimed.code.branch));
    expect((await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: sha, transport: "bundle" })).status).toBe(200);
    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.logs.some((l) => l.text.includes("não tem remoto"))).toBe(true);
  });

  it("422 and a failed task when the bundle was never uploaded", async () => {
    const task = poolTask(repo("sem-upload"));
    const claimed = await claim();
    const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: "abc1234", transport: "bundle" });
    expect(response.status).toBe(422);
    expect(ticketOf(task.id).status).toBe("failed");
  });

  it("refuses to overwrite an existing branch that is not an ancestor", async () => {
    const dir = repo("divergente");
    const task = poolTask(dir);
    const claimed = await claim();
    const { clone, base, sha } = await workerCommitFromBundle(claimed);
    // Someone created the same branch in the central repo with other work meanwhile.
    git(dir, "branch", claimed.code.branch, "main");
    const other = path.join(sandbox, unique("other-wt"));
    git(dir, "worktree", "add", "-q", other, claimed.code.branch);
    writeFileSync(path.join(other, "outro.txt"), "outra mudança\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "outra coisa");
    git(dir, "worktree", "remove", other);
    const before = git(dir, "rev-parse", claimed.code.branch);

    await putBundle(task.id, resultBundle(clone, base, claimed.code.branch));
    const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: sha, transport: "bundle" });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain("nada foi sobrescrito");
    expect(git(dir, "rev-parse", claimed.code.branch)).toBe(before);
    expect(ticketOf(task.id).status).toBe("failed");
    expect(incomingFiles()).toEqual([]);
  });

  it("rejects a crafted bundle whose tree has a .git entry (fsck on import, M2)", async () => {
    const dir = repo("dotgit");
    const task = poolTask(dir);
    const claimed = await claim();
    const { clone, base } = await workerCommitFromBundle(claimed);
    // A tree with ".git/config" inside: checking it out would plant git config/hooks.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, input: "[core]\n\tfsmonitor = touch /tmp/pwned\n", encoding: "utf8" }).trim();
    const inner = execFileSync("git", ["mktree"], { cwd: clone, input: `100644 blob ${blob}\tconfig\n`, encoding: "utf8" }).trim();
    const head = git(clone, "rev-parse", "HEAD^{tree}");
    const entries = execFileSync("git", ["ls-tree", head], { cwd: clone, encoding: "utf8" });
    const tree = execFileSync("git", ["mktree"], { cwd: clone, input: `${entries}040000 tree ${inner}\t.git\n`, encoding: "utf8" }).trim();
    const evil = git(clone, "commit-tree", tree, "-p", "HEAD", "-m", "evil");
    git(clone, "update-ref", `refs/heads/${claimed.code.branch}`, evil);

    await putBundle(task.id, resultBundle(clone, base, claimed.code.branch));
    const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: evil, transport: "bundle" });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/importar/);
    expect(git(dir, "branch", "--list", claimed.code.branch)).toBe("");
    expect(ticketOf(task.id).status).toBe("failed");
  });

  it("rejects a result for a branch other than the task's", async () => {
    const task = poolTask(repo("outro-branch"));
    const claimed = await claim();
    const response = await postResult(task.id, { status: "done", branch: "main", commit: "abc1234", transport: "bundle" });
    expect(response.status).toBe(422);
    expect(claimed.code.branch).not.toBe("main");
    expect(ticketOf(task.id).status).toBe("failed");
  });
});

describe("push transport", () => {
  it("fetches the branch the worker pushed to origin", async () => {
    const { dir, bare } = repoWithRemote("com-remoto");
    const task = poolTask(dir);
    const claimed = await claim();
    expect(claimed.code.transport).toBe("git");
    const clone = path.join(sandbox, unique("push-clone"));
    git(sandbox, "clone", "-q", bare, clone);
    git(clone, "checkout", "-q", "-b", claimed.code.branch, `origin/${claimed.code.baseRef}`);
    writeFileSync(path.join(clone, "app.txt"), "via push\n");
    git(clone, "commit", "-q", "-am", "feat: via push");
    git(clone, "push", "-q", "origin", claimed.code.branch);
    const sha = git(clone, "rev-parse", "HEAD");

    const response = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: sha.slice(0, 10), transport: "push" });
    expect(response.status).toBe(200);
    expect(git(dir, "rev-parse", claimed.code.branch)).toBe(sha);
    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.diff.map((d) => d.path)).toEqual(["app.txt"]);
  });
});

describe("failures, limits and ownership", () => {
  it("a failed result fails the task, releases the lease and emits failed", async () => {
    const task = poolTask(repo("falhou"));
    const claimed = await claim();
    const events: unknown[] = [];
    const onTask = (event: unknown) => events.push(event);
    m.live.liveEvents().on(m.runner.TASK_EVENT, onTask);
    try {
      const response = await postResult(task.id, { status: "failed", branch: claimed.code.branch, commit: null, transport: "bundle", error: "agente saiu com código 1" });
      expect(response.status).toBe(200);
    } finally {
      m.live.liveEvents().off(m.runner.TASK_EVENT, onTask);
    }
    expect(ticketOf(task.id).status).toBe("failed");
    expect(events).toEqual([{ type: "failed", taskId: task.id, detail: "agente saiu com código 1" }]);
    // The lease is gone: a repeated result is lease_lost.
    const again = await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: null, transport: "bundle" });
    expect(again.status).toBe(409);
  });

  it("done without a commit finishes with nothing to deliver", async () => {
    const task = poolTask(repo("sem-mudanca"));
    const claimed = await claim();
    expect((await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: null, transport: "bundle" })).status).toBe(200);
    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.logs.some((l) => l.text.includes("nada a entregar"))).toBe(true);
  });

  it("413 above maxBundleMb (declared and streamed) and no partial file left", async () => {
    m.settings.saveSettings({ workers: { leaseMs: 60_000, pollMs: 25_000, requeueOnLeaseLoss: false, maxBundleMb: 1 } });
    const task = poolTask(repo("grande"));
    await claim();
    const big = new Uint8Array(1024 * 1024 + 1);
    const declared = await putBundle(task.id, big, token, { "content-length": String(big.byteLength) });
    expect(declared.status).toBe(413);

    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const streamed = await putBundle(task.id, stream);
    expect(streamed.status).toBe(413);
    expect(incomingFiles()).toEqual([]);
  });

  it("409 lease_lost on bundle and result routes for a worker that does not own the task", async () => {
    const task = poolTask(repo("dono"));
    const claimed = await claim();
    const get = await getBundle(task.id, otherToken);
    expect(get.status).toBe(409);
    expect(((await get.json()) as { error: string }).error).toBe("lease_lost");
    expect((await putBundle(task.id, new Uint8Array([1, 2, 3]), otherToken)).status).toBe(409);
    expect((await postResult(task.id, { status: "done", branch: claimed.code.branch, commit: null, transport: "bundle" }, otherToken)).status).toBe(409);
    expect(ticketOf(task.id).status).toBe("running");
  });

  it("401 without a worker token", async () => {
    const response = await m.bundle.GET(new Request("http://127.0.0.1/api/worker/tasks/x/bundle"), params("x"));
    expect(response.status).toBe(401);
  });
});
