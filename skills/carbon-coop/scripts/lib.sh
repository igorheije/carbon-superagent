# shellcheck shell=bash
# Shared helpers for the carbon-coop scripts. Compatible with macOS bash 3.2 (no associative
# arrays, no ${var,,}). Never prints secrets: nothing here reads a token or a pairing code.

COOP_HOME="${COOP_HOME:-$HOME/.carbon-coop}"
COOP_SSH="${COOP_SSH:-ssh}"
COOP_ORCA="${COOP_ORCA:-orca}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "erro: $*" >&2; exit 1; }
info() { echo "• $*" >&2; }

# Name of a server profile: letters, digits, dash and underscore only (it becomes a path and an
# Orca environment name).
valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,40}$ ]]; }

profile_dir() {
  valid_name "$1" || die "nome inválido: '$1' (use letras, números, - e _)"
  echo "$COOP_HOME/$1"
}

# cfg_get <name> <key> — reads one field from <profile>/config.json (empty when missing).
cfg_get() {
  local file
  file="$(profile_dir "$1")/config.json"
  [ -f "$file" ] || die "servidor '$1' não configurado (rode init.sh)"
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];process.stdout.write(v===undefined||v===null?"":String(v))' "$file" "$2"
}

# Global list of repositories that must never leave this machine (~/.carbon-coop/config.json →
# blockedRepos: names or URL fragments).
blocked_repos() {
  local file="$COOP_HOME/config.json"
  [ -f "$file" ] || return 0
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const r of c.blockedRepos??[])console.log(r)' "$file"
}

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ssh to the worker account of a profile, key-only (BatchMode: never asks for a password).
remote() {
  local name="$1"; shift
  "$COOP_SSH" -o BatchMode=yes -o ConnectTimeout=15 "$(cfg_get "$name" target)" "$@"
}

# Prefix for commands run on the server: user-local Node, Claude Code and orca-ide first.
REMOTE_PATH='export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH";'
