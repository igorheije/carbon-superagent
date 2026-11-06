# Referência de variáveis de ambiente e configurações

Gerada a partir do código (`src/worker/config.ts`, `src/worker/agentcore-entry.ts`, `bin/worker-proxy.mjs`, `bin/carbon.mjs`, `src/server/runtimes/availability.ts`, `src/server/repo/settings.ts`, kits em `src/server/setup-kit/`).

## Worker (`carbon worker`)

Lidas por `dist/worker.mjs` (Docker, Kubernetes ou `node bin/carbon.mjs worker`). Erros de validação saem como `configuração inválida: <motivo>` e o processo termina com código 1.

| Variável | Obrigatória | Padrão | Regra / efeito |
| --- | --- | --- | --- |
| `CARBON_PANEL_URL` | sim | — | URL do painel. `https://` obrigatório fora de loopback; sem usuário/senha na URL |
| `CARBON_WORKER_TOKEN` | sim | — | Token da máquina, `cwk_…`. Removido do ambiente antes de iniciar o agente |
| `CARBON_WORKER_PARALLEL` | não | `1` | Tarefas simultâneas por processo, 1–64 |
| `CARBON_WORKER_EXECUTORS` | não | detectado (`claude --version`, `codex --version`) | `claude`, `codex` ou `claude,codex` |
| `CARBON_WORKER_DIR` | não | `<tmp do SO>/carbon-worker` (imagem: `/home/carbon/work`) | Pasta dos clones e bundles |
| `CARBON_WORKER_GRACE_SECONDS` | não | `120` (kit K8s: `540`) | Espera pelas tarefas no SIGTERM, 0–3600 |
| `CARBON_GIT_TOKEN` | não | — | Token para clone/push via `https://`. Removido do ambiente do agente |
| `CARBON_GIT_HOSTS` | não | nenhum | Hosts (vírgula) para os quais `CARBON_GIT_TOKEN` pode ser enviado |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` | para Claude Code | — | Login do Claude Code sem navegador (`claude setup-token` gera o OAuth token) |
| `OPENAI_API_KEY` | para Codex | — | Login do Codex |
| `NODE_EXTRA_CA_CERTS` | não | — | Variável do Node: CA extra para confiar num certificado próprio do listener |

`carbon worker --version` imprime `carbon-worker <versão>+p<protocolo>`.

## Container AgentCore (`dist/agentcore.mjs`)

| Variável | Obrigatória | Padrão | Regra / efeito |
| --- | --- | --- | --- |
| `CARBON_PANEL_URL` | sim | — | `https://` do painel; invocações com outro `panelUrl` recebem `403` |
| `PORT` | não | `8080` | Porta HTTP (1–65535); o AgentCore exige 8080 |
| `CARBON_WORKER_DIR` | não | `<tmp>/carbon-agentcore` (imagem do kit: `/home/node/work`) | Pasta dos clones |
| `CARBON_WORKER_GRACE_SECONDS` | não | `120` (imagem do kit: `60`) | Espera pela tarefa no SIGTERM, 0–3600 |
| `CARBON_GIT_TOKEN` / `CARBON_GIT_HOSTS` | não | — | Como no worker |
| `CLAUDE_CODE_USE_BEDROCK` + `AWS_REGION` | uma das opções | — | Claude Code via Bedrock com a role do runtime |
| `ANTHROPIC_API_KEY` | uma das opções | — | Claude Code via API |

O token de tarefa vem no payload da invocação, não em variável de ambiente.

## `deploy.sh` do kit AgentCore

| Variável | Obrigatória | Padrão |
| --- | --- | --- |
| `ACCOUNT_ID` | sim | — (12 dígitos) |
| `ROLE_ARN` | sim | — |
| `REGION` | não | `sa-east-1` (ou `--region` do kit) |
| `RUNTIME_NAME` | não | `carbon_worker` |
| `REPOSITORY` | não | `carbon-agentcore` |
| `IMAGE_TAG` | não | hash curto do `git HEAD` |
| `CARBON_PANEL_URL` | não | URL do kit |
| `IDLE_TIMEOUT_SECONDS` | não | `900` |
| `MAX_LIFETIME_SECONDS` | não | `28800` (máximo) |
| `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_API_KEY`, `CARBON_GIT_TOKEN` | não | — (repassadas ao runtime se definidas) |
| `CONTEXT_DIR` | não | diretório atual (raiz do Carbon) |

## Listener de workers (`bin/worker-proxy.mjs`)

| Variável | Obrigatória | Padrão | Regra / efeito |
| --- | --- | --- | --- |
| `CARBON_WORKER_LISTEN` | para ligar | — (desligado) | `host:porta`, `[ipv6]:porta` ou só a porta (host `0.0.0.0`) |
| `CARBON_WORKER_TLS_CERT` | não | — | Caminho do certificado PEM; exige `CARBON_WORKER_TLS_KEY` |
| `CARBON_WORKER_TLS_KEY` | não | — | Caminho da chave PEM; exige `CARBON_WORKER_TLS_CERT` |
| `CARBON_PORT` | não | `3417` | Porta do painel para onde o listener encaminha |

Em `carbon start`, o ambiente do processo vence o `.env.local`.

## Painel

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `CARBON_PORT` | `3417` | Porta do painel (sempre em `127.0.0.1`) |
| `CARBON_DATA_DIR` | `./.carbon-data` | Banco SQLite e worktrees |
| `CARBON_SECURE_COOKIES` | — | `true` marca o cookie de sessão como `Secure` |
| `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`/`_FULL_URI`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` | — | Cadeia padrão do SDK para Invoke/Stop do AgentCore. O painel só verifica (offline) que alguma fonte existe; `~/.aws/credentials` ou `~/.aws/config` também contam |
| `AWS_ENDPOINT_URL` | — | Variável padrão do SDK; o E2E usa para apontar para um endpoint falso |
| `CARBON_WORKER_CLAIM_WAIT_MS`, `CARBON_WORKER_PERMISSION_WAIT_MS` | 25 000 | Ganchos de teste: encurtam os long-polls (máximo 25 000) |

## Configurações do painel (banco, não ambiente)

Editadas em *Configurações → Execução* (exceto `workers.*`, só pela API `PUT /api/settings`).

| Chave | Padrão | Faixa | Onde na UI |
| --- | --- | --- | --- |
| `panelPublicUrl` | `""` | `https://…` | Workers e AgentCore → URL pública do painel |
| `agentcore.enabled` | `false` | — | AgentCore disponível no seletor "Onde rodar" |
| `agentcore.region` | `sa-east-1` | região AWS | Região AWS |
| `agentcore.runtimeArn` | `""` | `arn:aws:bedrock-agentcore:<região>:<conta>:runtime/<id>` | ARN do runtime |
| `agentcore.qualifier` | `DEFAULT` | letras, números, `_`, `-` | Qualifier (endpoint) |
| `agentcore.maxConcurrent` | `3` | 1–20 | Sessões simultâneas (máx.) |
| `workers.leaseMs` | `60000` | 10 000–600 000 | — |
| `workers.pollMs` | `25000` | 1 000–60 000 | — |
| `workers.requeueOnLeaseLoss` | `false` | — | — |
| `workers.maxBundleMb` | `200` | 1–2000 | — |
| `maxRunMinutes` | `45` | 5–240 | Execução |
| `permissionTimeoutMinutes` | `15` | 1–120 | Execução |
