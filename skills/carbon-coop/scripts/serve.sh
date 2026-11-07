#!/usr/bin/env bash
# serve.sh start|stop|status <nome>
# Runs `orca-ide serve` on the server, as the worker account, bound to 127.0.0.1 only (reached
# through the SSH tunnel). Its agents get ANTHROPIC_BASE_URL → the reverse-tunnelled auth proxy and
# a placeholder token: no Claude credential is ever written on the server.
# The startup log (~/.carbon-coop/serve.log, 0600) holds the pairing link until pair.sh redacts it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "uso: serve.sh start|stop|status <nome>"
action="$1"; name="$2"
port="$(cfg_get "$name" port)"; proxy_port="$(cfg_get "$name" proxyPort)"
match="orca-ide serve --bind 127.0.0.1 --port $port"

case "$action" in
  start)
    remote "$name" "$REMOTE_PATH"'
      set -e
      command -v orca-ide >/dev/null || { echo "orca-ide não está no PATH do servidor (references/server-setup.md)" >&2; exit 2; }
      if pgrep -u "$(id -u)" -f "'"$match"'" >/dev/null; then echo "orca-ide serve já rodando"; exit 0; fi
      mkdir -p ~/.carbon-coop && chmod 700 ~/.carbon-coop
      umask 077; : > ~/.carbon-coop/serve.log
      ANTHROPIC_BASE_URL=http://127.0.0.1:'"$proxy_port"' \
      CLAUDE_CODE_OAUTH_TOKEN=placeholder-proxy-injects-real \
        nohup '"$match"' --pairing-address 127.0.0.1 --json >> ~/.carbon-coop/serve.log 2>&1 < /dev/null &
      pid=$!
      for i in $(seq 1 60); do
        grep -q "orca://pair" ~/.carbon-coop/serve.log && { echo "orca-ide serve no ar (pid $pid, 127.0.0.1:'"$port"')"; exit 0; }
        kill -0 $pid 2>/dev/null || { grep -v "orca://pair" ~/.carbon-coop/serve.log | tail -15 >&2; echo "orca-ide serve saiu (exit 3 = já existe Orca neste perfil)" >&2; exit 3; }
        sleep 1
      done
      echo "orca-ide serve não mostrou o link de pareamento em 60 s" >&2; exit 4'
    ;;
  stop)
    remote "$name" 'pkill -u "$(id -u)" -f "'"$match"'" && echo "orca-ide serve parado" || echo "orca-ide serve não estava rodando"'
    ;;
  status)
    remote "$name" 'pgrep -u "$(id -u)" -f "'"$match"'" >/dev/null && echo "orca-ide serve: rodando" || echo "orca-ide serve: parado"'
    ;;
  *) die "ação desconhecida: $action" ;;
esac
