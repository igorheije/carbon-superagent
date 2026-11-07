// Self-signed TLS for the worker listener, so `carbon join <ip>:<porta>` works without a domain,
// a tunnel or a public CA. The worker pins the certificate's SHA-256 (CARBON_PANEL_FINGERPRINT)
// instead of checking a CA or the hostname — the same trust model as SSH host keys.
//
// The key pair lives in <data dir>/worker-tls/ (folder 0700, key 0600) and is reused across
// restarts: the fingerprint only changes if someone deletes the folder. Plain Node ESM; the
// certificate is generated with the `openssl` CLI (macOS/Linux ship one), no npm dependency.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

export const CERT_FILE = "cert.pem";
export const KEY_FILE = "key.pem";
const VALID_DAYS = "3650";
const SUBJECT = "/CN=carbon-worker-listener";

/** 64 lowercase hex chars, no separators (same canonical form as src/shared/fingerprint.ts). */
export function fingerprintOf(certPem) {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();
}

/** `AB:CD:…`, for humans comparing by eye. */
export function formatFingerprint(canonical) {
  return canonical.toUpperCase().match(/.{2}/g).join(":");
}

function generate(dir, run) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Generate inside a private temp folder, then rename: no half-written or world-readable key.
  const temp = mkdtempSync(path.join(dir, ".gen-"));
  try {
    const keyPath = path.join(temp, KEY_FILE);
    const certPath = path.join(temp, CERT_FILE);
    const result = run(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", VALID_DAYS, "-subj", SUBJECT],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
    );
    if (result.error || result.status !== 0 || !existsSync(keyPath) || !existsSync(certPath)) {
      const reason = result.error?.code === "ENOENT" ? "openssl não encontrado" : String(result.stderr ?? "").trim().split("\n").pop() || "openssl falhou";
      throw new Error(`não consegui gerar o certificado do listener (${reason}). Instale o openssl ou defina CARBON_WORKER_TLS_CERT/CARBON_WORKER_TLS_KEY.`);
    }
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);
    renameSync(keyPath, path.join(dir, KEY_FILE));
    renameSync(certPath, path.join(dir, CERT_FILE));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Returns the listener's self-signed key pair from `dir`, creating it on first use.
 * @returns {{ cert: Buffer, key: Buffer, fingerprint: string, created: boolean, certPath: string }}
 */
export function ensureWorkerCert(dir, { run = spawnSync } = {}) {
  const certPath = path.join(dir, CERT_FILE);
  const keyPath = path.join(dir, KEY_FILE);
  const created = !(existsSync(certPath) && existsSync(keyPath));
  if (created) generate(dir, run);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  return { cert, key, fingerprint: fingerprintOf(cert), created, certPath };
}

/** Non-internal IPv4 addresses of this machine (LAN, VPN), without link-local 169.254/16. */
export function lanAddresses(interfaces = networkInterfaces()) {
  const found = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === "number" ? `IPv${entry.family}` : entry.family;
      if (family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}
