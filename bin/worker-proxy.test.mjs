import { createHash } from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { createWorkerProxy, hasWorkerAuth, parseListen, workerPath } from "./worker-proxy.mjs";

const AUTH = `Bearer cwk_${"a".repeat(43)}`;

/** Upstream stand-in for Next: echoes what reached it. */
function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, bytes, sha256: hash.digest("hex") };
      seen.push(record);
      const body = JSON.stringify(record);
      res.writeHead(200, { "content-type": "application/json", "keep-alive": "timeout=99", "x-upstream": "yes" });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Raw request: http.request sends the path untouched (fetch would normalize `..`). */
function request(port, { method = "GET", path, headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { authorization: AUTH, ...headers }, agent: false }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

let upstream;
let proxy;
let proxyPort;
const logs = [];

beforeAll(async () => {
  upstream = await startUpstream();
  proxy = createWorkerProxy({ upstreamPort: upstream.port, maxBodyBytes: 4 * 1024 * 1024, log: (line) => logs.push(line) });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.server.close(r));
});

describe("workerPath", () => {
  it.each([
    "/",
    "/api/tasks",
    "/api/worker",
    "/api/worker/",
    "/api/workers/x",
    "/api/worker/../tasks",
    "/api/worker/./hello",
    "/api/worker//hello",
    "/api/worker/%2e%2e/tasks",
    "/api/worker/%2E%2E/tasks",
    "/api/worker/.%2e/tasks",
    "/api/worker/%2e./tasks",
    "/api/worker/..%2ftasks",
    "/api/worker/..%2Ftasks",
    "/api/worker/..%5ctasks",
    "/api/worker/%252e%252e/tasks",
    "/api/worker/hello%00",
    "/api/worker/..\\tasks",
    "/api%2fworker/hello",
    "/%61pi/worker/hello",
    "http://evil.example/api/worker/hello",
    "*",
  ])("rejects %s", (url) => {
    expect(workerPath(url)).toBeNull();
  });

  it("accepts canonical worker routes and keeps the query out of the path", () => {
    expect(workerPath("/api/worker/hello")).toBe("/api/worker/hello");
    expect(workerPath("/api/worker/tasks/abc-123/bundle?part=1")).toBe("/api/worker/tasks/abc-123/bundle");
  });
});

describe("parseListen", () => {
  it("parses host:port, [ipv6]:port and bare port", () => {
    expect(parseListen("0.0.0.0:3418")).toEqual({ host: "0.0.0.0", port: 3418 });
    expect(parseListen("[::1]:3418")).toEqual({ host: "::1", port: 3418 });
    expect(parseListen("3418")).toEqual({ host: "0.0.0.0", port: 3418 });
  });

  it("rejects garbage", () => {
    expect(() => parseListen("abc")).toThrow(/CARBON_WORKER_LISTEN/);
    expect(() => parseListen("0.0.0.0:70000")).toThrow();
  });
});

