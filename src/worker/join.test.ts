import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "./client";
import { EXIT_REMOVED, JoinError, leaveCluster, resolveCredential, type ResolveOptions } from "./join";
import { parseJoinArgs } from "./join-args";
import { markNodeRemoved, nodeFile, NodeStateError, readNodeState, safeHostname, writeNodeState, type NodeState } from "./node-state";

const PANEL = "https://painel.exemplo.com";
const JOIN_TOKEN = `cjt_${"J".repeat(43)}`;
const NODE_TOKEN = `cwk_${"N".repeat(43)}`;

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "carbon-node-state-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

interface Call {
  readonly url: string;
  readonly auth: string | null;
  readonly body: unknown;
}

/** Fake panel: join returns a fresh node; hello accepts only the tokens in `accepted`. */
function fakePanel(accepted: Set<string> = new Set()) {
  const calls: Call[] = [];
  let joins = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (status: number, data: unknown, error: string | null = null) =>
      new Response(JSON.stringify({ success: status < 400, data, error }), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/worker/join")) {
      if (auth !== `Bearer ${JOIN_TOKEN}`) return json(401, null, "não autorizado");
      joins += 1;
      const token = `cwk_${String(joins).repeat(43).slice(0, 43)}`;
      accepted.add(token);
      return json(201, { nodeId: `node-${joins}`, token, name: "srv-1", availability: "active" });
    }
    if (url.endsWith("/api/worker/hello")) {
      return accepted.has(auth?.replace("Bearer ", "") ?? "") ? json(200, { protocol: 1, leaseMs: 60_000, pollMs: 25_000 }) : json(401, null, "não autorizado");
    }
    if (url.endsWith("/api/worker/leave")) return accepted.has(auth?.replace("Bearer ", "") ?? "") ? json(200, { left: true }) : json(401, null, "x");
    return json(404, null, "não encontrado");
  };
  return { calls, fetchImpl, joins: () => joins };
}

const caps = { executors: ["claude"] as const, git: false, maxParallel: 2, workerVersion: "0.9.0" };
const options = (fetchImpl: FetchLike, extra: Partial<ResolveOptions> = {}): ResolveOptions => ({
  panelUrl: PANEL,
  joinToken: JOIN_TOKEN,
  stateDir,
  hostname: "srv-1",
  name: "srv-1",
  explicitJoin: false,
  caps,
  fetchImpl,
  ...extra,
});
const savedState = (extra: Partial<NodeState> = {}): NodeState => ({
  panelUrl: PANEL,
  nodeId: "node-old",
  token: NODE_TOKEN,
  name: "srv-1",
  joinedAt: "2026-11-06T00:00:00.000Z",
  removedAt: null,
  ...extra,
});

