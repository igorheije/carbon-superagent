#!/usr/bin/env node
/**
 * Public listener for remote workers (CARBON_WORKER_LISTEN).
 *
 * Forwards ONLY `/api/worker/*` to the Next server on 127.0.0.1:CARBON_PORT; every other request
 * gets an empty 404. The UI and admin API never become reachable through this port.
 *
 * Hardening: requests without a `Bearer cwk_…`/`ctk_…`/`cjt_…` token get an empty 401 before reaching
 * Next; JSON routes are capped at 1 MB and 60 s (bundles: the large ceiling and 30 min); open
 * sockets are capped in total (CARBON_WORKER_MAX_CONNECTIONS, 256) and per client address
 * (CARBON_WORKER_MAX_CONNECTIONS_PER_IP, 32); only simple query strings pass.
 * Plain Node ESM, no dependencies: imported by `bin/carbon.mjs start` and runnable on its own.
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ensureWorkerCert } from "./worker-tls.mjs";

export const WORKER_PREFIX = "/api/worker/";
/** Absolute ceiling for bundle uploads; the panel enforces the real limit (settings.workers.maxBundleMb). */
export const MAX_BODY_BYTES = 1024 * 1024 * 1024;
/** Every other worker route carries JSON (panel limit: 1 MB). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** Whole request (upload + long-poll answer) for non-bundle routes; claim/permissions polls take ≤ 25 s. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Bundle download/upload. */
export const BUNDLE_REQUEST_TIMEOUT_MS = 30 * 60_000;
/** Open sockets on the public port (CARBON_WORKER_MAX_CONNECTIONS). */
export const DEFAULT_MAX_CONNECTIONS = 256;
/** Open sockets per client address. */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 32;
/** Only worker (cwk_), task (ctk_) and cluster join (cjt_, for /api/worker/join) tokens are forwarded. */
const WORKER_AUTH = /^Bearer (cwk_|ctk_|cjt_)[A-Za-z0-9_-]{20,200}$/;
const BUNDLE_ROUTE = /^\/api\/worker\/tasks\/[^/]+\/bundle$/;
/** Worker routes only use simple query strings (?after=12). */
const SAFE_QUERY = /^(\?[A-Za-z0-9\-._~=&%]{0,512})?$/;
export const HEADERS_TIMEOUT_MS = 30_000;
/** Socket inactivity limit. Must stay above the claim long-poll (25 s) plus slack. */
export const IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_UPSTREAM_PORT = 3417;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Set by the proxy itself; client-supplied values are dropped so they cannot be spoofed. */
const PROXY_OWNED = new Set(["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-real-ip"]);
const SAFE_PATH = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+$/;
/** Encoded dot, slash, backslash, NUL or percent (double encoding) never appear in worker routes. */
const ENCODED_SEPARATOR = /%(2e|2f|5c|00|25)/i;
const CONTROL_OR_BACKSLASH = /[\x00-\x1f\x7f\\]/;

/**
 * Returns the request path when it is a canonical `/api/worker/<something>` origin-form target,
 * otherwise null. Rejects absolute-form, `..`/`.` segments (raw or percent-encoded), empty
 * segments, backslashes and anything outside the RFC 3986 path alphabet.
 */
export function workerPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null;
  const queryAt = rawUrl.indexOf("?");
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  if (!SAFE_PATH.test(pathname) || ENCODED_SEPARATOR.test(pathname)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (CONTROL_OR_BACKSLASH.test(decoded)) return null;
  const segments = decoded.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  if (!decoded.startsWith(WORKER_PREFIX) || decoded.length === WORKER_PREFIX.length) return null;
  if (!pathname.startsWith(WORKER_PREFIX)) return null;
  return pathname;
}

