import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Credential of a node that entered the cluster with `carbon join`. One file per hostname under the
 * state dir, so restarting the worker (or the container, with a volume) reuses the same node instead
 * of joining again. Written atomically with mode 0600; a file other users can read is refused.
 */
export const DEFAULT_STATE_DIR = path.join(homedir(), ".carbon-worker");

const nodeStateSchema = z.object({
  panelUrl: z.string().min(1),
  nodeId: z.string().min(1),
  token: z.string().startsWith("cwk_"),
  name: z.string(),
  joinedAt: z.string(),
  /** Set when the panel refused the credential (node removed): auto-join from the env must not re-add it. */
  removedAt: z.string().nullable().default(null),
});
export type NodeState = z.infer<typeof nodeStateSchema>;

export class NodeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeStateError";
  }
}

/** Hostname made safe as a file name (container ids, FQDNs, StatefulSet pod names). */
export function safeHostname(hostname: string): string {
  const cleaned = hostname.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 120);
  return cleaned || "node";
}

export function nodeFile(stateDir: string, hostname: string): string {
  return path.join(stateDir, "nodes", `${safeHostname(hostname)}.json`);
}

const isPosix = process.platform !== "win32";

/** The saved node credential, null when there is none. Throws when the file is unsafe or corrupt. */
export function readNodeState(stateDir: string, hostname: string): NodeState | null {
  const file = nodeFile(stateDir, hostname);
  if (!existsSync(file)) return null;
  if (isPosix && (statSync(file).mode & 0o077) !== 0) {
    throw new NodeStateError(`${file} pode ser lido por outros usuários; rode chmod 600 nele (ou apague e faça carbon join de novo)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new NodeStateError(`${file} está corrompido; apague e rode carbon join de novo`);
  }
  const parsed = nodeStateSchema.safeParse(raw);
  if (!parsed.success) throw new NodeStateError(`${file} está corrompido; apague e rode carbon join de novo`);
  return parsed.data;
}

export function writeNodeState(stateDir: string, hostname: string, state: NodeState): string {
  const file = nodeFile(stateDir, hostname);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (isPosix) chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function markNodeRemoved(stateDir: string, hostname: string, state: NodeState, now = new Date()): void {
  writeNodeState(stateDir, hostname, { ...state, removedAt: now.toISOString() });
}

export function removeNodeState(stateDir: string, hostname: string): void {
  rmSync(nodeFile(stateDir, hostname), { force: true });
}
