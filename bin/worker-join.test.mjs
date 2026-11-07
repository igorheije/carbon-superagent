import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JoinError, normalizeFingerprint, planJoin, probeCertificate, probeTarget, resolvePin } from "./worker-join.mjs";
import { ensureWorkerCert } from "./worker-tls.mjs";

const FP = "5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01";
const OTHER = "ab".repeat(32);

describe("probeTarget", () => {
  it.each([
    ["192.168.0.12:3418", { host: "192.168.0.12", port: 3418 }],
    ["192.168.0.12", { host: "192.168.0.12", port: 3418 }],
    ["https://203.0.113.7:9000/", { host: "203.0.113.7", port: 9000 }],
    ["https://painel.exemplo.com", { host: "painel.exemplo.com", port: 443 }],
    ["[fd00::5]:3418", { host: "fd00::5", port: 3418 }],
    ["http://127.0.0.1:3418", null],
    ["", null],
  ])("%s", (raw, expected) => {
    expect(probeTarget(raw)).toEqual(expected);
  });
});

describe("planJoin", () => {
  it("finds the address, normalizes --fingerprint and drops --yes from what goes to the worker", () => {
    const plan = planJoin(["--token", "cjt_abc", "10.0.0.5:3418", "--fingerprint", FP.toUpperCase(), "--name", "gpu-1", "--yes"]);
    expect(plan).toEqual({
      target: { host: "10.0.0.5", port: 3418 },
      fingerprint: FP,
      yes: true,
      forward: ["--token", "cjt_abc", "10.0.0.5:3418", "--fingerprint", FP, "--name", "gpu-1"],
    });
  });

  it("http (loopback) is not probed; a bad fingerprint fails early", () => {
    expect(planJoin(["http://127.0.0.1:3418", "--token", "cjt_x"]).target).toBeNull();
    expect(() => planJoin(["10.0.0.5", "--fingerprint", "zz"])).toThrow(/SHA-256/);
  });
});

describe("resolvePin", () => {
  const opts = (extra = {}) => ({ fingerprint: null, yes: false, ...extra });

  it("given fingerprint must match what the server presents", async () => {
    await expect(resolvePin(opts({ fingerprint: FP }), { fingerprint: FP, trusted: false }, null)).resolves.toBe(FP);
    await expect(resolvePin(opts({ fingerprint: FP }), { fingerprint: OTHER, trusted: false }, null)).rejects.toThrow(/NÃO confere/);
  });

  it("CA-trusted certificate needs no pin", async () => {
    await expect(resolvePin(opts(), { fingerprint: FP, trusted: true }, null)).resolves.toBeNull();
  });

  it("first contact: asks (TOFU), --yes skips, no terminal fails", async () => {
    await expect(resolvePin(opts(), { fingerprint: FP, trusted: false }, async () => true)).resolves.toBe(FP);
    await expect(resolvePin(opts(), { fingerprint: FP, trusted: false }, async () => false)).rejects.toThrow(/não confirmado/);
    await expect(resolvePin(opts({ yes: true }), { fingerprint: FP, trusted: false }, null)).resolves.toBe(FP);
    await expect(resolvePin(opts(), { fingerprint: FP, trusted: false }, null)).rejects.toBeInstanceOf(JoinError);
  });

  it("normalizeFingerprint mirrors the TypeScript one", () => {
    expect(normalizeFingerprint(`SHA256:${FP.toUpperCase()}`)).toBe(FP);
  });
});

const hasOpenssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasOpenssl)("probeCertificate", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-join-"));
  let server;
  let pair;
  let received = 0;

  beforeAll(async () => {
    pair = ensureWorkerCert(path.join(sandbox, "tls"));
    server = tls.createServer({ cert: pair.cert, key: pair.key }, (socket) => {
      socket.on("data", () => (received += 1));
      socket.on("error", () => undefined);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("reads the fingerprint of a self-signed listener without sending data", async () => {
    const probe = await probeCertificate("127.0.0.1", server.address().port);
    expect(probe).toEqual({ fingerprint: pair.fingerprint, trusted: false });
    expect(received).toBe(0);
  });

  it("explains a refused connection", async () => {
    const closed = tls.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(probeCertificate("127.0.0.1", port)).rejects.toThrow(/recusada/);
  });
});
