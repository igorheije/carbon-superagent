# Preparar o servidor (uma vez)

Mostre estes passos à pessoa e rode só com confirmação explícita. Os da parte **root** mudam o
sistema do servidor: em máquina com serviços em produção, a pessoa decide.

Versão de referência: Orca **v1.4.253**, a mesma do computador coordenador (`orca --version`). Versões
diferentes nas duas pontas podem recusar o pareamento.

## 1. Como root (uma vez)

```bash
useradd -m -s /bin/bash carbon && chmod 700 /home/carbon      # conta do worker: sem sudo, fora do grupo docker
install -d -m 700 -o carbon -g carbon /home/carbon/.ssh
# cole a chave PÚBLICA do coordenador (~/.ssh/id_ed25519.pub) em /home/carbon/.ssh/authorized_keys (0600, dono carbon)
apt-get install -y git xvfb        # xvfb: o orca-ide sem tela usa um display virtual
```

Alternativa ao AppImage (passo 2): `apt-get install -y ./orca-ide_1.4.253_amd64.deb`, baixado de
https://github.com/stablyai/orca/releases/tag/v1.4.253 — instala `orca-ide` para todos os usuários.

## 2. Como o usuário do worker (`su - carbon`), sem sudo

```bash
# Node 22+ na home (se ainda não houver): tar.xz linux-x64 de https://nodejs.org/dist/latest-v22.x/
mkdir -p ~/.local/node && curl -fsSL "https://nodejs.org/dist/latest-v22.x/<node-v22.x.y-linux-x64.tar.xz>" \
  | tar -xJ --strip-components=1 -C ~/.local/node
echo 'export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

npm i -g @anthropic-ai/claude-code          # NÃO faça login aqui: o login fica no coordenador

# Orca (AppImage extraído: não precisa de libfuse2)
mkdir -p ~/.local/orca ~/.local/bin && cd ~/.local/orca
curl -fLO https://github.com/stablyai/orca/releases/download/v1.4.253/orca-linux.AppImage
sha256sum orca-linux.AppImage               # compare com o publicado na release antes de executar
chmod +x orca-linux.AppImage && ./orca-linux.AppImage --appimage-extract >/dev/null
find ~/.local/orca/squashfs-root -name 'orca-ide' -type f    # ache o CLI empacotado
ln -sf <caminho-achado> ~/.local/bin/orca-ide && orca-ide --version
```

[Incerto] O caminho do CLI dentro do AppImage não está documentado; se o `find` não achar nada, use o `.deb`.

## 3. Claude Code do worker apontando para o proxy

`serve.sh` já exporta `ANTHROPIC_BASE_URL` e um token placeholder para o `orca-ide serve`. Se o agente
lançado pelo Orca não herdar esse ambiente (o `smoke test` falha com erro de autenticação), grave no
`~/.claude/settings.json` do usuário do worker:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787", "CLAUDE_CODE_OAUTH_TOKEN": "placeholder-proxy-injects-real" } }
```

Não é segredo: o proxy descarta esse valor e injeta a credencial real no computador coordenador.

## 4. Conferir

No coordenador: `"$S/scripts/preflight.sh" <nome>` deve mostrar só `OK` (e no máximo `AVISO`).
