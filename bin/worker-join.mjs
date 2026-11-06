// `carbon join` (cluster join, Docker Swarm style) — the part that runs before the worker starts:
// when the panel is https and its certificate is not trusted by a CA (the listener's self-signed one,
// reached as `<ip>:<porta>` with no domain), pin it. --fingerprint is checked against what the panel
// presents; without it the fingerprint is shown and confirmed on first contact (like SSH). Then
// dist/worker.mjs does the actual join (token cjt_ → node credential) with the pin.
import { isIP } from "node:net";
import tls from "node:tls";

export const DEFAULT_LISTENER_PORT = 3418;
const PROBE_TIMEOUT_MS = 10_000;

export const JOIN_HELP = `uso: carbon join <url-do-painel | ip[:porta]> --token cjt_… [opções]
  --token <cjt_…>          token de join (Configurações → Máquinas → Entrar no cluster, ou CARBON_JOIN_TOKEN)
  --fingerprint <sha256>   fingerprint do certificado do painel (listener com certificado próprio)
  --name <nome>            nome do nó no painel (padrão: hostname)
  --yes                    aceita o fingerprint apresentado sem perguntar (só em rede confiável)

exemplos:
  carbon join https://painel.exemplo.com --token cjt_…
  carbon join 192.168.0.12:3418 --token cjt_… --fingerprint 5c18…2a01   (rede local, sem domínio)
  carbon join 203.0.113.7:3418 --token cjt_… --fingerprint 5c18…2a01    (IP público, porta liberada no roteador)`;

export class JoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "JoinError";
  }
}

/** Canonical SHA-256 (64 lowercase hex), or null. Mirrors src/shared/fingerprint.ts. */
export function normalizeFingerprint(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^sha-?256(\s+fingerprint)?\s*[:= ]\s*/, "")
    .replace(/[:\s]/g, "");
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : null;
}

/**
 * Where to probe: `{ host, port }` for an https panel (bare `ip[:porta]` = https with port 3418, same
 * rule as src/worker/join-args.ts), null for http (loopback only; the worker validates it).
 */
export function probeTarget(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(withScheme ? text : `https://${text}`);
  } catch {
    return null; // the worker reports the invalid address
  }
  if (url.protocol !== "https:") return null;
  const port = url.port ? Number(url.port) : withScheme ? 443 : DEFAULT_LISTENER_PORT;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

const VALUE_FLAGS = new Set(["--token", "--name", "--fingerprint"]);

/**
 * Splits the `carbon join` argv: the panel address to probe, --fingerprint (validated) and --yes
 * (CLI only). `forward` is what goes to the worker (`dist/worker.mjs join …`), without --yes.
 */
export function planJoin(argv) {
  const forward = [];
  let address = null;
  let fingerprint = null;
  let yes = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (arg === "--fingerprint" && value !== undefined && !value.startsWith("--")) {
        fingerprint = normalizeFingerprint(value);
        if (!fingerprint) throw new JoinError("--fingerprint precisa ser um SHA-256 (64 caracteres hex, com ou sem ':')");
        forward.push(arg, fingerprint);
        i += 1;
        continue;
      }
      forward.push(arg);
      if (value !== undefined) forward.push(value);
      i += 1;
      continue;
    }
    if (!arg.startsWith("--") && address === null) address = arg;
    forward.push(arg);
  }
  return { target: address ? probeTarget(address) : null, fingerprint, yes, forward };
}

/**
 * Opens a TLS connection without sending anything and reads the certificate.
 * `trusted` = the certificate is valid for this host through the system CAs (no pin needed).
 */
export function probeCertificate(host, port, { timeoutMs = PROBE_TIMEOUT_MS, connect = tls.connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new JoinError(`sem resposta de ${host}:${port} em ${Math.round(timeoutMs / 1000)}s (painel ligado? porta liberada no firewall/roteador?)`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      const trusted = socket.authorized === true;
      socket.end();
      if (!fingerprint) reject(new JoinError("o painel não apresentou certificado"));
      else resolve({ fingerprint, trusted });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const hint =
        error.code === "ECONNREFUSED"
          ? "conexão recusada (o painel está com CARBON_WORKER_LISTEN ligado nessa porta?)"
          : error.code === "EPROTO" || /wrong version number|packet length/i.test(error.message)
            ? "o listener não está usando TLS (no painel, tire CARBON_WORKER_TLS=off e reinicie)"
            : error.message;
      reject(new JoinError(`não consegui falar com ${host}:${port}: ${hint}`));
    });
  });
}

/**
 * Decides which fingerprint to pin. `confirm(fingerprint)` asks the user (first contact, TOFU)
 * and resolves to true/false; null means "not interactive".
 * Returns the canonical fingerprint to pin, or null when the certificate is publicly trusted.
 */
export async function resolvePin(opts, probe, confirm) {
  if (opts.fingerprint) {
    if (probe.fingerprint !== opts.fingerprint) {
      throw new JoinError("o certificado apresentado NÃO confere com --fingerprint. Não conecte: confira o fingerprint em Configurações → Máquinas ou se o endereço é mesmo o do seu painel.");
    }
    return opts.fingerprint;
  }
  if (probe.trusted) return null;
  if (opts.yes) return probe.fingerprint;
  const accepted = confirm ? await confirm(probe.fingerprint) : null;
  if (accepted === null) throw new JoinError("sem --fingerprint e sem terminal para confirmar: passe --fingerprint (veja em Configurações → Máquinas)");
  if (!accepted) throw new JoinError("fingerprint não confirmado; nada foi enviado ao painel");
  return probe.fingerprint;
}

