# Segurança da execução distribuída

Ligar workers remotos muda o modelo de ameaça do Carbon: o painel deixa de ser só `127.0.0.1` e passa a ter uma superfície (`/api/worker/*`) alcançável por outras máquinas, e o código do repositório passa a sair da máquina do painel. Este documento descreve o que existe no código para conter isso e o que continua sendo responsabilidade de quem opera.

> Repositórios com dados pessoais ou de saúde: valide com quem responde por LGPD/segurança na sua empresa antes de mandar código para outras máquinas ou para a AWS.

## Modelo de ameaça

| Ativo | Ameaça | Controle |
| --- | --- | --- |
| UI e API administrativa do painel | Acesso pela internet | A UI continua em `127.0.0.1`. O listener `CARBON_WORKER_LISTEN` encaminha **só** `/api/worker/*`; o resto recebe `404`. Path traversal, forma absoluta, `CONNECT` e upgrades são recusados |
| `/api/worker/*` | Chamadas sem token / força bruta | O listener responde `401` sem encaminhar quando falta `Authorization: Bearer cwk_…`/`ctk_…`; no painel, mesmo `401` genérico para token inexistente, malformado ou revogado; falhas repetidas com o mesmo token → `429` por 15 min; 50 falhas por IP em 15 min → `429` |
| `/api/worker/*` | Worker legítimo inundando o painel | Rate limit por token (600 requisições/min); long-polls simultâneos (claim, permissões) limitados a `max(parallel, 1) + 1` por worker → `429`; corpo JSON ≤ 1 MB; estado da tarefa ≤ 4 MB e ≤ 50 pedidos de permissão pendentes → `413`; bundle ≤ `maxBundleMb` |
| Listener público | Esgotar conexões / requisições lentas | 256 conexões no total (`CARBON_WORKER_MAX_CONNECTIONS`) e 32 por IP (`CARBON_WORKER_MAX_CONNECTIONS_PER_IP`); tempo total 60 s por requisição (30 min nas rotas de bundle) → `408`; query string só com caracteres simples → `400` |
| Tarefas de outros | Worker lendo/alterando tarefa que não é dele | Toda rota de tarefa exige ser dono do lease; senão `409 lease_lost` (não revela se a tarefa existe) |
| Token de worker | Vazamento | Gerado com 32 bytes aleatórios, mostrado uma vez, guardado só como sha256; revogável; nunca em log, snapshot ou mensagem de erro |
| Token de tarefa AgentCore | Reuso / uso em outra tarefa | Uso único no claim, ligado a uma tarefa, válido por `maxRunMinutes` + 30 min, revogado quando a sessão termina |
| Credenciais do modelo e do git | Agente lendo e exfiltrando | Isolamento de ambiente: o agente recebe só variáveis permitidas; tokens do Carbon são removidos do ambiente do processo |
| Token git | Envio para host errado (remoto malicioso) | `CARBON_GIT_HOSTS`: o token só vai para hosts listados (padrão: nenhum) |
| Código do repositório | Sai da máquina do painel | Inerente à funcionalidade. Só vai para máquinas que você cadastrou ou para a sua conta AWS |
| Permissões | "Sempre neste repositório" virar porta aberta para shell arbitrário | Para comandos cujo primeiro termo é shell, interpretador ou ferramenta de rede (`sh`, `bash`, `python`, `node`, `curl`, `ssh`, `sudo`, `env`, `xargs`…), a resposta "sempre" é rebaixada para "permitir uma vez" e nenhuma regra é salva |

Fora do escopo do Carbon: segurança do host worker (quem tem root lá lê o clone e as credenciais do modelo), do cluster Kubernetes, da conta AWS e do provedor de túnel.

## Tokens

| Token | Formato | Onde vive | Nunca |
| --- | --- | --- | --- |
| Máquina (pool) | `cwk_` + 43 base64url | `.env` (Compose, modo `600`) ou `Secret` (Kubernetes) na máquina worker; sha256 no painel | Em log, no snapshot, em kit AgentCore, em resposta da API depois da criação |
| Tarefa (AgentCore) | `ctk_` + 43 base64url | Payload do Invoke; sha256 em `task_tokens` | Reutilizável, válido para outra tarefa |
| Sessão de usuário | cookie | Navegador | Aceito em `/api/worker/*` |

