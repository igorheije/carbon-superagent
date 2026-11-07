# Servidor remoto por túnel SSH + Claude Code deste computador (experimental)

Receita para usar um servidor seu (VPS, máquina dedicada) como worker **sem abrir nenhuma porta na internet** e **sem copiar credencial do Claude Code para ele**. O painel continua no seu computador; uma única conexão SSH, aberta daqui, leva dois túneis reversos.

> **Experimental.** O worker usa a **sua conta** do Claude Code (mesmo plano e mesmos limites de uso). Ligue só com máquinas que você controla.

```
seu computador (painel + login do Claude Code)          servidor
127.0.0.1:3418  listener de workers  ◀── túnel SSH ──  127.0.0.1:3418  ← carbon worker
127.0.0.1:8787  proxy de autenticação ◀── túnel SSH ──  127.0.0.1:8787  ← claude (ANTHROPIC_BASE_URL)
        │
        └─▶ api.anthropic.com (a credencial é injetada aqui, no seu computador)
```

- `ssh -R` escuta só no loopback do servidor (`GatewayPorts no`, o padrão): ninguém na internet alcança essas portas.
- O worker manda um token **placeholder**; o proxy descarta qualquer credencial recebida e injeta a real, que fica só no seu computador.
- Fechou o túnel (ou desligou o computador), o servidor perde o painel e o Claude Code ao mesmo tempo.

## 1. No servidor

Use um **usuário próprio, sem sudo e fora do grupo `docker`**: o agente executa comandos, e um servidor com serviços em produção não deve ficar ao alcance dele.

```bash
useradd -m -s /bin/bash carbon && chmod 700 /home/carbon
su - carbon
# Node 22+ (na home do usuário, sem tocar no Node do sistema), Claude Code e o Carbon na MESMA versão do painel
npm i -g @anthropic-ai/claude-code
git clone https://github.com/leolegends/carbon-superagent.git ~/carbon && cd ~/carbon && npm ci && npm run build:worker
```

Ambiente do worker (`~/.carbon-worker.env`, permissão `0600`; nenhum segredo de verdade):

```bash
CARBON_PANEL_URL=http://127.0.0.1:3418
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
CLAUDE_CODE_OAUTH_TOKEN=placeholder-proxy-injects-real
CARBON_WORKER_PARALLEL=3
CARBON_WORKER_EXECUTORS=claude
```

`http://` é aceito porque, no servidor, o painel está em loopback e o túnel SSH já cifra o tráfego.

## 2. No seu computador

`.env.local` do painel:

```bash
CARBON_WORKER_LISTEN=127.0.0.1:3418   # só loopback: o servidor chega pelo túnel
```

Suba o painel (`npm start`) e abra o túnel:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:3418:127.0.0.1:3418 -R 127.0.0.1:8787:127.0.0.1:8787 usuario@servidor
```

Para o túnel voltar sozinho, rode-o num serviço (`launchd` no macOS, `systemd --user` no Linux) com reinício automático.

## 3. Ligar o Claude Code compartilhado

*Configurações → Máquinas → **Claude Code deste computador para os workers*** → ligue o interruptor e confirme.

- Na primeira vez o macOS pergunta se o `security` pode acessar **"Claude Code-credentials"** no Keychain: clique em **Permitir sempre** (com "Permitir", ele pergunta de novo a cada leitura).
- O cartão mostra o estado, quantas chamadas passaram, quantas a API recusou e a última.
- A escolha fica salva: o proxy volta sozinho quando o painel reinicia.
- Só no macOS (o login do Claude Code fica no Keychain). Porta: `CARBON_CLAUDE_SHARE_PORT` (padrão `8787`).

Sem o painel, o mesmo proxy roda no terminal:

```bash
node bin/claude-auth-proxy.mjs --from-claude-login        # login do Claude Code deste Mac
node bin/claude-auth-proxy.mjs --token-file <arquivo-0600> # ou um token de `claude setup-token`
```

### Como o login é renovado

O proxy **só lê** o login do Keychain e **nunca renova o token por conta própria**: os refresh tokens giram, e renovar fora do Claude Code deslogaria o CLI do seu computador. Perto do vencimento, o proxy roda o `claude` local uma vez (que renova e salva), responde `503` nesse intervalo e usa o token novo na requisição seguinte. O Claude Code no worker tenta de novo sozinho.

## 4. Entrar no cluster

Gere um token de join de uso único (*Entrar no cluster*, ou `carbon join-token --rotate --ttl 1h --max-uses 1`) e, no servidor:

```bash
CARBON_JOIN_TOKEN=cjt_… node bin/carbon.mjs join http://127.0.0.1:3418 --name vps-sp-01
```

Depois do primeiro join, o serviço roda só `node bin/carbon.mjs worker` (a credencial do nó fica salva). Não deixe o token de join em disco depois de usar.

## Riscos e limites

| Ponto | O que significa |
| --- | --- |
| **Acesso à conta enquanto ligado** | Quem tiver root no servidor consegue usar o proxy pelo túnel e gastar a sua conta. Não consegue levar a credencial embora, e o acesso acaba quando o túnel cai ou o interruptor é desligado. |
| **O código vai para o servidor** | O worker recebe o repositório da tarefa (bundle ou clone). Use só com repositórios que podem estar nessa máquina. |
| **Mesma conta = mesma quota** | Mais máquinas aumentam as tarefas em paralelo e a CPU para build/testes, não o limite de uso do plano. |
| **Servidor com serviços em produção** | Mantenha o usuário do worker fora do grupo `docker` e sem sudo. Em tarefas "sem pedir permissão", comandos de infraestrutura (`docker`, `kubectl`, `terraform`) continuam pedindo permissão. |
