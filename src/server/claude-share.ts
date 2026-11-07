import "server-only";
import type { Server } from "node:http";
import { createAuthProxy, createClaudeLoginSource, parseClaudeLogin, readKeychainCredentials } from "../../bin/claude-auth-proxy.mjs";

/**
 * EXPERIMENTAL — "Claude Code deste computador para os workers", toggled from Configurações →
 * Máquinas. Runs bin/claude-auth-proxy.mjs inside the panel process on 127.0.0.1 only; remote
 * workers reach it through their SSH tunnel and send ANTHROPIC_BASE_URL=http://127.0.0.1:<port>.
 * The credential stays in this Mac's Keychain and the proxy never refreshes it (see the module).
 */
export const CLAUDE_SHARE_PORT = Number(process.env.CARBON_CLAUDE_SHARE_PORT) || 8787;

export type ClaudeShareState = "off" | "starting" | "on" | "error" | "unsupported";

export interface ClaudeShareStatus {
  readonly state: ClaudeShareState;
  readonly port: number;
  readonly error: string | null;
  readonly startedAt: number | null;
  /** Calls forwarded since it was turned on, and how many of them the API refused. */
  readonly requests: number;
  readonly failures: number;
  readonly lastRequestAt: number | null;
}

interface Runtime {
  status: ClaudeShareStatus;
  server: Server | null;
}

const OFF: ClaudeShareStatus = { state: "off", port: CLAUDE_SHARE_PORT, error: null, startedAt: null, requests: 0, failures: 0, lastRequestAt: null };

const holder = globalThis as unknown as { carbonClaudeShare?: Runtime };
const runtime = (): Runtime => (holder.carbonClaudeShare ??= { status: process.platform === "darwin" ? OFF : { ...OFF, state: "unsupported", error: "só no macOS (o login do Claude Code fica no Keychain)" }, server: null });

const update = (patch: Partial<ClaudeShareStatus>): ClaudeShareStatus => {
  const r = runtime();
  r.status = { ...r.status, ...patch };
  return r.status;
};

export function claudeShareStatus(): ClaudeShareStatus {
  return runtime().status;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE" ? `a porta ${port} já está em uso (outro proxy rodando?)` : error.message)));
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

/**
 * Turns sharing on. Reads the Keychain first (this is when macOS asks for permission) so a missing
 * login fails here, visibly, instead of on the first remote task.
 */
export async function startClaudeShare(): Promise<ClaudeShareStatus> {
  const r = runtime();
  if (r.status.state === "unsupported" || r.status.state === "on" || r.status.state === "starting") return r.status;
  update({ state: "starting", error: null });
  try {
    parseClaudeLogin(await readKeychainCredentials());
    const server = createAuthProxy({
      readToken: createClaudeLoginSource(),
      onRequest: (status) => {
        const s = runtime().status;
        update({ requests: s.requests + 1, failures: s.failures + (status >= 400 ? 1 : 0), lastRequestAt: Date.now() });
      },
    });
    await listen(server, CLAUDE_SHARE_PORT);
    r.server = server;
    return update({ state: "on", startedAt: Date.now(), requests: 0, failures: 0, lastRequestAt: null });
  } catch (error) {
    return update({ state: "error", error: error instanceof Error ? error.message : "falha ao ligar" });
  }
}

export async function stopClaudeShare(): Promise<ClaudeShareStatus> {
  const r = runtime();
  const server = r.server;
  r.server = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (r.status.state === "unsupported") return r.status;
  return update({ ...OFF });
}