A resposta de "Adicionar máquina" tem `Cache-Control: no-store`. O kit `.tar.gz` contém o token: trate o arquivo como segredo e apague depois de instalar.

## Onde ficam as credenciais

| Credencial | Onde | Observação |
| --- | --- | --- |
| Login do modelo (Claude Code / Codex) | Na máquina worker: `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`; `OPENAI_API_KEY` | Nunca sai do painel para o worker — o painel não envia credencial de modelo |
| Token git | Na máquina worker: `CARBON_GIT_TOKEN` + `CARBON_GIT_HOSTS` | Nunca no `ClaimedTask`; credenciais embutidas na URL do remoto são removidas pelo painel |
| AWS (painel → Invoke/Stop) | Cadeia padrão do SDK no host do painel | Nada de chave AWS no SQLite do Carbon |
| AWS (container AgentCore → Bedrock) | IAM role de execução do runtime | Recomendado em vez de chave de API |

## O que nunca sai do painel

- O banco SQLite (`.carbon-data/`), usuários, sessões, chaves de Linear/Jira/Slack/Telegram.
- Credenciais do modelo e do git da máquina do painel.
- O repositório local inteiro: no transporte `git` o worker clona do remoto; no `bundle`, recebe só o histórico até o commit base.
- Credenciais embutidas na URL do `origin` (`https://user:token@…`).

O que **sai**: o prompt da tarefa (descrição, contexto da base de conhecimento, decisões), arquivos de contexto (skills, mapa do projeto, memória), regras de permissão e configurações de execução.

## Isolamento de ambiente do agente

O processo do worker lê `CARBON_WORKER_TOKEN` e `CARBON_GIT_TOKEN` e os **remove do `process.env`** logo depois de ler a configuração. A CLI do agente roda com um ambiente montado por **allowlist** (`src/shared/executors/spawn.ts`):

- passam: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `TZ`, `TMPDIR`, `XDG_*`, proxies (`HTTP_PROXY`…), certificados (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`), toolchains (`JAVA_HOME`, `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `VIRTUAL_ENV`…) e os prefixos `LC_`, `ANTHROPIC_`, `CLAUDE_CODE_`, `AWS_`, `OPENAI_`, `CODEX_`;
- nunca passam: qualquer `CARBON_*`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`.

O token git só aparece para o processo `git` do próprio worker, via um `GIT_ASKPASS` temporário por chamada, com `credential.helper` vazio para não ser gravado.

Consequência: um repositório malicioso ou um prompt injetado não consegue ler o token da máquina pelo ambiente do agente. Ele ainda pode ler a credencial do modelo (e, com `AWS_*`, credenciais AWS presentes no ambiente), que o agente precisa para funcionar — use chaves dedicadas e com limite de gasto nas máquinas worker.

**Limite do isolamento entre tarefas:** cada tarefa tem o próprio clone e o próprio `TMPDIR`, mas o `HOME` **não** é isolado por tarefa. Com `CARBON_WORKER_PARALLEL` > 1, tarefas no mesmo processo compartilham `HOME` (config da CLI, caches) e o mesmo usuário do sistema, e uma pode ler o clone da outra. Isolamento real = **uma tarefa por container** (`CARBON_WORKER_PARALLEL=1`, o padrão) e escalar por réplicas.

## Token git e `CARBON_GIT_HOSTS`

- `CARBON_GIT_HOSTS` é a lista de hosts (separados por vírgula, opcionalmente `host:porta`, ex.: `github.com,gitlab.empresa.com`) para os quais o worker pode enviar `CARBON_GIT_TOKEN`. **Padrão: vazio = o token nunca é enviado.** Com token e sem hosts, o worker avisa na partida: `CARBON_GIT_TOKEN definido sem CARBON_GIT_HOSTS: o token não será enviado a nenhum remoto`; numa tarefa cujo remoto não está na lista, loga `remoto fora de CARBON_GIT_HOSTS (ou não https): token git não será enviado`.
- O token só é usado em remotos `https://` cujo host está na lista. `protocol.ext.allow=never` e assinatura GPG desligada nas chamadas git do worker.
- Sem token aplicável: o clone de repositório público funciona; o push falha e o worker entrega por **bundle** (o painel importa o branch e faz o push/PR com as credenciais dele, se `autoPush` estiver ligado).
- Prefira tokens de escopo mínimo: só os repositórios necessários, só `contents: write` (GitHub fine-grained) ou equivalente, com expiração.

