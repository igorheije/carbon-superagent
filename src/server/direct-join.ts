import "server-only";
import { networkInterfaces } from "node:os";
import { normalizeFingerprint } from "@/shared/fingerprint";

/**
 * Configurações → Máquinas → "Direto": what another computer needs for
 * `carbon join <ip>:<porta> --fingerprint …` (no domain, tunnel or server).
 *
 * `carbon start` opens the worker listener before spawning Next and exports what it bound:
 * CARBON_WORKER_JOIN_PORT / _HOST / _TLS (self-signed | custom | off) / _FINGERPRINT.
 */

export type DirectJoinInfo =
  | {
      readonly available: true;
      readonly port: number;
      /** Canonical SHA-256 of the self-signed certificate; null when the certificate comes from a CA. */
      readonly fingerprint: string | null;
      /** Addresses of this computer other machines on the network can use. */
      readonly addresses: readonly string[];
    }
  | { readonly available: false; readonly reason: string };

const NOT_LISTENING =
  "o listener de workers está desligado. No .env.local do painel defina CARBON_WORKER_LISTEN=0.0.0.0:3418 e reinicie com `npm start` (carbon start)";
const LOOPBACK_ONLY =
  "o listener só aceita conexões deste computador (CARBON_WORKER_LISTEN em 127.0.0.1, pensado para túnel). Para conectar direto por IP, use CARBON_WORKER_LISTEN=0.0.0.0:3418 e reinicie";
const NO_TLS =
  "o listener está sem TLS (CARBON_WORKER_TLS=off) e o worker não envia o token por http fora de loopback. Remova CARBON_WORKER_TLS=off e reinicie";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** Non-internal IPv4 addresses (LAN, VPN), without link-local 169.254/16. Mirrors bin/worker-tls.mjs. */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): readonly string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

const isLoopback = (host: string): boolean => /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(host);

export function directJoinInfo(env: Readonly<Record<string, string | undefined>> = process.env, interfaces?: Interfaces): DirectJoinInfo {
  const port = Number(env.CARBON_WORKER_JOIN_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { available: false, reason: NOT_LISTENING };
  const host = (env.CARBON_WORKER_JOIN_HOST ?? "").trim();
  const tls = env.CARBON_WORKER_JOIN_TLS;
  // Loopback + forced self-signed (CARBON_WORKER_TLS=on): a published container port or a local test.
  if (isLoopback(host) && tls !== "self-signed") return { available: false, reason: LOOPBACK_ONLY };
  if (tls !== "self-signed" && tls !== "custom") return { available: false, reason: NO_TLS };
  const fingerprint = tls === "self-signed" ? normalizeFingerprint(env.CARBON_WORKER_JOIN_FINGERPRINT) : null;
  if (tls === "self-signed" && !fingerprint) return { available: false, reason: NOT_LISTENING };
  const anyHost = host === "" || host === "0.0.0.0" || host === "::";
  return { available: true, port, fingerprint, addresses: anyHost ? lanAddresses(interfaces) : [host] };
}
