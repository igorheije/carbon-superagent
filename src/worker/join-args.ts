import { normalizeFingerprint } from "../shared/fingerprint";
import { checkPanelUrl } from "./config";

export const JOIN_USAGE = "uso: carbon join <url-do-painel | ip[:porta]> --token cjt_… [--fingerprint <sha256>] [--name <nome>]";

/** Port of the worker listener (CARBON_WORKER_LISTEN) when the address has none. */
export const DEFAULT_LISTENER_PORT = 3418;

export interface JoinArgs {
  readonly panelUrl: string;
  readonly token: string;
  readonly name?: string;
  /** Canonical SHA-256 of the panel certificate (self-signed listener reached by IP). */
  readonly fingerprint?: string;
}

/**
 * `https://painel.exemplo.com` stays as is; a bare `ip[:porta]` / `host[:porta]` (no scheme) becomes
 * `https://ip:porta` with the listener's default port — the address `carbon start` prints.
 */
export function panelAddress(raw: string): string {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const hasPort = /^\[[^\]]+\]:\d+$/.test(text) || /^[^:[\]]+:\d+$/.test(text);
  const isBareIpv6 = !text.startsWith("[") && (text.match(/:/g)?.length ?? 0) > 1;
  const host = isBareIpv6 ? `[${text}]` : text;
  return `https://${hasPort ? text : `${host}:${DEFAULT_LISTENER_PORT}`}`;
}

const VALUE_FLAGS = new Set(["--token", "--name", "--fingerprint"]);

/**
 * Parses `join <url | ip[:porta]> --token <cjt_…> [--fingerprint <sha256>] [--name <nome>]`.
 * The token may also come from CARBON_JOIN_TOKEN.
 */
export function parseJoinArgs(argv: readonly string[], envToken?: string): JoinArgs | { readonly error: string } {
  let url: string | undefined;
  let token = envToken;
  let name: string | undefined;
  let rawFingerprint: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} precisa de um valor` };
      if (arg === "--token") token = value;
      else if (arg === "--name") name = value;
      else rawFingerprint = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { error: `opção desconhecida: ${arg}` };
    } else if (url === undefined) {
      url = arg;
    } else {
      return { error: `argumento inesperado: ${arg}` };
    }
  }
  if (!url) return { error: "falta a URL do painel" };
  const checked = checkPanelUrl(panelAddress(url));
  if (!checked.ok) return { error: `URL do painel ${checked.error}` };
  if (!token) return { error: "falta --token cjt_…" };
  let fingerprint: string | undefined;
  if (rawFingerprint !== undefined) {
    const normalized = normalizeFingerprint(rawFingerprint);
    if (!normalized) return { error: "--fingerprint precisa ser um SHA-256 (64 hex, com ou sem ':')" };
    if (!checked.url.startsWith("https:")) return { error: "--fingerprint exige o painel em https://" };
    fingerprint = normalized;
  }
  return { panelUrl: checked.url, token, ...(name ? { name } : {}), ...(fingerprint ? { fingerprint } : {}) };
}
