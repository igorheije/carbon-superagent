# Preparar o servidor (uma vez)

Servidor **Linux** (VPS, máquina dedicada): seções 1 a 5. Servidor **macOS** (outro Mac, por exemplo o de
um amigo, na mesma rede ou pela Tailscale): seção [macOS](#servidor-macos) no fim.

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

## 4. Primeira execução do Claude Code na conta do worker

O Orca abre o `claude` interativo. Na primeira vez ele mostra a tela de boas-vindas (tema) e, como o
Orca usa `--dangerously-skip-permissions`, pede para aceitar o modo sem permissões — e o worker fica
parado esperando (`agent_readiness: timeout`). Rode uma vez, **você**, como o usuário do worker, com o
túnel aberto, e responda às telas:

```bash
su - carbon    # ou ssh carbon@servidor
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 CLAUDE_CODE_OAUTH_TOKEN=placeholder-proxy-injects-real claude --dangerously-skip-permissions
# escolha o tema, aceite o aviso do modo sem permissões, saia com /exit
```

Sem terminal interativo, o equivalente (Claude Code 2.1.319) é: em `~/.claude.json`,
`"hasCompletedOnboarding": true`; em `~/.claude/settings.json`, `"skipDangerousModePermissionPrompt": true`.
Confira antes da tarefa real: `timeout 15 script -qc "claude --dangerously-skip-permissions" /dev/null` deve
abrir direto no prompt, sem aviso. O Orca desiste da tarefa depois de 3 inícios com `agent_readiness: timeout`.

Dê também uma identidade git à conta do worker, para os commits não saírem sem autor:
`git config --global user.name "worker-<servidor>" && git config --global user.email "<seu-email>"`.

Aceitar esse modo é uma decisão sua: o worker vai rodar comandos sem pedir confirmação. O que limita o
estrago é a conta sem sudo e fora do `docker`, e a spec do worker. Se preferir que ele peça permissão,
mude em **Orca → Settings** o modo das novas abas de agente no servidor (os pedidos ficam no terminal remoto).

## 5. Conferir

No coordenador: `"$S/scripts/preflight.sh" <nome>` deve mostrar só `OK` (e no máximo `AVISO`).

## Servidor macOS

Outro Mac também serve de servidor: a skill detecta o sistema e usa `orca` (com
`ORCA_SERVE_RUNTIME=orcad`, para rodar sem ninguém logado na tela) em vez de `orca-ide`, e `lsof` em vez de `ss`.
Tudo isso é feito **pelo dono do Mac**, com a sua confirmação.

1. **Usuário próprio, Padrão (sem admin).** Ajustes do Sistema → Usuários e Grupos → Adicionar Usuário →
   tipo **Padrão** (ex.: `coop`). O agente roda sem pedir permissão: um usuário Padrão não mexe no resto do Mac.
2. **Login Remoto.** Ajustes do Sistema → Geral → Compartilhamento → **Login Remoto** ligado, com
   "Permitir acesso para: **Somente estes usuários**" → só `coop`.
3. **Sua chave pública** em `/Users/coop/.ssh/authorized_keys` (dono `coop`, `chmod 600`; a pasta `.ssh` com `700`).
   Teste daqui: `ssh coop@<mac>` entra sem senha.
4. **Orca no Mac**, na **mesma versão** do seu (`orca --version`): o app em `/Applications` serve a todos os
   usuários; o CLI fica em `/Applications/Orca.app/Contents/Resources/bin/orca` (a skill já procura lá).
   Sem atualização automática nesse modo: atualize o app e reinicie o serviço.
5. **Como `coop`** (`su - coop` ou `ssh coop@<mac>`): Node 22+ na home (pacote de
   https://nodejs.org/dist/latest-v22.x/ `…-darwin-arm64.tar.xz` em `~/.local/node`, sem Homebrew/admin),
   `npm i -g @anthropic-ai/claude-code` (sem login), identidade git (`git config --global user.name/user.email`)
   e o passo 4 acima (primeira execução do Claude Code).
6. **Rede.**
   - Mesma rede local: `/carbon-coop connect coop@<nome>.local` (ou o IP do Mac).
   - Redes diferentes: [Tailscale](https://tailscale.com/) nos dois Macs e `coop@<ip 100.x>`. **Não** abra a porta 22 no roteador.
7. **Não deixar dormir** enquanto trabalha: na tomada, Ajustes → Bateria/Energia → impedir repouso automático
   (ou `caffeinate -s` numa sessão do dono). Com a tampa fechada, o Mac dorme e o túnel cai.
8. **macOS 15+:** programas iniciados pelo SSH podem perder acesso à **rede local** (TN3179 da Apple). Não
   afeta o túnel nem a API do Claude (loopback e internet); afeta só tarefas que precisem falar com outros
   aparelhos da rede.

Confira daqui: `"$S/scripts/preflight.sh" <nome>` deve mostrar `OK remoto-so Darwin`, `OK remoto-orca`
e `OK remoto-admin fora do grupo admin`.

> **Mac de outra pessoa:** ela é administradora do próprio Mac. Enquanto o túnel estiver aberto, consegue
> usar a sua conta do Claude pelo proxy (sem levar a credencial) e ler o código enviado. Use só com alguém
> de total confiança e só com repositórios que podem estar lá — nunca código ou dados de empresa/clientes.
