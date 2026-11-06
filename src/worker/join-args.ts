import { checkPanelUrl } from "./config";

export const JOIN_USAGE = "uso: carbon join <url-do-painel> --token cjt_… [--name <nome>]";

export interface JoinArgs {
  readonly panelUrl: string;
  readonly token: string;
  readonly name?: string;
}

/** Parses `join <url> --token <cjt_…> [--name <nome>]`. The token may also come from CARBON_JOIN_TOKEN. */
export function parseJoinArgs(argv: readonly string[], envToken?: string): JoinArgs | { readonly error: string } {
  let url: string | undefined;
  let token = envToken;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--token" || arg === "--name") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} precisa de um valor` };
      if (arg === "--token") token = value;
      else name = value;
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
  const checked = checkPanelUrl(url);
  if (!checked.ok) return { error: `URL do painel ${checked.error}` };
  if (!token) return { error: "falta --token cjt_…" };
  return { panelUrl: checked.url, token, ...(name ? { name } : {}) };
}
