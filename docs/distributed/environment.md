# Referência de variáveis de ambiente e configurações

Gerada a partir do código (`src/worker/config.ts`, `src/worker/agentcore-entry.ts`, `bin/worker-proxy.mjs`, `bin/worker-tls.mjs`, `bin/worker-join.mjs`, `bin/carbon.mjs`, `src/server/direct-join.ts`, `src/server/runtimes/availability.ts`, `src/server/repo/settings.ts`, kits em `src/server/setup-kit/`).

## Worker (`carbon worker`)

Lidas por `dist/worker.mjs` (Docker, Kubernetes ou `node bin/carbon.mjs worker`). Erros de validação saem como `configuração inválida: <motivo>` e o processo termina com código 1.

| Variável | Obrigatória | Padrão | Regra / efeito |
| --- | --- | --- | --- |
| `CARBON_PANEL_URL` | sim | — | URL do painel. `https://` obrigatório fora de loopback (`127.x`, `localhost`, `*.localhost`, `::1`); sem usuário/senha na URL. IP direto vale (`https://192.168.0.12:3418`) |
| `CARBON_PANEL_FINGERPRINT` | não | — | SHA-256 do certificado do painel (64 hex, com ou sem `:`). Com ele o worker aceita o certificado autoassinado do listener e recusa qualquer outro, antes de enviar o token. Exige `https://`. Definido pelo `carbon join` |
| `CARBON_WORKER_TOKEN` | sim | — | Token da máquina, `cwk_…`. Removido do ambiente antes de iniciar o agente |
| `CARBON_WORKER_PARALLEL` | não | `1` | Tarefas simultâneas por processo, 1–64 |
| `CARBON_WORKER_EXECUTORS` | não | detectado (`claude --version`, `codex --version`) | `claude`, `codex` ou `claude,codex` |
| `CARBON_WORKER_DIR` | não | `<tmp do SO>/carbon-worker` (imagem: `/home/carbon/work`) | Pasta dos clones e bundles |
| `CARBON_WORKER_GRACE_SECONDS` | não | `120` (kit K8s: `540`) | Espera pelas tarefas no SIGTERM, 0–3600 |
| `CARBON_GIT_TOKEN` | não | — | Token para clone/push via `https://`. Removido do ambiente do agente |
| `CARBON_GIT_HOSTS` | não | vazio (token nunca enviado) | Hosts (vírgula, opcional `:porta`) para os quais `CARBON_GIT_TOKEN` pode ser enviado, só via `https://` |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` | para Claude Code | — | Login do Claude Code sem navegador (`claude setup-token` gera o OAuth token) |
| `OPENAI_API_KEY` | para Codex | — | Login do Codex |
| `NODE_EXTRA_CA_CERTS` | não | — | Variável do Node: CA extra para confiar num certificado próprio do listener (alternativa ao `CARBON_PANEL_FINGERPRINT`) |

`carbon worker --version` imprime `carbon-worker <versão>+p<protocolo>`.

## `carbon join` por IP

O [`carbon join`](cluster-join.md) aceita `ip[:porta]` além de URL ([direct-join.md](direct-join.md)):

| Opção | Variável que define | Padrão |
| --- | --- | --- |
| `<ip>[:porta]` | `CARBON_PANEL_URL` (`https://<ip>:<porta>`) | porta `3418` |
| `--token` | `CARBON_JOIN_TOKEN` | — (token de join `cjt_…`) |
| `--fingerprint` | `CARBON_PANEL_FINGERPRINT` (salvo junto da credencial do nó) | perguntado no terminal (primeiro contato) quando o certificado não é de CA; obrigatório fora de terminal |
| `--name` | `CARBON_WORKER_NAME` | hostname |
| `--yes` | — | aceita o fingerprint apresentado sem perguntar |

## Container AgentCore (`dist/agentcore.mjs`)

| Variável | Obrigatória | Padrão | Regra / efeito |
| --- | --- | --- | --- |
| `CARBON_PANEL_URL` | sim | — | `https://` do painel, sem IP privado/link-local literal; invocações com outro `panelUrl` recebem `403` |
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
| `CARBON_WORKER_TLS` | não | `auto` | `auto`: certificado autoassinado em `<pasta de dados>/worker-tls/` quando o host não é loopback (`0.0.0.0`, IP da rede). `on`: autoassinado sempre. `off`: HTTP puro (só atrás de túnel/VPN com TLS) |
| `CARBON_WORKER_TLS_CERT` | não | — | Caminho do certificado PEM; exige `CARBON_WORKER_TLS_KEY`; tem prioridade sobre o autoassinado |
| `CARBON_WORKER_TLS_KEY` | não | — | Caminho da chave PEM; exige `CARBON_WORKER_TLS_CERT` |
| `CARBON_PORT` | não | `3417` | Porta do painel para onde o listener encaminha |
| `CARBON_WORKER_MAX_CONNECTIONS` | não | `256` | Conexões abertas no total (1–100000) |
| `CARBON_WORKER_MAX_CONNECTIONS_PER_IP` | não | `32` | Conexões abertas por IP de cliente (1–100000) |

Em `carbon start`, o ambiente do processo vence o `.env.local`. Depois de abrir o listener, `carbon start` exporta para o painel `CARBON_WORKER_JOIN_PORT`, `CARBON_WORKER_JOIN_HOST`, `CARBON_WORKER_JOIN_TLS` (`self-signed`, `custom` ou `off`) e `CARBON_WORKER_JOIN_FINGERPRINT` (uso interno: alimentam os comandos de *Configurações → Máquinas → Entrar no cluster*). O certificado autoassinado exige o `openssl` no computador do painel.

## Painel

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `CARBON_PORT` | `3417` | Porta do painel (sempre em `127.0.0.1`) |
| `CARBON_DATA_DIR` | `./.carbon-data` | Banco SQLite e worktrees |
| `CARBON_SECURE_COOKIES` | — | `true` marca o cookie de sessão como `Secure` |
| `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`/`_FULL_URI`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` | — | Cadeia padrão do SDK para Invoke/Stop do AgentCore. O painel só verifica (offline) que alguma fonte existe; `~/.aws/credentials` ou `~/.aws/config` também contam |
| `AWS_ENDPOINT_URL` | — | Variável padrão do SDK; o E2E usa para apontar para um endpoint falso |
| `CARBON_CLAUDE_SHARE_PORT` | `8787` | Porta (sempre `127.0.0.1`) do proxy *Claude Code deste computador para os workers* (experimental, só macOS). Ver [ssh-tunnel-shared-claude.md](ssh-tunnel-shared-claude.md) |
| `CARBON_WORKER_CLAIM_WAIT_MS`, `CARBON_WORKER_PERMISSION_WAIT_MS` | 25 000 | Ganchos de teste: encurtam os long-polls (máximo 25 000) |

## Configurações do painel (banco, não ambiente)

Editadas em *Configurações → Execução* (exceto `workers.*`, só pela API `PUT /api/settings`).

| Chave | Padrão | Faixa | Onde na UI |
| --- | --- | --- | --- |
| `panelPublicUrl` | `""` | `https://…` | Workers e AgentCore → URL pública do painel |
| `shareClaudeLogin` | `false` | — | *Máquinas → Claude Code deste computador para os workers* (experimental): religa o proxy quando o painel sobe |
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