/** Parses `host:port`, `[ipv6]:port` or a bare port. Throws on anything else. */
export function parseListen(value) {
  const text = String(value ?? "").trim();
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(text) ?? /^()()(\d{1,5})$/.exec(text);
  const port = match ? Number(match[3]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CARBON_WORKER_LISTEN inválido: "${text}" (use host:porta, ex. 0.0.0.0:3418)`);
  }
  return { host: match[1] || match[2] || "0.0.0.0", port };
}

function forwardHeaders(req, isTls) {
  const connectionListed = String(req.headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const drop = new Set([...HOP_BY_HOP, ...PROXY_OWNED, ...connectionListed]);
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!drop.has(name)) out[name] = value;
  }
  out["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  out["x-forwarded-proto"] = isTls ? "https" : "http";
  if (req.headers.host) out["x-forwarded-host"] = req.headers.host;
  return out;
}

function responseHeaders(upstream) {
  const connectionListed = String(upstream.headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
  const out = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!HOP_BY_HOP.has(name) && !connectionListed.includes(name)) out[name] = value;
  }
  return out;
}

function sendEmpty(res, status) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-length": "0", connection: "close" });
  res.end();
}

function defaultLog(line) {
  console.log(line);
}

/** True when the request carries a well-formed worker (cwk_), task (ctk_) or join (cjt_) bearer token. */
export function hasWorkerAuth(headers) {
  const value = headers.authorization;
  return typeof value === "string" && WORKER_AUTH.test(value);
}

/** Counts open sockets per address; refuses (destroys) above the cap. */
function limitPerIp(server, maxPerIp) {
  const open = new Map();
  server.on("connection", (socket) => {
    const ip = socket.remoteAddress ?? "?";
    const count = (open.get(ip) ?? 0) + 1;
    if (count > maxPerIp) {
      socket.destroy();
      return;
    }
    open.set(ip, count);
    socket.once("close", () => {
      const left = (open.get(ip) ?? 1) - 1;
      if (left <= 0) open.delete(ip);
      else open.set(ip, left);
    });
  });
}

/**
 * Builds the proxy server (not listening yet).
 * @param {{ upstreamPort?: number, upstreamHost?: string, tls?: { cert: string|Buffer, key: string|Buffer },
 *   maxBodyBytes?: number, maxJsonBodyBytes?: number, headersTimeoutMs?: number, idleTimeoutMs?: number,
 *   requestTimeoutMs?: number, bundleRequestTimeoutMs?: number, maxConnections?: number, maxConnectionsPerIp?: number,
 *   log?: (line: string) => void }} [options]
 */
export function createWorkerProxy(options = {}) {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const maxBundleBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? MAX_JSON_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const bundleRequestTimeoutMs = options.bundleRequestTimeoutMs ?? BUNDLE_REQUEST_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const log = options.log ?? defaultLog;
  const isTls = Boolean(options.tls);

  const handler = (req, res) => {
    const started = Date.now();
    const target = req.method === "CONNECT" ? null : workerPath(req.url);
    const logPath = (target ?? String(req.url ?? "").split("?")[0]).slice(0, 200).replace(/[^\x21-\x7e]/g, "?");
    res.on("close", () => {
      const status = res.headersSent ? res.statusCode : "-";
      log(`[worker-proxy] ${req.socket.remoteAddress ?? "?"} ${req.method} ${logPath} ${status} ${Date.now() - started}ms`);
    });

    if (!target) {
      req.resume();
      sendEmpty(res, 404);
      return;
    }
    const query = req.url.slice(target.length);
    if (!SAFE_QUERY.test(query)) {
      req.resume();
      sendEmpty(res, 400);
      return;
    }
    if (!hasWorkerAuth(req.headers)) {
      req.resume();
      sendEmpty(res, 401);
      return;
    }
    const isBundle = BUNDLE_ROUTE.test(target);
    const maxBodyBytes = isBundle ? maxBundleBytes : maxJsonBodyBytes;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      req.resume();
      sendEmpty(res, 413);
      return;
    }

    let upstreamReq;
    try {
      upstreamReq = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: target + query,
        headers: forwardHeaders(req, isTls),
      });
    } catch {
      req.resume();
      sendEmpty(res, 502);
      return;
    }
    // Total time for this request, not just inactivity: a slow-drip client cannot hold a slot forever.
    const deadline = setTimeout(() => {
      upstreamReq.destroy();
      req.resume();
      sendEmpty(res, 408);
    }, isBundle ? bundleRequestTimeoutMs : requestTimeoutMs);
    deadline.unref();
    res.on("close", () => clearTimeout(deadline));
    upstreamReq.setTimeout(idleTimeoutMs, () => upstreamReq.destroy(new Error("upstream idle timeout")));
    upstreamReq.on("response", (upstream) => {
      if (res.headersSent) {
        upstream.resume();
        return;
      }
      res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream));
      upstream.pipe(res);
      upstream.on("error", () => res.destroy());
    });
    upstreamReq.on("error", (err) => {
      sendEmpty(res, /timeout/.test(err.message) ? 504 : 502);
    });

    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        req.unpipe(upstreamReq);
        upstreamReq.destroy();
        req.resume();
        sendEmpty(res, 413);
      }
    });
    req.on("aborted", () => upstreamReq.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  };

  const server = isTls ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler) : http.createServer(handler);
  server.headersTimeout = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  limitPerIp(server, options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP);
  // Per-route totals are enforced in the handler (60 s, 30 min for bundles); here only inactivity.
  server.requestTimeout = 0;
  server.setTimeout(idleTimeoutMs, (socket) => socket.destroy());
  // No WebSocket/h2c upgrades through this port.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

function positiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${name} precisa ser um inteiro entre 1 e 100000`);
  return value;
}