## HTTPS

- O worker exige `https://` para `CARBON_PANEL_URL` fora de loopback (`127.x.x.x`, `localhost`, `*.localhost`, `::1`).
- **Certificado autoassinado + fingerprint (`carbon join`)**: com o listener em `0.0.0.0`/IP da rede, o painel gera o próprio certificado (`<pasta de dados>/worker-tls/`, pasta `0700`, chave `0600`). O worker com `CARBON_PANEL_FINGERPRINT` não consulta CA nem hostname: compara o SHA-256 do certificado recebido logo após o handshake e fecha a conexão se não bater, **antes** de escrever a requisição (o token não sai). Retomada de sessão TLS fica desligada, então todo socket passa pela comparação. Sem `--fingerprint`, o `carbon join` mostra o fingerprint e pede confirmação (confiança no primeiro contato, como no SSH); em rede que você não controla, passe sempre `--fingerprint`. Detalhes em [direct-join.md](direct-join.md#segurança).
- **Porta aberta no roteador** (IP público): só `/api/worker/*` responde, com token; o resto é `404`, sem token `401`, com limites de conexão por IP. Ainda assim é superfície exposta à internet: prefira VPN quando possível e revogue máquinas sem uso.
- `panelPublicUrl` só aceita `https://`.
- O container AgentCore exige `CARBON_PANEL_URL` (`https://`, sem IP privado/link-local literal), e recusa invocações para outro painel (`403`).
- **Não há resolução de DNS** nessas checagens: um nome de host que resolve para IP privado não é bloqueado. Só IPs literais privados são recusados (no AgentCore).

## Confiança em `X-Forwarded-For`

O limite de falhas por IP usa o último valor de `X-Forwarded-For`, que o listener sobrescreve com o IP real do socket. Isso só é seguro porque o Next escuta em `127.0.0.1` e só o listener chega até ele. **Nunca exponha a porta do painel (3417) diretamente** — nem por túnel: além da UI ficar exposta, um cliente poderia forjar `X-Forwarded-For` e driblar o limite por IP.

## Revogação

- *Configurações → Máquinas → Revogar*: o próximo request daquele token recebe `401`; o worker sai com `o painel recusou o token do worker (revogado ou inválido)`. Tarefas que ele rodava param de renovar o lease e falham (ou voltam à fila) no sweep seguinte.
- Token vazado: revogue, gere kit novo, troque também as credenciais de modelo/git daquela máquina se ela pode ter sido comprometida.
- AgentCore: tokens de tarefa são apagados quando a sessão é encerrada; desativar o AgentCore nas configurações impede novos dispatches.

## Logs

- Worker: stderr com horário; nunca imprime tokens. Erros do git passam por redação do token.
- Listener: uma linha por requisição, sem `Authorization` e sem query string.
- Dispatcher AgentCore: mensagens do SDK resumidas com `ctk_…`, `cwk_…` e chaves AWS (`AKIA…`/`ASIA…`) mascaradas.
- Eventos do agente (texto, comandos, trechos de arquivo) vão para o SQLite do painel, como nas tarefas locais, e podem conter código e segredos do repositório.

## Recomendações

1. **Exponha só o listener**, por Tailscale ou Cloudflare Tunnel, nunca a porta 3417.
2. **Uma máquina = um token.** Não reaproveite o mesmo kit em ambientes diferentes; revogue o que não usa.
3. **Chaves dedicadas** de modelo nas máquinas worker, com limite de gasto.
4. **AgentCore: Bedrock via IAM role** (`CLAUDE_CODE_USE_BEDROCK=1`) em vez de `ANTHROPIC_API_KEY` em variável de ambiente do runtime; token git, se necessário, fora de variável de ambiente visível (Secrets Manager exige mudança no container — hoje não suportado) e acesso restrito a `GetAgentRuntime`.
5. **Kubernetes:** Sealed Secrets/External Secrets para o `Secret`; restrinja o egress da `NetworkPolicy` ao painel, ao git e à API do modelo.
6. **Perfil `guarded`** e política **inteligente** para tarefas remotas; evite `unrestricted` em máquinas compartilhadas.
