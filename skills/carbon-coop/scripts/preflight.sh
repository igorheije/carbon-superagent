#!/usr/bin/env bash
# preflight.sh [nome] — checks this computer and, given a profile, the server's worker account.
# Prints one line per check: "OK <item> <detalhe>", "AVISO <item> <detalhe>" or "FALTA <item> <como resolver>".
# Exit code = number of FALTA lines. Reads no secret (the Keychain check never uses -w).
set -uo pipefail
source "$(dirname "$0")/lib.sh"

missing=0
ok() { echo "OK $1 $2"; }
warn() { echo "AVISO $1 $2"; }
miss() { echo "FALTA $1 $2"; missing=$((missing + 1)); }

# --- este computador ---
if [ "$(uname -s)" = Darwin ]; then ok macos "$(sw_vers -productVersion 2>/dev/null)"; else warn macos "fora do macOS: use o proxy com --token-file (references/security.md)"; fi
for bin in ssh git; do command -v "$bin" >/dev/null 2>&1 && ok "$bin" "$(command -v "$bin")" || miss "$bin" "instale $bin"; done
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] && ok node "v$(node -p process.versions.node)" || miss node "Node 22+ (achei v$(node -p process.versions.node))"
else miss node "instale Node 22+"; fi
if command -v "$COOP_ORCA" >/dev/null 2>&1; then ok orca "$("$COOP_ORCA" --version 2>/dev/null | head -1)"; else miss orca "instale o Orca (https://github.com/stablyai/orca/releases)"; fi
command -v claude >/dev/null 2>&1 && ok claude "$(command -v claude)" || miss claude "instale e faça login no Claude Code"
if [ "$(uname -s)" = Darwin ]; then
  security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
    && ok login "item 'Claude Code-credentials' no Keychain" \
    || miss login "faça login no Claude Code (claude) neste Mac"
fi

# --- servidor ---
if [ $# -ge 1 ]; then
  name="$1"
  if remote "$name" true 2>/dev/null; then
    ok ssh "$(cfg_get "$name" target) por chave"
    # One round trip; each line "chave valor".
    facts="$(remote "$name" "$REMOTE_LIB"'
      echo "os $COOP_OS"
      echo "node $(node -v 2>/dev/null || echo -)"
      echo "claude $(command -v claude || echo -)"
      echo "git $(command -v git || echo -)"
      echo "orca $("$ORCA_BIN" --version 2>/dev/null | head -1 || echo -)"
      echo "sudo $(sudo -n true 2>/dev/null && echo sim || echo nao)"
      echo "admin $(id -Gn | tr " " "\n" | grep -qx admin && echo sim || echo nao)"
      echo "docker $(id -Gn | tr " " "\n" | grep -qx docker && echo sim || echo nao)"' 2>/dev/null)"
    while read -r key value; do
      case "$key" in
        node) [[ "$value" =~ ^v(2[2-9]|[3-9][0-9]) ]] && ok remoto-node "$value" || miss remoto-node "Node 22+ na home do usuário (references/server-setup.md)" ;;
        claude|git) [ -n "$value" ] && [ "$value" != - ] && ok "remoto-$key" "$value" || miss "remoto-$key" "references/server-setup.md" ;;
        os) case "$value" in Linux|Darwin) ok remoto-so "$value" ;; *) miss remoto-so "sistema $value não suportado (Linux ou macOS)" ;; esac ;;
        orca) [ -n "$value" ] && [ "$value" != - ] && ok remoto-orca "$value" || miss remoto-orca "Orca no PATH: orca-ide (Linux) ou orca (macOS) (references/server-setup.md)" ;;
        admin) [ "$value" = nao ] && ok remoto-admin "fora do grupo admin" || warn remoto-admin "a conta do worker é administradora (macOS): use um usuário Padrão" ;;
        sudo) [ "$value" = nao ] && ok remoto-sudo "sem sudo" || warn remoto-sudo "a conta do worker tem sudo: o agente poderia mexer no servidor" ;;
        docker) [ "$value" = nao ] && ok remoto-docker "fora do grupo docker" || warn remoto-docker "a conta do worker está no grupo docker (equivale a root)" ;;
      esac
    done <<< "$facts"
  else
    miss ssh "$(cfg_get "$name" target) não entra por chave: rode ssh-copy-id $(cfg_get "$name" target) (nunca use senha no chat)"
  fi
fi
exit "$missing"
