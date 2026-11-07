# Workers com Docker Compose

O kit Compose sobe N containers do worker numa máquina. Não expõe portas: o worker só abre conexões de saída para o painel, para a API do modelo e para o git.

## Gerar o kit

Pré-requisito: o listener de workers exposto ([exposing-the-panel.md](exposing-the-panel.md)). Em *Adicionar máquina → Como ela chega no painel* escolha **IP deste computador** (o kit sai com `https://<ip>:3418` e `CARBON_PANEL_FINGERPRINT`, sem URL pública; exige `CARBON_WORKER_LISTEN=0.0.0.0:3418`) ou **URL pública** (*Configurações → Execução → URL pública do painel*, `https://…`). Se a opção escolhida não é possível, o diálogo diz o motivo e o ajuste.

**Pela UI** (admin): *Configurações → Máquinas → Adicionar máquina*.

| Campo | Valor | Limite |
| --- | --- | --- |
| Nome | Livre; vira o slug dos recursos (`servidor-sp-01`) | 1–80 caracteres; slug até 40 |
| Tipo | **Docker Compose** | — |
| Réplicas | Containers `worker` | 1–100 (padrão 1) |
| Tarefas por worker | `CARBON_WORKER_PARALLEL` | 1–64 (padrão 1) |
| Executores | `claude`, `codex` | ao menos um |
| Imagem | Vazio = `carbon-worker:<versão do painel>` | referência de imagem sem espaços/aspas/`$` |

**Pela CLI** (no host do painel; grava direto no banco do painel):

```sh
node bin/carbon.mjs worker init --target compose --name servidor-sp-01 \
  --panel-url https://workers.exemplo.com \
  --replicas 2 --parallel 1 --executors claude,codex \
  --image ghcr.io/sua-org/carbon-worker:0.2.0 \
  --out ./carbon-worker-servidor-sp-01
```

`--force` sobrescreve uma pasta não vazia. O token é impresso uma vez e gravado no `.env` (modo `600`).

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `docker-compose.yml` | Serviço `worker`: `env_file: .env`, `restart: unless-stopped`, `stop_grace_period: 150s`, volume `carbon-worker-<nome>` em `/home/carbon/work`, limites de CPU (2) e memória (4g), log `json-file` com rotação (10m × 3) |
| `.env` | `CARBON_PANEL_URL`, `CARBON_WORKER_TOKEN`, `CARBON_WORKER_PARALLEL`, `CARBON_WORKER_EXECUTORS` e linhas comentadas para credenciais do modelo e do git. **Único arquivo com o token.** |
| `README.md` | Passo a passo desta máquina |

## Preencher o `.env`

```sh
# Claude Code: UMA das duas
ANTHROPIC_API_KEY=...
# CLAUDE_CODE_OAUTH_TOKEN=...   # gerado com `claude setup-token`

# Codex (só se a imagem foi gerada com WITH_CODEX=true)
# OPENAI_API_KEY=...

# Git via https (clone de repositório privado e push do branch)
CARBON_GIT_TOKEN=...
CARBON_GIT_HOSTS=github.com
```

- O token git só é enviado aos hosts listados em `CARBON_GIT_HOSTS` (padrão: nenhum). Sem ele, clone de repositório público funciona, mas o push falha e o worker devolve o resultado por **bundle** (ver [security.md](security.md#token-git-e-carbon_git_hosts)).
- O agente não enxerga `CARBON_WORKER_TOKEN` nem `CARBON_GIT_TOKEN`: o worker os remove do ambiente e passa ao agente só variáveis permitidas ([security.md](security.md#isolamento-de-ambiente-do-agente)).

Todas as variáveis: [environment.md](environment.md#worker-carbon-worker).

## Imagem

A imagem **não é publicada**. Construa a partir do repositório do Carbon, na mesma versão do painel:

```sh
docker build -f deploy/worker/Dockerfile -t carbon-worker:0.2.0 .
docker build -f deploy/worker/Dockerfile --build-arg WITH_CODEX=true -t carbon-worker:0.2.0-codex .
```

Conteúdo: Node 22 (bookworm-slim), git, tini, `@anthropic-ai/claude-code` em versão fixa (`CLAUDE_CODE_VERSION`), Codex opcional (`WITH_CODEX`, `CODEX_VERSION`) e `dist/worker.mjs`. Roda como UID/GID `10001`, `CARBON_WORKER_DIR=/home/carbon/work`, `DISABLE_AUTOUPDATER=1`. O `tini` repassa o SIGTERM para o worker.

Várias máquinas: publique em um registry e use essa referência no kit.

```sh
docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 \
  -t ghcr.io/sua-org/carbon-worker:0.2.0 --push .
```

Conferir a versão: `docker run --rm carbon-worker:0.2.0 --version` → `carbon-worker 0.2.0+p1`.

## Operar

```sh
docker compose up -d                     # subir
docker compose up -d --scale worker=4    # escalar
docker compose logs -f worker            # logs (o token nunca aparece)
docker compose down                      # parar com espera
docker compose down -v                   # parar e apagar o volume de trabalho
```

**Parada.** `down` envia SIGTERM: o worker para de pegar tarefas e espera as atuais por até `CARBON_WORKER_GRACE_SECONDS` (padrão 120 s; o Compose espera 150 s antes do SIGKILL). Passado o prazo, as tarefas são canceladas e reportadas como `canceled`. Um segundo sinal encerra na hora (código 130).

**Atualizar.** Construa/puxe a nova imagem (mesma versão do painel), troque `image:` se mudou a tag e rode `docker compose up -d`. Tarefas em andamento recebem a parada com espera acima. Se o painel subir a versão do protocolo, workers antigos saem com código 2 e a mensagem `o painel exige um worker mais novo`.

**Escala.** Capacidade da máquina = réplicas × `CARBON_WORKER_PARALLEL`. Prefira **escalar por réplicas com `CARBON_WORKER_PARALLEL=1`**: tarefas no mesmo processo compartilham `HOME` e usuário (só clone e `TMPDIR` são separados por tarefa), então isolamento real é uma tarefa por container ([security.md](security.md#isolamento-de-ambiente-do-agente)). Cada tarefa roda uma CLI do agente e um clone do repositório; dimensione CPU, memória e disco do volume por isso.

## Revogar

1. Painel: *Configurações → Máquinas → Revogar*. O próximo request do worker recebe 401 e ele sai com `o painel recusou o token do worker (revogado ou inválido)`. Tarefas que ele estava rodando seguem a regra de lease vencido ([operations.md](operations.md#lease-e-worker-que-some)).
2. Na máquina: `docker compose down -v` e apague o `.env`.
3. Para voltar: gere um kit novo (token novo). Tokens não são reaproveitáveis nem recuperáveis.
