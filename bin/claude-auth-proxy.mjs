#!/usr/bin/env node
/**
 * EXPERIMENTAL — auth-injecting proxy for remote workers.
 *
 * Lets a remote worker's Claude Code use the subscription credential that lives ONLY on this
 * machine. The remote side points ANTHROPIC_BASE_URL at this proxy (reached through an SSH
 * reverse tunnel, `ssh -R 8787:127.0.0.1:8787`) and sends a placeholder token; the proxy drops
 * every incoming credential header and injects the real one before forwarding to a FIXED
 * upstream (no SSRF: the client never chooses the host).
 *
 * The credential is a long-lived token from `claude setup-token`, stored in a 0600 file and
 * re-read per request (rotate by overwriting the file). Logs carry method, path and status only.
 *
 * Usage: node bin/claude-auth-proxy.mjs [--port 8787] (--from-claude-login | --token-file <path>)
 *   --from-claude-login  usa o login do Claude Code deste Mac (Keychain); renovação fica com o `claude` local
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 8787;
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".carbon-proxy", "claude-oauth-token");

/** Credential and hop-by-hop headers that must never be forwarded as received. */
const DROPPED_HEADERS = new Set([
  "authorization", "x-api-key", "proxy-authorization", "cookie",
  "host", "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Reads the token file, refusing files readable by group/others. Throws with a clear message. */
export function readTokenFile(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} tem permissão ${mode.toString(8)}; use chmod 600`);
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`${file} está vazio`);
  return token;
}

/** Copies request headers minus credentials/hop-by-hop, then injects the real credential. */
export function forwardHeaders(incoming, token, upstreamHost) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!DROPPED_HEADERS.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  out.host = upstreamHost;
  out.authorization = `Bearer ${token}`;
  return out;
}

/**
 * @param {{ upstream?: string, readToken: () => string, log?: (line: string) => void }} options
 * @returns {http.Server}
 */
export function createAuthProxy({ upstream = DEFAULT_UPSTREAM, readToken, log = () => {} }) {
  const target = new URL(upstream);
  const transport = target.protocol === "https:" ? https : http;

  return http.createServer((req, res) => {
    const reply = (status, message) => {
      log(`${req.method} ${req.url} -> ${status} (${message})`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message } }));
    };

    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return reply(403, "somente loopback");
    if (!req.url?.startsWith("/")) return reply(400, "caminho inválido");

    let token;
    try {
      token = readToken();
    } catch (error) {
      return reply(503, `credencial indisponível: ${error.message}`);
    }

    const upstreamReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, token, target.host),
      },
      (upstreamRes) => {
        log(`${req.method} ${req.url} -> ${upstreamRes.statusCode}`);
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (error) => {
      if (res.headersSent) return res.destroy(error);
      reply(502, `upstream: ${error.message}`);
    });
    req.on("aborted", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  });
}

// ---------------------------------------------------------------- local Claude Code login

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Renew this long before expiry so an in-flight request never carries a dying token. */
export const EXPIRY_MARGIN_MS = 60_000;

/** Reads the login the local Claude Code keeps in the macOS Keychain (JSON). Prompts for access once. */
export function readKeychainCredentials() {
  return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
}

/** { accessToken, expiresAt } from the Keychain JSON; throws a clear message on any other shape. */
export function parseClaudeLogin(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("credencial do Claude Code local em formato inesperado (não é JSON)");
  }
  const oauth = json?.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken || typeof oauth.expiresAt !== "number") {
    throw new Error("credencial do Claude Code local sem claudeAiOauth.accessToken/expiresAt: faça login com `claude` e `/login`");
  }
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
}

/**
 * Token source backed by the Mac's own Claude Code login. The proxy NEVER refreshes the OAuth
 * token itself: refresh tokens rotate, and a refresh here would log the local CLI out. When the
 * token is about to expire it asks the official `claude` CLI to run once (which renews and saves
 * it), answers 503 meanwhile, and picks the new token up from the Keychain on the next request.
 */
export function createClaudeLoginSource({ readCredentials = readKeychainCredentials, renew = renewWithLocalCli, now = Date.now } = {}) {
  let cached = null;
  let renewing = null;
  return () => {
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.accessToken;
    const login = parseClaudeLogin(readCredentials());
    if (login.expiresAt - EXPIRY_MARGIN_MS > now()) {
      cached = login;
      return login.accessToken;
    }
    renewing ??= Promise.resolve()
      .then(renew)
      .catch(() => undefined)
      .finally(() => {
        renewing = null;
      });
    throw new Error("token do Claude Code local expirando; renovando pelo `claude` local, tente de novo em instantes");
  };
}

/** One tiny call through the official CLI so it renews and stores the token itself. */
function renewWithLocalCli() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "responda apenas ok"], { stdio: "ignore", timeout: 120_000 });
    child.on("close", resolve);
    child.on("error", resolve);
  });
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, tokenFile: process.env.CARBON_PROXY_TOKEN_FILE || DEFAULT_TOKEN_FILE, fromClaudeLogin: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") args.port = Number(argv[++i]);
    else if (argv[i] === "--token-file") args.tokenFile = argv[++i];
    else if (argv[i] === "--from-claude-login") args.fromClaudeLogin = true;
    else throw new Error(`opção desconhecida: ${argv[i]}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("--port inválida");
  if (args.fromClaudeLogin && process.platform !== "darwin") throw new Error("--from-claude-login só existe no macOS (Keychain)");
  return args;
}

async function main() {
  const { port, tokenFile, fromClaudeLogin } = parseArgs(process.argv.slice(2));
  const readToken = fromClaudeLogin ? createClaudeLoginSource() : () => readTokenFile(tokenFile);
  if (fromClaudeLogin) parseClaudeLogin(readKeychainCredentials()); // fail fast (and trigger the Keychain prompt) before listening
  else readTokenFile(tokenFile);
  const server = createAuthProxy({
    readToken,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  server.listen(port, "127.0.0.1", () => console.log(`claude-auth-proxy em http://127.0.0.1:${port} -> ${DEFAULT_UPSTREAM}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`claude-auth-proxy: ${error.message}`);
    process.exit(1);
  });
}
