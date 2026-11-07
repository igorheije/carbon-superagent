#!/usr/bin/env bash
# tunnel.sh start|stop|status <nome>
# ONE SSH connection (control socket) carrying both directions:
#   -R 127.0.0.1:<proxyPort>  server → this computer's auth proxy (Claude Code login stays here)
#   -L 127.0.0.1:<port>       this computer → the server's `orca-ide serve` (bound to 127.0.0.1)
# Nothing listens on a public interface on either side (ssh -R binds to loopback; GatewayPorts no).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "uso: tunnel.sh start|stop|status <nome>"
action="$1"; name="$2"
dir="$(profile_dir "$name")"
target="$(cfg_get "$name" target)"; port="$(cfg_get "$name" port)"; proxy_port="$(cfg_get "$name" proxyPort)"
sock="$dir/ssh.sock"

alive() { "$COOP_SSH" -S "$sock" -O check "$target" >/dev/null 2>&1; }

case "$action" in
  start)
    if alive; then echo "túnel já aberto"; exit 0; fi
    rm -f "$sock"
    port_in_use "$port" && die "porta local $port ocupada: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}') — escolha outra com init.sh --port"
    "$COOP_SSH" -M -S "$sock" -f -N \
      -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -R "127.0.0.1:$proxy_port:127.0.0.1:$proxy_port" \
      -L "127.0.0.1:$port:127.0.0.1:$port" \
      "$target" || die "não abriu o túnel (porta $proxy_port já usada no servidor? outro túnel aberto?)"
    alive || die "túnel caiu logo após abrir"
    echo "túnel aberto: servidor 127.0.0.1:$proxy_port → proxy local; local 127.0.0.1:$port → orca-ide serve"
    ;;
  stop)
    if alive; then "$COOP_SSH" -S "$sock" -O exit "$target" >/dev/null 2>&1; echo "túnel fechado"; else echo "túnel não estava aberto"; fi
    rm -f "$sock"
    ;;
  status)
    alive && echo "túnel: aberto ($target)" || echo "túnel: fechado"
    ;;
  *) die "ação desconhecida: $action" ;;
esac
