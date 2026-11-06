import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JoinError, normalizeFingerprint, parseJoinArgs, parseTarget, probeCertificate, resolvePin, workerEnv } from "./worker-join.mjs";
import { ensureWorkerCert } from "./worker-tls.mjs";

const FP = "5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01";
const OTHER = "ab".repeat(32);
const TOKEN = `cwk_${"x".repeat(43)}`;

describe("parseTarget", () => {
  it.each([
    ["192.168.0.12:3418", "192.168.0.12", 3418, "https://192.168.0.12:3418"],
    ["192.168.0.12", "192.168.0.12", 3418, "https://192.168.0.12:3418"],
    ["https://203.0.113.7:9000/", "203.0.113.7", 9000, "https://203.0.113.7:9000"],
    ["[fd00::5]:3418", "fd00::5", 3418, "https://[fd00::5]:3418"],
    ["painel.casa.lan:3418", "painel.casa.lan", 3418, "https://painel.casa.lan:3418"],
  ])("%s", (raw, host, port, url) => {
    expect(parseTarget(raw)).toEqual({ host, port, url });
  });

  it.each([
    ["", /informe/],
    ["http://192.168.0.12:3418", /só usa https/],
    ["https://u:p@1.2.3.4:3418", /usuário/],
    ["1.2.3.4:3418/api", /sem caminho/],
    ["ftp://1.2.3.4", /protocolo/],
  ])("rejects %s", (raw, message) => {
    expect(() => parseTarget(raw)).toThrow(message);
  });
});

describe("parseJoinArgs", () => {
  it("reads every option", () => {
    const opts = parseJoinArgs(["10.0.0.5:3418", "--fingerprint", FP.toUpperCase(), "--parallel", "2", "--executors", "codex,claude,codex", "--dir", "/tmp/w", "--token", TOKEN, "--yes"]);
    expect(opts).toEqual({ target: { host: "10.0.0.5", port: 3418, url: "https://10.0.0.5:3418" }, fingerprint: FP, token: TOKEN, parallel: "2", executors: ["codex", "claude"], dir: "/tmp/w", yes: true });
  });

  it.each([
    [[], /informe/],
    [["a:1", "b:2"], /inesperado/],
    [["a:1", "--fingerprint", "zz"], /SHA-256/],
    [["a:1", "--parallel", "x"], /inteiro/],
    [["a:1", "--executors", "gpt"], /claude,codex/],
    [["a:1", "--token", "abc"], /cwk_/],
    [["a:1", "--nope"], /desconhecida/],
    [["a:1", "--fingerprint"], /precisa de um valor/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseJoinArgs(argv)).toThrow(message);
  });
});

describe("resolvePin", () => {
  const opts = (extra = {}) => ({ ...parseJoinArgs(["10.0.0.5"]), ...extra });

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
});

describe("workerEnv", () => {
  it("sets the panel URL, token, pin and options; drops a stale pin when none is used", () => {
    const opts = parseJoinArgs(["10.0.0.5:3418", "--parallel", "3", "--executors", "claude"]);
    expect(workerEnv({ PATH: "/bin" }, opts, TOKEN, FP)).toEqual({ PATH: "/bin", CARBON_PANEL_URL: "https://10.0.0.5:3418", CARBON_WORKER_TOKEN: TOKEN, CARBON_PANEL_FINGERPRINT: FP, CARBON_WORKER_PARALLEL: "3", CARBON_WORKER_EXECUTORS: "claude" });
    expect(workerEnv({ CARBON_PANEL_FINGERPRINT: OTHER }, opts, TOKEN, null).CARBON_PANEL_FINGERPRINT).toBeUndefined();
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
