#!/usr/bin/env bash
# proxy.sh start|stop|status <nome>
# Auth proxy on 127.0.0.1:<proxyPort> (this computer). It reads the Claude Code login from the
# macOS Keychain per request and injects it towards api.anthropic.com; the server only ever sends a
# placeholder. Outside macOS, set COOP_PROXY_TOKEN_FILE to a 0600 file from `claude setup-token`.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "uso: proxy.sh start|stop|status <nome>"
action="$1"; name="$2"
dir="$(profile_dir "$name")"; port="$(cfg_get "$name" proxyPort)"
pidfile="$dir/proxy.pid"

running() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
# The proxy answers GET /__carbon-auth-proxy with "carbon-auth-proxy" itself (no upstream, no credential).
is_auth_proxy() { [ "$(curl -s -m 3 "http://127.0.0.1:$1/__carbon-auth-proxy" 2>/dev/null)" = "carbon-auth-proxy" ]; }

case "$action" in
  start)
    if running; then echo "proxy já rodando (pid $(cat "$pidfile")) em 127.0.0.1:$port"; exit 0; fi
    if port_in_use "$port"; then
      # Reuse only a carbon auth proxy (e.g. the Carbon panel's), proven by its identity route: any
      # other program on this port would receive the remote workers' Claude API calls.
      if is_auth_proxy "$port"; then
        echo "porta $port já tem um carbon-auth-proxy — reaproveitando ($(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'))"
        exit 0
      fi
      die "porta $port ocupada por outro programa ($(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}')), que não é um carbon-auth-proxy: escolha outra porta com init.sh $name $(cfg_get "$name" target) --proxy-port <porta>"
    fi
    if [ -n "${COOP_PROXY_TOKEN_FILE:-}" ]; then source_args=(--token-file "$COOP_PROXY_TOKEN_FILE"); else source_args=(--from-claude-login); fi
    info "o macOS pode perguntar se o 'security' pode ler 'Claude Code-credentials': clique em Permitir sempre"
    # Detached into its own session/process group: a caller that kills its command's process group when
    # the command returns (e.g. an agent's shell tool) must not take the proxy down with it.
    node -e '
      const { spawn } = require("node:child_process"); const fs = require("node:fs");
      const [script, log, pidfile, ...args] = process.argv.slice(1);
      const out = fs.openSync(log, "a");
      const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: ["ignore", out, out] });
      fs.writeFileSync(pidfile, String(child.pid)); child.unref();
    ' "$SCRIPT_DIR/claude-auth-proxy.mjs" "$dir/proxy.log" "$pidfile" --port "$port" "${source_args[@]}"
    for _ in 1 2 3 4 5 6 7 8 9 10; do port_in_use "$port" && break; sleep 0.5; done
    running && port_in_use "$port" || { tail -5 "$dir/proxy.log" >&2; die "proxy não subiu"; }
    echo "proxy em 127.0.0.1:$port (pid $(cat "$pidfile"))"
    ;;
  stop)
    if running; then kill "$(cat "$pidfile")"; echo "proxy parado"; else echo "proxy não estava rodando (por esta skill)"; fi
    rm -f "$pidfile"
    ;;
  status)
    if running; then echo "proxy: ligado (pid $(cat "$pidfile"), 127.0.0.1:$port)"
    elif port_in_use "$port" && is_auth_proxy "$port"; then echo "proxy: carbon-auth-proxy de outro processo em 127.0.0.1:$port (reaproveitado)"
    elif port_in_use "$port"; then echo "proxy: porta $port ocupada por outro programa (não é um carbon-auth-proxy)"
    else echo "proxy: desligado"; fi
    ;;
  *) die "ação desconhecida: $action" ;;
esac
