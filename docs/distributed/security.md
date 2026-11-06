# Segurança da execução distribuída

Ligar workers remotos muda o modelo de ameaça do Carbon: o painel deixa de ser só `127.0.0.1` e passa a ter uma superfície (`/api/worker/*`) alcançável por outras máquinas, e o código do repositório passa a sair da máquina do painel. Este documento descreve o que existe no código para conter isso e o que continua sendo responsabilidade de quem opera.

> Repositórios com dados pessoais ou de saúde: valide com quem responde por LGPD/segurança na sua empresa antes de mandar código para outras máquinas ou para a AWS.

## Modelo de ameaça

| Ativo | Ameaça | Controle |
| --- | --- | --- |
| UI e API administrativa do painel | Acesso pela internet | A UI continua em `127.0.0.1`. O listener `CARBON_WORKER_LISTEN` encaminha **só** `/api/worker/*`; o resto recebe `404`. Path traversal, forma absoluta, `CONNECT` e upgrades são recusados |
| `/api/worker/*` | Chamadas sem token / força bruta | Bearer obrigatório (formato checado no listener e no painel), mesmo `401` genérico para token inexistente, malformado ou revogado; falhas repetidas com o mesmo token → `429` por 15 min |
| `/api/worker/*` | Worker legítimo inundando o painel | Rate limit por token (600 requisições/min), corpo JSON ≤ 1 MB, limite de conexões no listener, bundle ≤ `maxBundleMb` |
| Tarefas de outros | Worker lendo/alterando tarefa que não é dele | Toda rota de tarefa exige ser dono do lease; senão `409 lease_lost` (não revela se a tarefa existe) |
| Token de worker | Vazamento | Gerado com 32 bytes aleatórios, mostrado uma vez, guardado só como sha256; revogável; nunca em log, snapshot ou mensagem de erro |
| Token de tarefa AgentCore | Reuso / uso em outra tarefa | Uso único no claim, ligado a uma tarefa, válido por `maxRunMinutes` + 30 min, revogado quando a sessão termina |
| Credenciais do modelo e do git | Agente lendo e exfiltrando | Isolamento de ambiente: o agente recebe só variáveis permitidas; tokens do Carbon são removidos do ambiente do processo |
| Token git | Envio para host errado (remoto malicioso) | `CARBON_GIT_HOSTS`: o token só vai para hosts listados (padrão: nenhum) |
| Código do repositório | Sai da máquina do painel | Inerente à funcionalidade. Só vai para máquinas que você cadastrou ou para a sua conta AWS |
| Permissões remotas | "Permitir sempre" virar porta aberta para shell arbitrário | Em execução remota, o painel recusa "sempre neste repositório" para comandos de shell/interpretador |

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

O processo do worker lê `CARBON_WORKER_TOKEN` e `CARBON_GIT_TOKEN` e os **remove do `process.env`** antes de iniciar qualquer agente. A CLI do agente roda com um ambiente montado por **allowlist** (variáveis do sistema necessárias e as credenciais do modelo); tokens do Carbon não estão nela. O token git só aparece para o processo `git` do próprio worker, via um `GIT_ASKPASS` temporário por chamada, com `credential.helper` vazio para não ser gravado.

Consequência: um repositório malicioso ou um prompt injetado não consegue ler o token da máquina pelo ambiente do agente. Ele ainda pode ler a credencial do modelo, que o agente precisa para funcionar — por isso use chaves dedicadas e com limite de gasto nas máquinas worker.

## Token git e `CARBON_GIT_HOSTS`

- `CARBON_GIT_HOSTS` é a lista de hosts (separados por vírgula, ex.: `github.com,gitlab.empresa.com`) para os quais o worker pode enviar `CARBON_GIT_TOKEN`. **Padrão: nenhum** — sem a variável, o token não é usado.
- O token só é usado em remotos `https://`. `protocol.ext.allow=never` e assinatura GPG desligada nas chamadas git do worker.
- Sem token aplicável: o clone de repositório público funciona; o push falha e o worker entrega por **bundle** (o painel importa o branch e faz o push/PR com as credenciais dele, se `autoPush` estiver ligado).
- Prefira tokens de escopo mínimo: só os repositórios necessários, só `contents: write` (GitHub fine-grained) ou equivalente, com expiração.

## HTTPS

- O worker exige `https://` para `CARBON_PANEL_URL` fora de loopback (`127.0.0.1`, `localhost`, `::1`).
- `panelPublicUrl` só aceita `https://`.
- O container AgentCore exige `CARBON_PANEL_URL` `https://` e recusa invocações para outro painel (`403`).

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
