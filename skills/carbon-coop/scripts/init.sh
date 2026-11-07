#!/usr/bin/env bash
# init.sh <nome> <usuario@host> [--port 16768] [--proxy-port 8787]
# Creates ~/.carbon-coop/<nome>/config.json (0600, no secrets): SSH target of the WORKER account,
# the port Orca serves on (same number on both ends of the tunnel) and the auth-proxy port.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -ge 2 ] || die "uso: init.sh <nome> <usuario@host> [--port N] [--proxy-port N]"
name="$1"; target="$2"; shift 2
port=16768; proxy_port=8787
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --proxy-port) proxy_port="$2"; shift 2 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[[ "$target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$ ]] || [[ "$target" =~ ^[A-Za-z0-9._-]+$ ]] || die "alvo SSH inválido: $target"
[[ "${target%%@*}" == root ]] && die "não use root como conta do worker: crie um usuário sem sudo (references/server-setup.md)"
for p in "$port" "$proxy_port"; do [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1024 ] && [ "$p" -le 65535 ] || die "porta inválida: $p"; done

dir="$(profile_dir "$name")"
mkdir -p "$dir" && chmod 700 "$COOP_HOME" "$dir"
umask 077
node -e 'const [f,name,target,port,proxyPort]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({name,target,port:Number(port),proxyPort:Number(proxyPort),environment:"coop-"+name},null,2)+"\n")' \
  "$dir/config.json" "$name" "$target" "$port" "$proxy_port"
echo "$dir/config.json"
