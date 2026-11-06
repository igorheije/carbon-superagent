// `carbon join <ip>:<porta>`: connects this computer to a Carbon panel as a worker, straight to an
// IP (LAN or public) and port — no domain, tunnel or server needed. The panel's listener uses a
// self-signed certificate; this command pins its SHA-256 fingerprint (given with --fingerprint or
// confirmed on first contact, like SSH) and starts `carbon worker` with CARBON_PANEL_FINGERPRINT.
import { isIP } from "node:net";
import tls from "node:tls";

export const DEFAULT_LISTENER_PORT = 3418;
const EXECUTORS = ["claude", "codex"];
const PROBE_TIMEOUT_MS = 10_000;

export const JOIN_USAGE = `uso: carbon join <ip-ou-host>[:porta] [opções]
  --fingerprint <sha256>   fingerprint do certificado do painel (Configurações → Máquinas → Direto)
  --token <cwk_…>          token da máquina (melhor: deixe o comando perguntar ou use CARBON_WORKER_TOKEN)
  --parallel <N>           tarefas ao mesmo tempo (padrão 1)
  --executors <lista>      claude,codex (padrão: os instalados)
  --dir <pasta>            pasta de trabalho do worker
  --yes                    aceita o fingerprint apresentado sem perguntar (só em rede confiável)

exemplos:
  carbon join 192.168.0.12:3418 --fingerprint 5c18…2a01
  carbon join 203.0.113.7:3418 --fingerprint 5c18…2a01      (IP público com a porta liberada no roteador)`;

export class JoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "JoinError";
  }
}

const BOOLEAN_FLAGS = new Set(["yes"]);
const VALUE_FLAGS = new Set(["fingerprint", "token", "parallel", "executors", "dir"]);

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
 * Parses the target: `host`, `host:porta`, `[ipv6]:porta` or `https://host:porta`.
 * Returns `{ host, port, url }` with url = https://host:port (no trailing slash).
 */
export function parseTarget(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new JoinError("informe o endereço do painel (ex.: 192.168.0.12:3418)");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new JoinError(`endereço inválido: "${text}" (use ip:porta, ex.: 192.168.0.12:3418)`);
  }
  if (url.protocol === "http:") {
    throw new JoinError("carbon join só usa https: o listener do painel gera um certificado próprio. Use o endereço sem http:// (ex.: 192.168.0.12:3418)");
  }
  if (url.protocol !== "https:") throw new JoinError(`protocolo não suportado: ${url.protocol}`);
  if (url.username || url.password) throw new JoinError("o endereço não pode ter usuário/senha");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw new JoinError("use só ip:porta, sem caminho (ex.: 192.168.0.12:3418)");
  const port = url.port ? Number(url.port) : DEFAULT_LISTENER_PORT;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const shown = host.includes(":") ? `[${host}]` : host;
  return { host, port, url: `https://${shown}:${port}` };
}

/** Parses everything after `join`. Throws JoinError with a pt-BR message. */
export function parseJoinArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new JoinError(`opção desconhecida: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new JoinError(`${arg} precisa de um valor`);
    flags[key] = value;
    i += 1;
  }
  if (positional.length !== 1) throw new JoinError(positional.length === 0 ? "informe o endereço do painel (ex.: 192.168.0.12:3418)" : `argumento inesperado: ${positional[1]}`);
  const target = parseTarget(positional[0]);
  let fingerprint = null;
  if (flags.fingerprint !== undefined) {
    fingerprint = normalizeFingerprint(flags.fingerprint);
    if (!fingerprint) throw new JoinError("--fingerprint precisa ser um SHA-256 (64 caracteres hex, com ou sem ':')");
  }
  if (flags.parallel !== undefined && !/^\d+$/.test(flags.parallel)) throw new JoinError("--parallel precisa ser um inteiro ≥ 1");
  let executors = null;
  if (flags.executors !== undefined) {
    executors = [...new Set(flags.executors.split(",").map((e) => e.trim()).filter(Boolean))];
    if (executors.length === 0 || executors.some((e) => !EXECUTORS.includes(e))) throw new JoinError(`--executors aceita ${EXECUTORS.join(",")}`);
  }
  const token = flags.token?.trim();
  if (token !== undefined && !/^cwk_[A-Za-z0-9_-]{20,200}$/.test(token)) throw new JoinError("--token inválido (deve começar com cwk_)");
  return { target, fingerprint, token: token ?? null, parallel: flags.parallel ?? null, executors, dir: flags.dir ?? null, yes: flags.yes === true };
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

/** Environment for `carbon worker` (dist/worker.mjs). */
export function workerEnv(base, opts, token, pin) {
  const env = { ...base, CARBON_PANEL_URL: opts.target.url, CARBON_WORKER_TOKEN: token };
  if (pin) env.CARBON_PANEL_FINGERPRINT = pin;
  else delete env.CARBON_PANEL_FINGERPRINT;
  if (opts.parallel) env.CARBON_WORKER_PARALLEL = opts.parallel;
  if (opts.executors) env.CARBON_WORKER_EXECUTORS = opts.executors.join(",");
  if (opts.dir) env.CARBON_WORKER_DIR = opts.dir;
  return env;
}