const LOOPBACK_LISTEN = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i;

/** True when the listener only accepts connections from this machine (a tunnel/VPN sidecar in front). */
export function isLoopbackListen(host) {
  return LOOPBACK_LISTEN.test(host);
}

/**
 * Picks the listener's TLS: explicit CARBON_WORKER_TLS_CERT/KEY; otherwise, when the listener is
 * reachable from other machines (0.0.0.0, a LAN IP) and CARBON_WORKER_TLS is not "off", a
 * self-signed pair in `tlsDir` that workers pin by fingerprint (`carbon join`). Loopback listeners
 * stay plain HTTP (the tunnel/VPN in front terminates TLS) unless CARBON_WORKER_TLS=on, which
 * forces the self-signed pair everywhere (e.g. a container port published from 127.0.0.1).
 */
export function resolveListenerTls(env, host, { tlsDir, ensureCert = ensureWorkerCert } = {}) {
  const certPath = env.CARBON_WORKER_TLS_CERT;
  const keyPath = env.CARBON_WORKER_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("Defina CARBON_WORKER_TLS_CERT e CARBON_WORKER_TLS_KEY juntos (ou nenhum).");
  }
  if (certPath) return { tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) }, mode: "custom", fingerprint: null };
  const mode = String(env.CARBON_WORKER_TLS ?? "auto").trim().toLowerCase() || "auto";
  if (mode !== "auto" && mode !== "on" && mode !== "off") throw new Error(`CARBON_WORKER_TLS inválido: "${mode}" (use auto, on ou off)`);
  if (mode === "on" && !tlsDir) throw new Error("CARBON_WORKER_TLS=on precisa da pasta de dados do painel para guardar o certificado");
  if (mode === "off" || !tlsDir || (mode === "auto" && isLoopbackListen(host))) return { tls: undefined, mode: "off", fingerprint: null };
  const pair = ensureCert(tlsDir);
  return { tls: { cert: pair.cert, key: pair.key }, mode: "self-signed", fingerprint: pair.fingerprint, created: pair.created };
}

/**
 * Starts the proxy from env (CARBON_WORKER_LISTEN, CARBON_PORT, CARBON_WORKER_TLS_CERT/KEY,
 * CARBON_WORKER_TLS). `options.tlsDir` is where the self-signed pair lives (auto TLS).
 * Resolves with `{ server, url, host, port, tls, tlsMode, fingerprint, close }` once listening;
 * rejects on bad config or bind failure.
 */
export async function startWorkerProxy(env = process.env, options = {}) {
  const { host, port } = parseListen(env.CARBON_WORKER_LISTEN);
  const { tlsDir, ensureCert, ...proxyOptions } = options;
  const resolved = resolveListenerTls(env, host, { tlsDir, ensureCert });
  const maxConnections = positiveInt(env.CARBON_WORKER_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS, "CARBON_WORKER_MAX_CONNECTIONS");
  const maxConnectionsPerIp = positiveInt(env.CARBON_WORKER_MAX_CONNECTIONS_PER_IP, DEFAULT_MAX_CONNECTIONS_PER_IP, "CARBON_WORKER_MAX_CONNECTIONS_PER_IP");
  const server = createWorkerProxy({ maxConnections, maxConnectionsPerIp, ...proxyOptions, tls: resolved.tls, upstreamPort: Number(env.CARBON_PORT ?? DEFAULT_UPSTREAM_PORT) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const boundPort = server.address().port;
  const shownHost = host === "0.0.0.0" || host === "::" ? "<este-host>" : host.includes(":") ? `[${host}]` : host;
  const url = `${resolved.tls ? "https" : "http"}://${shownHost}:${boundPort}`;
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { server, url, host, port: boundPort, tls: Boolean(resolved.tls), tlsMode: resolved.mode, fingerprint: resolved.fingerprint, certCreated: Boolean(resolved.created), close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorkerProxy(process.env, { tlsDir: process.env.CARBON_WORKER_TLS_DIR })
    .then(({ url, fingerprint, close }) => {
      console.log(`[worker-proxy] ouvindo em ${url}${WORKER_PREFIX} → 127.0.0.1:${process.env.CARBON_PORT ?? DEFAULT_UPSTREAM_PORT}`);
      if (fingerprint) console.log(`[worker-proxy] certificado autoassinado · fingerprint ${fingerprint}`);
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => close().then(() => process.exit(0)));
    })
    .catch((err) => {
      console.error(`[worker-proxy] ${err.message}`);
      process.exit(1);
    });
}