describe("worker proxy", () => {
  it.each(["/", "/api/tasks", "/api/worker/../tasks", "/api/worker/%2e%2e/tasks", "/api/worker/%2E%2e/tasks", "/login", "http://127.0.0.1/api/worker/hello"])(
    "returns an empty 404 for %s without touching upstream",
    async (path) => {
      const before = upstream.seen.length;
      const res = await request(proxyPort, { path });
      expect(res.status).toBe(404);
      expect(res.body).toBe("");
      expect(upstream.seen.length).toBe(before);
    },
  );

  it("forwards /api/worker/hello with body, query and forwarding headers; strips hop-by-hop", async () => {
    const res = await request(proxyPort, {
      method: "POST",
      path: "/api/worker/hello?v=1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cwk_test_secret_0123456789abcdefghij",
        "x-forwarded-for": "6.6.6.6",
        "x-custom-hop": "drop-me",
        connection: "x-custom-hop",
        "proxy-authorization": "Basic nope",
      },
      chunks: ['{"name":"w1"}'],
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(res.headers["keep-alive"]).not.toBe("timeout=99");
    const seen = JSON.parse(res.body);
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/worker/hello?v=1");
    expect(seen.bytes).toBe(13);
    expect(seen.headers.authorization).toBe("Bearer cwk_test_secret_0123456789abcdefghij");
    expect(seen.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen.headers["x-forwarded-proto"]).toBe("http");
    expect(seen.headers["x-custom-hop"]).toBeUndefined();
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
  });

  it("streams a chunked upload intact", async () => {
    const chunk = Buffer.alloc(256 * 1024, 7);
    const chunks = Array.from({ length: 8 }, () => chunk);
    const expected = createHash("sha256");
    for (const c of chunks) expected.update(c);
    const res = await request(proxyPort, {
      method: "PUT",
      path: "/api/worker/tasks/t1/bundle",
      headers: { "content-type": "application/octet-stream" },
      chunks,
    });
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.body);
    expect(seen.bytes).toBe(8 * 256 * 1024);
    expect(seen.sha256).toBe(expected.digest("hex"));
    expect(seen.headers["transfer-encoding"]).toBe("chunked");
  });

  it("rejects a declared body above the ceiling with 413", async () => {
    const res = await request(proxyPort, {
      method: "PUT",
      path: "/api/worker/tasks/t1/bundle",
      headers: { "content-length": String(5 * 1024 * 1024) },
    }).catch((err) => ({ status: 0, error: err }));
    expect(res.status).toBe(413);
  });

  it("cuts a chunked body that passes the ceiling", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const res = await request(proxyPort, {
      method: "PUT",
      path: "/api/worker/tasks/t1/bundle",
      chunks: Array.from({ length: 6 }, () => chunk),
    }).catch(() => ({ status: "reset" }));
    expect([413, "reset"]).toContain(res.status);
  });

  it("returns 502 when the panel is down", async () => {
    const dead = createWorkerProxy({ upstreamPort: 1, log: () => undefined });
    const port = await listen(dead);
    const res = await request(port, { path: "/api/worker/hello" });
    await new Promise((r) => dead.close(r));
    expect(res.status).toBe(502);
    expect(res.body).toBe("");
  });

  it("logs one line per request without Authorization or query", async () => {
    logs.length = 0;
    await request(proxyPort, { path: "/api/worker/hello?token=leak", headers: { authorization: "Bearer cwk_super_secret_0123456789abcdefgh" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/GET \/api\/worker\/hello 200/);
    expect(logs[0]).not.toContain("cwk_super_secret");
    expect(logs[0]).not.toContain("leak");
  });

  it.each([
    ["no Authorization", undefined],
    ["a session cookie style value", "Bearer abc"],
    ["a short worker token", "Bearer cwk_short"],
    ["Basic auth", "Basic Y3drXzp4"],
    ["a token with spaces", `Bearer cwk_${"a".repeat(30)} x`],
  ])("401 with an empty body for %s, without touching upstream (M4)", async (_label, authorization) => {
    const before = upstream.seen.length;
    const headers = authorization === undefined ? { authorization: "" } : { authorization };
    const res = await request(proxyPort, { path: "/api/worker/hello", headers });
    expect(res.status).toBe(401);
    expect(res.body).toBe("");
    expect(upstream.seen.length).toBe(before);
  });

  it("forwards task tokens (ctk_) too", async () => {
    const res = await request(proxyPort, { path: "/api/worker/tasks/t1/heartbeat", method: "POST", headers: { authorization: `Bearer ctk_${"b".repeat(43)}` } });
    expect(res.status).toBe(200);
  });

  it.each(["/api/worker/hello?a=<b>", "/api/worker/hello?a=b c", `/api/worker/hello?${"a".repeat(600)}`, "/api/worker/hello?a=%0d%0aX:1&\"x"])("400 for an unexpected query string %s (L3)", async (path) => {
    const before = upstream.seen.length;
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`GET ${path.replace(/ /g, "%20").replace("%20c", " c")} HTTP/1.1\r\nhost: x\r\nauthorization: ${AUTH}\r\nconnection: close\r\n\r\n`));
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(res).toMatch(/^HTTP\/1\.1 400/);
    expect(upstream.seen.length).toBe(before);
  });

  it("caps JSON routes at 1 MB while bundle uploads keep the large ceiling (M4)", async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 1);
    const json = await request(proxyPort, { method: "POST", path: "/api/worker/tasks/t1/events", headers: { "content-length": String(big.length) } }).catch(() => ({ status: "reset" }));
    expect([413, "reset"]).toContain(json.status);
    const bundle = await request(proxyPort, { method: "PUT", path: "/api/worker/tasks/t1/bundle", chunks: [big] });
    expect(bundle.status).toBe(200);
  });

  it("ends a non-bundle request that takes longer than the request timeout with 408 (M4)", async () => {
    const slow = http.createServer(() => undefined); // never answers
    const slowPort = await listen(slow);
    const quick = createWorkerProxy({ upstreamPort: slowPort, requestTimeoutMs: 200, log: () => undefined });
    const port = await listen(quick);
    const started = Date.now();
    const res = await request(port, { path: "/api/worker/claim", method: "POST" });
    expect(res.status).toBe(408);
    expect(Date.now() - started).toBeLessThan(5_000);
    quick.closeAllConnections();
    slow.closeAllConnections();
    await new Promise((r) => quick.close(r));
    await new Promise((r) => slow.close(r));
  });

  it("caps open connections per client address (M4)", async () => {
    const capped = createWorkerProxy({ upstreamPort: upstream.port, maxConnectionsPerIp: 2, log: () => undefined });
    const port = await listen(capped);
    const open = (n) => Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    })));
    const sockets = await open(3);
    const closed = await Promise.all(sockets.map((s) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      s.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    })));
    expect(closed.filter(Boolean)).toHaveLength(1);
    for (const s of sockets) s.destroy();
    capped.closeAllConnections();
    await new Promise((r) => capped.close(r));
    expect(capped.maxConnections).toBe(256);
  });
});

describe("hasWorkerAuth", () => {
  it("accepts cwk_/ctk_ bearer tokens only", () => {
    expect(hasWorkerAuth({ authorization: AUTH })).toBe(true);
    expect(hasWorkerAuth({ authorization: `Bearer ctk_${"x".repeat(20)}` })).toBe(true);
    expect(hasWorkerAuth({ authorization: `bearer cwk_${"x".repeat(20)}` })).toBe(false);
    expect(hasWorkerAuth({})).toBe(false);
  });
});
