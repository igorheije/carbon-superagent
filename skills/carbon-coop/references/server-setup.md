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
apt-get install -y git
# bibliotecas do Electron + display virtual que o orca-ide sem tela precisa (Ubuntu 20.04: 50 pacotes novos,
# nenhum removido/atualizado — confira antes com apt-get install -s)
apt-get install -y --no-install-recommends libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libcups2 libgbm1 libgtk-3-0 libxcomposite1 libxdamage1 libasound2 xvfb
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
sha256sum orca-linux.AppImage               # 1.4.253: fce9baedb617c03dde941c6a4408d5bab92d17d2bed1def4015ddbd8fa74efdc (digest da release)
chmod +x orca-linux.AppImage && ./orca-linux.AppImage --appimage-extract >/dev/null
ln -sf ~/.local/orca/squashfs-root/resources/bin/orca-ide ~/.local/bin/orca-ide && orca-ide --version
```

Na 1.4.253 o CLI fica em `squashfs-root/resources/bin/orca-ide`. Se `orca-ide --version` acusar
`error while loading shared libraries`, faltam as bibliotecas do passo 1 (`ldd ~/.local/orca/squashfs-root/orca-ide | grep "not found"`).

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
