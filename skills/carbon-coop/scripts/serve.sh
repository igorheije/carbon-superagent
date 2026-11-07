#!/usr/bin/env bash
# serve.sh start|stop|status <nome>
# Runs `orca serve` on the server (orca-ide on Linux, orca + ORCA_SERVE_RUNTIME=orcad on macOS), as the worker account, bound to 127.0.0.1 only (reached
# through the SSH tunnel). Its agents get ANTHROPIC_BASE_URL → the reverse-tunnelled auth proxy and
# a placeholder token: no Claude credential is ever written on the server.
# The startup log (~/.carbon-coop/serve.log, 0600) holds the pairing link until pair.sh redacts it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "uso: serve.sh start|stop|status <nome>"
action="$1"; name="$2"
port="$(cfg_get "$name" port)"; proxy_port="$(cfg_get "$name" proxyPort)"

case "$action" in
  start)
    remote "$name" "$REMOTE_LIB"'
      set -e
      command -v "$ORCA_BIN" >/dev/null || { echo "$ORCA_BIN não está no PATH do servidor ($COOP_OS; references/server-setup.md)" >&2; exit 2; }
      if coop_listening '"$port"'; then echo "porta '"$port"' já escutando no servidor (orca serve já rodando?)"; exit 0; fi
      mkdir -p ~/.carbon-coop && chmod 700 ~/.carbon-coop
      umask 077; : > ~/.carbon-coop/serve.log
      ANTHROPIC_BASE_URL=http://127.0.0.1:'"$proxy_port"' \
      CLAUDE_CODE_OAUTH_TOKEN=placeholder-proxy-injects-real \
        nohup "$ORCA_BIN" serve --bind 127.0.0.1 --port '"$port"' --pairing-address 127.0.0.1 --json >> ~/.carbon-coop/serve.log 2>&1 < /dev/null &
      pid=$!
      echo $pid > ~/.carbon-coop/serve.pid
      for i in $(seq 1 60); do
        # Ready = pairing link printed AND the port accepting connections (the link can come first).
        if grep -q "orca://pair" ~/.carbon-coop/serve.log && coop_listening '"$port"'; then echo "orca serve no ar ($COOP_OS, pid $pid, 127.0.0.1:'"$port"')"; exit 0; fi
        kill -0 $pid 2>/dev/null || { grep -v "orca://pair" ~/.carbon-coop/serve.log | tail -15 >&2; echo "orca serve saiu (exit 3 = já existe Orca neste perfil)" >&2; exit 3; }
        sleep 1
      done
      echo "orca serve não mostrou o link de pareamento em 60 s" >&2; exit 4'
    ;;
  stop)
    remote "$name" "$REMOTE_LIB"'
      stopped=0
      if [ -f ~/.carbon-coop/serve.pid ] && kill "$(cat ~/.carbon-coop/serve.pid)" 2>/dev/null; then stopped=1; fi
      sleep 2
      # orcad (the runtime) is a child with its own name: stop whatever of ours still listens on the port.
      for pid in $(coop_listen_pids '"$port"'); do kill "$pid" 2>/dev/null && stopped=1; done
      rm -f ~/.carbon-coop/serve.pid
      [ $stopped = 1 ] && echo "orca serve parado" || echo "orca serve não estava rodando"'
    ;;
  status)
    remote "$name" "$REMOTE_LIB"'coop_listening '"$port"' && echo "orca serve: rodando ($COOP_OS, 127.0.0.1:'"$port"')" || echo "orca serve: parado"'
    ;;
  *) die "ação desconhecida: $action" ;;
esac