describe("node state file", () => {
  it("is written atomically with mode 0600 and read back", () => {
    const file = writeNodeState(stateDir, "srv-1", savedState());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readNodeState(stateDir, "srv-1")).toEqual(savedState());
    expect(readNodeState(stateDir, "other")).toBeNull();
  });

  it("refuses a file other users can read, and a corrupt one", () => {
    const file = writeNodeState(stateDir, "srv-1", savedState());
    chmodSync(file, 0o644);
    expect(() => readNodeState(stateDir, "srv-1")).toThrow(NodeStateError);
    writeFileSync(file, "{nope", { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(() => readNodeState(stateDir, "srv-1")).toThrow(/corrompido/);
  });

  it("keys files by a safe hostname", () => {
    expect(safeHostname("../../etc/Passwd")).toBe("etc-passwd");
    expect(nodeFile(stateDir, "a/b")).toBe(path.join(stateDir, "nodes", "a-b.json"));
    expect(safeHostname("")).toBe("node");
  });
});

describe("resolveCredential", () => {
  it("uses CARBON_WORKER_TOKEN untouched when set (manual machines)", async () => {
    const panel = fakePanel();
    const result = await resolveCredential(options(panel.fetchImpl, { envToken: NODE_TOKEN }));
    expect(result).toMatchObject({ token: NODE_TOKEN, source: "env" });
    expect(panel.calls).toHaveLength(0);
  });

  it("joins with the cluster token, saves the credential and never stores the join token", async () => {
    const panel = fakePanel();
    const result = await resolveCredential(options(panel.fetchImpl));
    expect(result.source).toBe("joined");
    expect(panel.calls[0]).toMatchObject({ url: `${PANEL}/api/worker/join`, auth: `Bearer ${JOIN_TOKEN}`, body: { name: "srv-1", hostname: "srv-1", version: 1, maxParallel: 2 } });
    const raw = readFileSync(nodeFile(stateDir, "srv-1"), "utf8");
    expect(raw).toContain(result.token);
    expect(raw).not.toContain(JOIN_TOKEN);
  });

  it("restart reuses the saved node instead of joining again", async () => {
    const panel = fakePanel();
    const first = await resolveCredential(options(panel.fetchImpl));
    const second = await resolveCredential(options(panel.fetchImpl));
    expect(second).toMatchObject({ source: "saved", token: first.token, nodeId: first.nodeId });
    expect(panel.joins()).toBe(1);
  });

  it("explicit join re-validates: accepted credential is kept, refused one joins again", async () => {
    writeNodeState(stateDir, "srv-1", savedState());
    const keep = fakePanel(new Set([NODE_TOKEN]));
    expect((await resolveCredential(options(keep.fetchImpl, { explicitJoin: true }))).source).toBe("saved");
    expect(keep.joins()).toBe(0);

    const refused = fakePanel();
    const rejoined = await resolveCredential(options(refused.fetchImpl, { explicitJoin: true }));
    expect(rejoined.source).toBe("joined");
    expect(readNodeState(stateDir, "srv-1")?.nodeId).toBe("node-1");
  });

  it("auto-join never re-adds a node the admin removed (exit 3); explicit join does", async () => {
    markNodeRemoved(stateDir, "srv-1", savedState());
    const panel = fakePanel();
    await expect(resolveCredential(options(panel.fetchImpl))).rejects.toMatchObject({ exitCode: EXIT_REMOVED });
    expect(panel.joins()).toBe(0);
    expect((await resolveCredential(options(panel.fetchImpl, { explicitJoin: true }))).source).toBe("joined");
  });

  it("a credential saved for another panel needs an explicit join", async () => {
    writeNodeState(stateDir, "srv-1", savedState({ panelUrl: "https://outro.exemplo.com" }));
    await expect(resolveCredential(options(fakePanel().fetchImpl))).rejects.toThrow(/outro painel/);
  });

  it("no credential and no join token explains how to join; refused join token is generic", async () => {
    await expect(resolveCredential(options(fakePanel().fetchImpl, { joinToken: undefined }))).rejects.toThrow(/carbon join/);
    const wrong = `cjt_${"X".repeat(43)}`;
    const error = await resolveCredential(options(fakePanel().fetchImpl, { joinToken: wrong })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JoinError);
    expect(String((error as Error).message)).not.toContain(wrong);
  });
});

describe("leaveCluster", () => {
  it("reports left, or already_removed when the panel no longer knows the node", async () => {
    expect(await leaveCluster(PANEL, NODE_TOKEN, fakePanel(new Set([NODE_TOKEN])).fetchImpl)).toBe("left");
    expect(await leaveCluster(PANEL, NODE_TOKEN, fakePanel().fetchImpl)).toBe("already_removed");
  });
});

describe("parseJoinArgs", () => {
  it("accepts url + token (+ name) and the env token", () => {
    expect(parseJoinArgs([`${PANEL}/`, "--token", JOIN_TOKEN, "--name", "gpu-1"])).toEqual({ panelUrl: PANEL, token: JOIN_TOKEN, name: "gpu-1" });
    expect(parseJoinArgs([PANEL], JOIN_TOKEN)).toEqual({ panelUrl: PANEL, token: JOIN_TOKEN });
  });

  it("rejects http outside loopback, missing pieces and unknown flags", () => {
    expect(parseJoinArgs(["http://painel.exemplo.com", "--token", JOIN_TOKEN])).toMatchObject({ error: expect.stringContaining("https") });
    expect(parseJoinArgs(["--token", JOIN_TOKEN])).toMatchObject({ error: "falta a URL do painel" });
    expect(parseJoinArgs([PANEL])).toMatchObject({ error: "falta --token cjt_…" });
    expect(parseJoinArgs([PANEL, "--force"])).toMatchObject({ error: "opção desconhecida: --force" });
    expect(parseJoinArgs(["http://127.0.0.1:3000", "--token", JOIN_TOKEN])).toMatchObject({ panelUrl: "http://127.0.0.1:3000" });
  });
});
