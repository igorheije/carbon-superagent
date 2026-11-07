#!/usr/bin/env bash
# code-sync.sh push <nome> <slug>   — sends the COMMITTED HEAD to the server as coop/base-<slug>
# code-sync.sh fetch <nome> <slug>  — brings the worker's branch coop/<slug> back as coop-<nome>/coop/<slug>
# Run inside the repository. Transport is plain git over SSH to a bare repo in the worker's home
# (~/coop/<repo>.git, with a working clone at ~/coop/<repo> that Orca uses). Uncommitted changes
# never travel. Repositories listed in ~/.carbon-coop/config.json → blockedRepos are refused.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] || die "uso: code-sync.sh push|fetch <nome> <slug>"
action="$1"; name="$2"; slug="$3"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,49}$ ]] || die "slug inválido: '$slug' (minúsculas, números e -)"
top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "rode dentro de um repositório git"
cd "$top"
repo="$(basename "$top" | tr -c 'A-Za-z0-9._\n-' '-')"
remote_name="coop-$name"
target="$(cfg_get "$name" target)"

check_blocked() {
  local origin entry
  origin="$(git remote get-url origin 2>/dev/null || true)"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ "$repo" = "$entry" ] || { [ -n "$origin" ] && [[ "$origin" == *"$entry"* ]]; }; then
      die "o repositório '$repo' está em blockedRepos: ele não sai desta máquina"
    fi
  done < <(blocked_repos)
}

case "$action" in
  push)
    check_blocked
    git rev-parse --verify -q HEAD >/dev/null || die "o repositório não tem commits: commite antes de mandar"
    if [ -n "$(git status --porcelain)" ]; then
      info "há mudanças não commitadas: elas NÃO vão para o servidor (só $(git rev-parse --short HEAD))"
    fi
    remote "$name" "mkdir -p ~/coop && { [ -d ~/coop/$repo.git ] || git init -q --bare ~/coop/$repo.git; }"
    if git remote get-url "$remote_name" >/dev/null 2>&1; then
      git remote set-url "$remote_name" "$target:coop/$repo.git"
    else
      git remote add "$remote_name" "$target:coop/$repo.git"
    fi
    git push -q --force "$remote_name" "HEAD:refs/heads/coop/base-$slug"
    remote_path="$(remote "$name" "{ [ -d ~/coop/$repo/.git ] || git clone -q ~/coop/$repo.git ~/coop/$repo; } \
      && git -C ~/coop/$repo fetch -q origin '+refs/heads/coop/*:refs/remotes/origin/coop/*' && cd ~/coop/$repo && pwd")"
    echo "REPO_PATH=$remote_path"
    echo "BASE=origin/coop/base-$slug"
    echo "BRANCH=coop/$slug"
    ;;
  fetch)
    git fetch -q "$remote_name" "+refs/heads/coop/$slug:refs/remotes/$remote_name/coop/$slug" 2>/dev/null \
      || die "o servidor não tem coop/$slug: o worker ainda não fez push (peça com orca orchestration send)"
    ref="$remote_name/coop/$slug"
    echo "REF=$ref"
    git log --oneline "HEAD..$ref"
    git diff --stat "HEAD...$ref"
    ;;
  *) die "ação desconhecida: $action" ;;
esac
