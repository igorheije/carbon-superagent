import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureWorkerCert, fingerprintOf, formatFingerprint, lanAddresses } from "./worker-tls.mjs";

const hasOpenssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-worker-tls-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe.skipIf(!hasOpenssl)("ensureWorkerCert", () => {
  it("creates a private key pair once and reuses it (stable fingerprint)", () => {
    const dir = path.join(sandbox, "tls");
    const first = ensureWorkerCert(dir);
    expect(first.created).toBe(true);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(first.cert)).toBe(first.fingerprint);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "key.pem")).mode & 0o777).toBe(0o600);
    const again = ensureWorkerCert(dir);
    expect(again.created).toBe(false);
    expect(again.fingerprint).toBe(first.fingerprint);
  });
});

describe("ensureWorkerCert without openssl", () => {
  it("explains how to proceed", () => {
    const run = () => ({ error: Object.assign(new Error("spawn openssl ENOENT"), { code: "ENOENT" }), status: null, stderr: "" });
    expect(() => ensureWorkerCert(path.join(sandbox, "none"), { run })).toThrow(/openssl não encontrado.*CARBON_WORKER_TLS_CERT/);
  });
});

describe("helpers", () => {
  it("formatFingerprint and lanAddresses", () => {
    expect(formatFingerprint("ab".repeat(32))).toBe(Array(32).fill("AB").join(":"));
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "10.0.0.5", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
      old: [{ address: "192.168.1.9", family: 4, internal: false }, { address: "169.254.1.1", family: "IPv4", internal: false }],
    };
    expect(lanAddresses(interfaces)).toEqual(["10.0.0.5", "192.168.1.9"]);
  });
});
