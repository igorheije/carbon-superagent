import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createAuthProxy, createClaudeLoginSource, EXPIRY_MARGIN_MS, forwardHeaders, parseClaudeLogin, readTokenFile } from "./claude-auth-proxy.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-auth-proxy-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function request(port, { method = "POST", path: p = "/v1/messages", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("readTokenFile", () => {
  it("reads a 0600 token and trims it", () => {
    const file = path.join(sandbox, "ok");
    writeFileSync(file, "sk-ant-oat-real\n");
    chmodSync(file, 0o600);
    expect(readTokenFile(file)).toBe("sk-ant-oat-real");
  });

  it("refuses a file readable by others", () => {
    const file = path.join(sandbox, "open");
    writeFileSync(file, "x");
    chmodSync(file, 0o644);
    expect(() => readTokenFile(file)).toThrow(/chmod 600/);
  });

  it("refuses an empty file", () => {
    const file = path.join(sandbox, "empty");
    writeFileSync(file, "  \n");
    chmodSync(file, 0o600);
    expect(() => readTokenFile(file)).toThrow(/vazio/);
  });
});

describe("forwardHeaders", () => {
  it("drops incoming credentials and hop-by-hop headers, injects the real token", () => {
    const out = forwardHeaders(
      { authorization: "Bearer fake", "x-api-key": "fake", cookie: "c", connection: "keep-alive", host: "127.0.0.1:8787", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
      "real",
      "api.anthropic.com",
    );
    expect(out).toEqual({ "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json", host: "api.anthropic.com", authorization: "Bearer real" });
  });
});

describe("createAuthProxy", () => {
  it("forwards method, path and body to the fixed upstream with the injected credential", async () => {
    let seen;
    const upstreamPort = await listen(
      http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen = { method: req.method, url: req.url, auth: req.headers.authorization, apiKey: req.headers["x-api-key"], body };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("data: ok\n\n");
        });
      }),
    );
    const proxyPort = await listen(createAuthProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, readToken: () => "real" }));

    const res = await request(proxyPort, { headers: { authorization: "Bearer placeholder", "x-api-key": "placeholder" }, body: '{"a":1}' });

    expect(res).toEqual({ status: 200, body: "data: ok\n\n" });
    expect(seen).toEqual({ method: "POST", url: "/v1/messages", auth: "Bearer real", apiKey: undefined, body: '{"a":1}' });
  });

  it("answers 503 without contacting upstream when the credential is unavailable", async () => {
    let hits = 0;
    const upstreamPort = await listen(http.createServer((_q, r) => { hits += 1; r.end(); }));
    const proxyPort = await listen(createAuthProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, readToken: () => { throw new Error("sem arquivo"); } }));

    const res = await request(proxyPort);

    expect(res.status).toBe(503);
    expect(res.body).toContain("credencial indisponível");
    expect(hits).toBe(0);
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    servers.splice(servers.indexOf(dead), 1);
    await new Promise((r) => dead.close(r));
    const proxyPort = await listen(createAuthProxy({ upstream: `http://127.0.0.1:${deadPort}`, readToken: () => "real" }));

    const res = await request(proxyPort);

    expect(res.status).toBe(502);
  });
});

describe("parseClaudeLogin", () => {
  it("extracts the access token and expiry from the Keychain JSON", () => {
    expect(parseClaudeLogin(JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: 5 } }))).toEqual({ accessToken: "tok", expiresAt: 5 });
  });

  it("rejects other shapes with a clear message", () => {
    expect(() => parseClaudeLogin("nope")).toThrow(/não é JSON/);
    expect(() => parseClaudeLogin(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toThrow(/\/login/);
  });
});

describe("createClaudeLoginSource", () => {
  const login = (accessToken, expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

  it("caches a valid token and reads the Keychain only once", () => {
    let reads = 0;
    const read = createClaudeLoginSource({ readCredentials: () => { reads += 1; return login("a", 10 * EXPIRY_MARGIN_MS); }, renew: () => {}, now: () => 0 });
    expect(read()).toBe("a");
    expect(read()).toBe("a");
    expect(reads).toBe(1);
  });

  it("never refreshes by itself: asks the local CLI once and fails until the Keychain has a new token", async () => {
    let clock = 0;
    let stored = login("old", EXPIRY_MARGIN_MS / 2);
    let renews = 0;
    let finishRenew;
    const read = createClaudeLoginSource({
      readCredentials: () => stored,
      renew: () => { renews += 1; return new Promise((r) => { finishRenew = r; }); },
      now: () => clock,
    });

    expect(() => read()).toThrow(/renovando/);
    expect(() => read()).toThrow(/renovando/);
    await Promise.resolve();
    expect(renews).toBe(1); // concurrent requests share one renewal

    stored = login("new", clock + 10 * EXPIRY_MARGIN_MS);
    finishRenew();
    expect(read()).toBe("new");
  });
});
