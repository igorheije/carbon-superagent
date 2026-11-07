import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkerCert } from "../../bin/worker-tls.mjs";
import { createPinnedFetch, PinMismatchError } from "./pinned-fetch";

const hasOpenssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const AUTH = `Bearer cwk_${"a".repeat(43)}`;

interface Pair {
  readonly cert: Buffer;
  readonly key: Buffer;
  readonly fingerprint: string;
}

describe.skipIf(!hasOpenssl)("createPinnedFetch (carbon join over a self-signed listener)", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-pin-"));
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  let panel: Pair;
  let impostor: Pair;
  let server: https.Server;
  let url = "";

  beforeAll(async () => {
    panel = ensureWorkerCert(path.join(sandbox, "panel")) as Pair;
    impostor = ensureWorkerCert(path.join(sandbox, "impostor")) as Pair;
    server = https.createServer({ cert: panel.cert, key: panel.key }, (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { echoed: body.length }, error: null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("talks to the panel whose certificate matches the pin (bare IP, self-signed)", async () => {
    const fetchPinned = createPinnedFetch(panel.fingerprint);
    const res = await fetchPinned(`${url}/api/worker/hello`, { method: "POST", headers: { authorization: AUTH, "content-type": "application/json" }, body: JSON.stringify({ hi: 1 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { echoed: 8 }, error: null });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/worker/hello", auth: AUTH });
  });

  it("streams a request body (bundle upload) through the pinned connection", async () => {
    const fetchPinned = createPinnedFetch(panel.fingerprint);
    const chunks = ["a".repeat(70_000), "b".repeat(70_000)];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const res = await fetchPinned(`${url}/api/worker/tasks/t1/bundle`, { method: "PUT", headers: { authorization: AUTH }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.body.length).toBe(140_000);
  });

  it("refuses a server with another certificate before sending the request (token never leaves)", async () => {
    const before = seen.length;
    const fetchPinned = createPinnedFetch(impostor.fingerprint);
    const error = await fetchPinned(`${url}/api/worker/hello`, { method: "POST", headers: { authorization: AUTH }, body: "{}" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(PinMismatchError);
    expect(seen.length).toBe(before);
  });

  it("refuses plain http and an invalid pin", async () => {
    const fetchPinned = createPinnedFetch(panel.fingerprint);
    await expect(fetchPinned(url.replace("https:", "http:"), { method: "GET" })).rejects.toThrow();
    expect(() => createPinnedFetch("nope")).toThrow(/CARBON_PANEL_FINGERPRINT/);
  });
});
