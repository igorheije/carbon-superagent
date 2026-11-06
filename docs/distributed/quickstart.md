# Quickstart — 2 workers rodando

Dois caminhos: **A)** worker na mesma máquina do painel (sem rede, bom para testar) e **B)** workers em outra máquina com Docker Compose. Os dois usam o mesmo painel; você pode ter os dois ao mesmo tempo.

Pré-requisitos no painel: Carbon instalado e funcionando (`npm install`, `npm run setup`, `npm start`), com ao menos um projeto e um admin. Veja o [README principal](../../README.md#começar-em-2-minutos).

---

## A) Mesma máquina (≈ 5 min)

Útil para validar o fluxo. O worker fala com o painel em `http://127.0.0.1:3417` (HTTP sem TLS é aceito só em loopback).

**1. Crie a máquina e o token** (no host do painel, com o painel já iniciado ao menos uma vez):

```sh
node bin/carbon.mjs worker init --target compose --name maquina-local \
  --panel-url http://127.0.0.1:3417 --out ./worker-local
```

O comando cria a máquina no banco do painel e imprime o token **uma única vez** (`cwk_…`). Ele também fica em `./worker-local/.env` (permissão `600`). O kit Compose em si não é usado neste caminho.

**2. Suba dois workers** em dois terminais, com o mesmo token:

```sh
export CARBON_PANEL_URL=http://127.0.0.1:3417
export CARBON_WORKER_TOKEN=cwk_...            # o token do passo 1
export CARBON_WORKER_DIR=/tmp/carbon-worker-1 # use -2 no segundo terminal
node bin/carbon.mjs worker
```

Na primeira vez, `carbon worker` gera `dist/worker.mjs` (`npm run build:worker`). Os executores são detectados com `claude --version` / `codex --version`; o worker usa o login do Claude Code/Codex desta máquina. Saída esperada:

```
… [carbon-worker] carbon-worker 0.2.0+p1 · painel http://127.0.0.1:3417 · pasta /tmp/carbon-worker-1
… [carbon-worker] conectado ao painel (protocolo 1, lease 60s) · 1 slot(s) · claude
```

**3. Crie duas tarefas** com **Onde rodar → Pool de workers**. Cada worker pega uma; as duas aparecem rodando ao mesmo tempo no Mission Control, com log ao vivo. Em *Configurações → Máquinas*, a máquina aparece como **ocupada**.

**4. Entrega.** Ao terminar, o branch `agent/<tarefa>` aparece no repositório do projeto e o card **Branch e entrega** funciona como numa tarefa local.

> Um processo com `CARBON_WORKER_PARALLEL=2` faz o mesmo que dois processos. Dois processos com o mesmo token aparecem como **uma** máquina na frota.

---

## B) Outra máquina com Docker Compose (≈ 10 min)

### No host do painel

**1. Exponha só `/api/worker/*`** com o listener separado e TLS (detalhes e alternativas em [exposing-the-panel.md](exposing-the-panel.md)):

```sh
# .env.local do painel
CARBON_WORKER_LISTEN=127.0.0.1:3418
```

```sh
npm start                                       # sobe o painel e o listener
cloudflared tunnel --url http://127.0.0.1:3418  # ou Tailscale / reverse proxy com TLS
```

**2. Configure a URL pública.** *Configurações → Execução → Workers e AgentCore → URL pública do painel*: a URL `https://…` do túnel. Só `https://` é aceito.

**3. Gere o kit.** *Configurações → Máquinas → Adicionar máquina* → nome, **Docker Compose**, réplicas, tarefas por worker, executores e (opcional) imagem → **Gerar kit**. O painel mostra o token uma vez e baixa `carbon-worker-<nome>.tar.gz`.

Alternativa por CLI, no host do painel:

```sh
node bin/carbon.mjs worker init --target compose --name servidor-sp-01 \
  --panel-url https://workers.exemplo.com --replicas 2 --out ./carbon-worker-servidor-sp-01
```

### Na máquina worker

**4. Gere a imagem.** Ela não é publicada em registry; é construída a partir do repositório do Carbon, **na mesma versão do painel**:

```sh
git clone https://github.com/leolegends/carbon-superagent.git && cd carbon-superagent
git checkout <mesma versão/commit do painel>
docker build -f deploy/worker/Dockerfile -t carbon-worker:0.2.0 .
```

Para Codex na imagem: `--build-arg WITH_CODEX=true`. Mais de uma máquina: publique num registry seu e gere o kit com o campo **Imagem** (ver [docker-compose.md](docker-compose.md#imagem)).

**5. Preencha o `.env` do kit** (copie o `.tar.gz` para a máquina e extraia):

```sh
tar xzf carbon-worker-servidor-sp-01.tar.gz && cd carbon-worker-servidor-sp-01
# edite .env: descomente UMA credencial do Claude Code
#   ANTHROPIC_API_KEY=...   ou   CLAUDE_CODE_OAUTH_TOKEN=... (gerado com `claude setup-token`)
# se usar push via https: CARBON_GIT_TOKEN=... e CARBON_GIT_HOSTS=github.com (sem a lista, o token não é enviado)
```

**6. Suba e escale:**

```sh
docker compose up -d
docker compose up -d --scale worker=2
docker compose logs -f worker
```

**7. Confira no painel:** *Configurações → Máquinas* mostra a máquina como **ociosa** (ou **ocupada**), com a última batida e a versão. Crie duas tarefas em **Pool de workers**.

---

## Se algo não funcionou

| Sintoma | Veja |
| --- | --- |
| `configuração inválida: …` ao subir o worker | [troubleshooting.md](troubleshooting.md#worker-não-sobe) |
| `o painel recusou o token do worker (revogado ou inválido)` | Token errado, revogado ou de outro painel |
| Tarefa fica em fila e nenhum worker pega | Executor da tarefa não está em `CARBON_WORKER_EXECUTORS` do worker; ver [operations.md](operations.md#fila-e-claim) |
| `worker … parou de responder` | [operations.md](operations.md#lease-e-worker-que-some) |
