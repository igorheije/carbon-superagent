/**
 * Commands shown under "Entrar no cluster" (Docker Swarm-like `join-token`). Pure: the token and the
 * URL come from the caller and are single-quoted for POSIX shells. When the panel has no public URL
 * yet, a visible placeholder is used instead of an empty argument.
 */
export const PANEL_URL_PLACEHOLDER = "https://<url-pública-do-painel>";
export const STATE_VOLUME = "carbon-worker-state";
export const STATE_DIR_IN_IMAGE = "/home/carbon/state";

export interface JoinCommandOptions {
  readonly panelUrl: string;
  readonly token: string;
  readonly image: string;
  /** SHA-256 of the listener's self-signed certificate: workers pin it (`carbon join <ip>:<porta>`). */
  readonly fingerprint?: string | null;
}

export interface JoinCommands {
  /** Native: on a server with the Carbon repo (`npm install` done). */
  readonly cli: string;
  /** Docker: one container = one node; the named volume keeps the node credential across restarts. */
  readonly docker: string;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function joinCommands(opts: JoinCommandOptions): JoinCommands {
  const url = opts.panelUrl || PANEL_URL_PLACEHOLDER;
  const pin = opts.fingerprint ? ` --fingerprint ${opts.fingerprint}` : "";
  const cli = `npx carbon join ${quote(url)} --token ${quote(opts.token)}${pin}`;
  const docker = [
    "docker run -d --name carbon-worker --restart unless-stopped \\",
    `  -e CARBON_PANEL_URL=${quote(url)} \\`,
    `  -e CARBON_JOIN_TOKEN=${quote(opts.token)} \\`,
    ...(opts.fingerprint ? [`  -e CARBON_PANEL_FINGERPRINT=${opts.fingerprint} \\`] : []),
    "  -e ANTHROPIC_API_KEY='<sua-chave>' \\",
    `  -v ${STATE_VOLUME}:${STATE_DIR_IN_IMAGE} \\`,
    `  ${opts.image}`,
  ].join("\n");
  return { cli, docker };
}

export interface DirectJoinCommands {
  /** One per address of the panel on the local network (LAN, VPN). */
  readonly lan: readonly JoinCommands[];
  /** Same, for the public IP (port forwarding on the router). */
  readonly internet: JoinCommands;
  readonly fingerprint: string | null;
}

/**
 * `carbon join <ip>:<porta>` commands when the listener is reachable by IP with its own certificate
 * (no domain, tunnel or public URL). The fingerprint goes in every command.
 */
export function directJoinCommands(opts: { readonly addresses: readonly string[]; readonly port: number; readonly fingerprint: string | null; readonly token: string; readonly image: string }): DirectJoinCommands {
  const at = (host: string): JoinCommands => joinCommands({ panelUrl: `https://${host}:${opts.port}`, token: opts.token, image: opts.image, fingerprint: opts.fingerprint });
  return { lan: opts.addresses.map(at), internet: at("<ip-público>"), fingerprint: opts.fingerprint };
}
