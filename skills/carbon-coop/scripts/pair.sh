#!/usr/bin/env bash
# pair.sh <nome>
# Pairs this computer's Orca with the server's `orca-ide serve` (environment "coop-<nome>").
# The pairing link is a credential: it travels server → `orca environment add` inside this script,
# is never printed, and is removed from the server's log afterwards. Requires tunnel.sh start.
set -euo pipefail
set +x
source "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "uso: pair.sh <nome>"
name="$1"; dir="$(profile_dir "$name")"; env_name="$(cfg_get "$name" environment)"

if "$COOP_ORCA" environment list --json 2>/dev/null | grep -q "\"$env_name\""; then
  echo "já pareado: $env_name"; exit 0
fi

code="$(remote "$name" 'grep -o "orca://pair?[^\" ]*" ~/.carbon-coop/serve.log 2>/dev/null | tail -1' || true)"
[ -n "$code" ] || die "o servidor não tem link de pareamento: rode serve.sh stop/start $name"

if ! "$COOP_ORCA" environment add --name "$env_name" --pairing-code "$code" --json >"$dir/pair.out" 2>&1; then
  unset code
  # The error text may echo the code back: show it redacted.
  sed -E 's#orca://pair\?[^" ]*#orca://pair?<oculto>#g' "$dir/pair.out" >&2
  rm -f "$dir/pair.out"
  die "orca environment add falhou (túnel aberto? versões do Orca iguais nas duas pontas?)"
fi
unset code
sed -E 's#orca://pair\?[^" ]*#orca://pair?<oculto>#g' "$dir/pair.out" >"$dir/pair.json" && rm -f "$dir/pair.out"

# Drop the link from the server log so it does not stay on disk there.
remote "$name" 'sed -i.bak "/orca:\/\/pair/d" ~/.carbon-coop/serve.log && rm -f ~/.carbon-coop/serve.log.bak' || info "não consegui limpar o link do log do servidor: apague ~/.carbon-coop/serve.log lá"
echo "pareado: $env_name"
