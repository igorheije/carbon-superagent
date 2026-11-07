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

# Local port check: lsof (macOS, most Linux) or ss (Linux without lsof).
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; fi
}

# ssh to the worker account of a profile, key-only (BatchMode: never asks for a password).
# The command always runs in bash on the server: a macOS login shell is zsh, which splits words differently.
remote() {
  local name="$1"; shift
  "$COOP_SSH" -o BatchMode=yes -o ConnectTimeout=15 "$(cfg_get "$name" target)" "bash -c $(printf '%q' "$*")"
}

# Prefix for commands run on the server (Linux or macOS). Defines:
#   PATH        user-local Node/Claude Code/Orca first, then Homebrew and the Orca.app CLI (macOS)
#   COOP_OS     Linux | Darwin (COOP_UNAME overrides, for tests)
#   ORCA_BIN    orca-ide on Linux (there `orca` is GNOME's screen reader); orca on macOS
#   ORCA_SERVE_RUNTIME=orcad on macOS: without it, a packaged app's `orca serve` needs a desktop login
#   coop_listening <port> / coop_listen_pids <port>: ss on Linux, lsof on macOS
REMOTE_LIB='export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Orca.app/Contents/Resources/bin:$PATH"
COOP_OS="${COOP_UNAME:-$(uname -s)}"
if [ "$COOP_OS" = Darwin ]; then ORCA_BIN=orca; export ORCA_SERVE_RUNTIME=orcad; else ORCA_BIN=orca-ide; fi
coop_listening() { if command -v ss >/dev/null 2>&1; then ss -tlnH "sport = :$1" | grep -q .; else lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; fi; }
coop_listen_pids() { if command -v ss >/dev/null 2>&1; then ss -tlnpH "sport = :$1" | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u; else lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u; fi; }
'

