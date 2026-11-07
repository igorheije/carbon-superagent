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

case "$action" in
  start)
    if running; then echo "proxy já rodando (pid $(cat "$pidfile")) em 127.0.0.1:$port"; exit 0; fi
    if port_in_use "$port"; then
      # Another proxy (e.g. the Carbon panel's) already serves this port: reuse it, do not fight.
      echo "porta $port já em uso — reaproveitando o proxy que está lá ($(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'))"
      exit 0
    fi
    if [ -n "${COOP_PROXY_TOKEN_FILE:-}" ]; then source_args=(--token-file "$COOP_PROXY_TOKEN_FILE"); else source_args=(--from-claude-login); fi
    info "o macOS pode perguntar se o 'security' pode ler 'Claude Code-credentials': clique em Permitir sempre"
    nohup node "$SCRIPT_DIR/claude-auth-proxy.mjs" --port "$port" "${source_args[@]}" >>"$dir/proxy.log" 2>&1 &
    echo $! >"$pidfile"
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
    elif port_in_use "$port"; then echo "proxy: porta $port ocupada por outro processo (reaproveitado)"
    else echo "proxy: desligado"; fi
    ;;
  *) die "ação desconhecida: $action" ;;
esac
