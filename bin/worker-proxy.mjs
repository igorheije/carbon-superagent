#!/usr/bin/env node
/**
 * Public listener for remote workers (CARBON_WORKER_LISTEN).
 *
 * Forwards ONLY `/api/worker/*` to the Next server on 127.0.0.1:CARBON_PORT; every other request
 * gets an empty 404. The UI and admin API never become reachable through this port.
 * Plain Node ESM, no dependencies: imported by `bin/carbon.mjs start` and runnable on its own.
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WORKER_PREFIX = "/api/worker/";
/** Absolute ceiling; the panel enforces the real limit (settings.workers.maxBundleMb). */
export const MAX_BODY_BYTES = 1024 * 1024 * 1024;
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

/**
 * Builds the proxy server (not listening yet).
 * @param {{ upstreamPort?: number, upstreamHost?: string, tls?: { cert: string|Buffer, key: string|Buffer },
 *   maxBodyBytes?: number, headersTimeoutMs?: number, idleTimeoutMs?: number, log?: (line: string) => void }} [options]
 */
export function createWorkerProxy(options = {}) {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
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
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      req.resume();
      sendEmpty(res, 413);
      return;
    }

    const query = req.url.slice(target.length);
    const upstreamReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: target + query,
      headers: forwardHeaders(req, isTls),
    });
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
  // Uploads may legitimately take longer than any fixed total; inactivity is what we bound.
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

/**
 * Starts the proxy from env (CARBON_WORKER_LISTEN, CARBON_PORT, CARBON_WORKER_TLS_CERT/KEY).
 * Resolves with `{ server, url, close }` once listening; rejects on bad config or bind failure.
 */
export async function startWorkerProxy(env = process.env, options = {}) {
  const { host, port } = parseListen(env.CARBON_WORKER_LISTEN);
  const certPath = env.CARBON_WORKER_TLS_CERT;
  const keyPath = env.CARBON_WORKER_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("Defina CARBON_WORKER_TLS_CERT e CARBON_WORKER_TLS_KEY juntos (ou nenhum).");
  }
  const tls = certPath ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined;
  const server = createWorkerProxy({ ...options, tls, upstreamPort: Number(env.CARBON_PORT ?? DEFAULT_UPSTREAM_PORT) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const shownHost = host === "0.0.0.0" || host === "::" ? "<este-host>" : host.includes(":") ? `[${host}]` : host;
  const url = `${tls ? "https" : "http"}://${shownHost}:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { server, url, tls: Boolean(tls), close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorkerProxy()
    .then(({ url, close }) => {
      console.log(`[worker-proxy] ouvindo em ${url}${WORKER_PREFIX} → 127.0.0.1:${process.env.CARBON_PORT ?? DEFAULT_UPSTREAM_PORT}`);
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => close().then(() => process.exit(0)));
    })
    .catch((err) => {
      console.error(`[worker-proxy] ${err.message}`);
      process.exit(1);
    });
}
