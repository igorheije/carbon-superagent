# Troubleshooting

Mensagens entre aspas são as que o Carbon imprime (log do worker, log da tarefa no painel ou resposta da API).

## Worker não sobe

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `configuração inválida: CARBON_PANEL_URL é obrigatório (ex.: https://carbon.minha-rede.local)` | Variável ausente | Defina no `.env`/Secret |
| `configuração inválida: CARBON_PANEL_URL precisa ser uma URL http(s) válida` / `não pode conter usuário/senha` | URL malformada ou com credenciais | Use `https://host[:porta]` sem `user:pass@` |
| Worker recusa URL `http://` | `https://` é obrigatório fora de loopback | Exponha por HTTPS ([exposing-the-panel.md](exposing-the-panel.md)) |
| `CARBON_WORKER_TOKEN é obrigatório (gere em Admin → Máquinas)` / `inválido (deve começar com cwk_)` | Token ausente ou colado errado (espaço, aspas) | Copie o token do kit; ele é `cwk_` + 43 caracteres |
| `nenhum executor encontrado (instale claude ou codex) — ou defina CARBON_WORKER_EXECUTORS` | CLI não está no PATH | Instale a CLI ou use a imagem do Carbon |
| `CARBON_WORKER_EXECUTORS aceita apenas claude, codex (separados por vírgula)` | Valor inválido | `claude`, `codex` ou `claude,codex` |
| `CARBON_WORKER_PARALLEL precisa ser um inteiro entre 1 e 64` | Valor fora da faixa | Ajuste |
| `dist/worker.mjs não encontrado: gerando agora…` e depois `não consegui gerar dist/worker.mjs` | Sem devDependencies | `npm install` e `npm run build:worker` |

## Worker não conecta

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `painel indisponível (<erro>); tentando de novo` em loop | Painel/listener/túnel fora do ar, DNS, firewall, certificado não confiável | `curl -I <CARBON_PANEL_URL>/` deve responder `404` (listener). Certificado próprio: `NODE_EXTRA_CA_CERTS` |
| `o painel recusou o token do worker (revogado ou inválido)`, saída com código 1 | Token revogado, de outro painel, ou banco do painel trocado | Gere um kit novo |
| `o painel exige um worker mais novo: protocolo N desatualizado…`, código 2 | Worker de versão anterior ao painel | Reconstrua a imagem na versão do painel |
| `429 muitas tentativas; aguarde 15 minutos` | Muitas falhas de autenticação com o mesmo token | Corrija o token; espere 15 min ou reinicie o painel |
| `429 muitas requisições; reduza a frequência` | > 600 requisições/min com o mesmo token (muitas réplicas com o mesmo token) | Use um token por máquina; reduza réplicas × paralelismo por token |
| Requisições chegam como `404` | Túnel apontando para o painel (3417) em vez do listener, ou caminho errado | O túnel deve ir para a porta de `CARBON_WORKER_LISTEN` |

## Tarefas não andam

| Sintoma | Causa | Correção |
| --- | --- | --- |
| "Pool de workers" desabilitado: `nenhuma máquina worker cadastrada (Admin → Máquinas)` | Sem máquina não revogada | *Configurações → Máquinas → Adicionar máquina* |
| Tarefa pool fica em fila com worker ocioso | Executor da tarefa não está nos executores do worker | Ajuste `CARBON_WORKER_EXECUTORS` ou o executor da tarefa |
| `não foi possível preparar a tarefa para o worker: …` | Erro no painel ao montar o claim | Veja o motivo; repita com "rodar de novo" |
| `o projeto desta tarefa não existe mais` | Projeto removido | — |
| `worker <nome> parou de responder (<hora>) — use “rodar de novo”` | Lease venceu: worker caiu, perdeu rede, foi revogado ou o host travou | Veja logs do worker; aumente `workers.leaseMs` se a rede é instável; `requeueOnLeaseLoss` para reenfileirar |
| `painel reiniciou durante a entrega — use “rodar de novo”` | Painel caiu enquanto importava o resultado | Rode de novo |

## Código e entrega

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `não consegui preparar o código: git clone falhou: …` | Repositório privado sem token, host fora de `CARBON_GIT_HOSTS`, rede | `CARBON_GIT_TOKEN` + `CARBON_GIT_HOSTS`, ou remova o `origin` para usar bundle |
| `não consegui baixar o código do painel: …` | Falha no `GET bundle` | Veja o log do painel; repita |
| `422` no bundle: `o repositório do projeto não é um repositório git: …` / `git bundle create falhou: …` | Caminho do projeto inválido ou git com problema no painel | Corrija o projeto em *Configurações → Projetos* |
| `o bundle não contém a base "<ref>"` | Base mudou entre o claim e o download | Rode de novo |
| `entrega falhou: push falhou: …` | Push recusado e fallback para bundle indisponível | Confira permissões do token git |
| `resultado maior que N MB` | Bundle acima de `workers.maxBundleMb` | Reduza o escopo da tarefa ou aumente `maxBundleMb` |
| `o worker não enviou o bundle do resultado (PUT bundle antes do result)` | Worker próprio enviou `result` com `transport: bundle` sem upload | Faça o `PUT` antes |
| `bundle inválido: …` / `não consegui importar o branch do bundle: …` | Bundle corrompido ou sem o branch | Rode de novo; confira o worker |
| `git fetch origin <branch> falhou: …` | Painel sem acesso ao remoto ou push não chegou | Credenciais git do painel; `git fetch` manual |
| `o branch <b> já existe no repositório com commits que não estão no resultado do worker; nada foi sobrescrito` | Branch local divergente com o mesmo nome | Renomeie/apague o branch local e rode de novo |
| `o branch <b> está em uso numa pasta (worktree); nada foi alterado` | Branch com checkout num worktree | Remova o worktree (`git worktree list`) |
| `o worker entregou o branch "<x>", mas esta tarefa usa "<y>"; nada foi importado` | Worker próprio mudou o nome do branch | Use o `branch` do claim |
| `o agente não alterou arquivos — nada a entregar` | Execução sem mudanças | — |

## Execução

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `tempo limite (N min) atingido` | `maxRunMinutes` estourado | Aumente em *Configurações → Execução* ou quebre a tarefa |
| `agente saiu com código N: …` | Erro da CLI: login do modelo ausente/expirado é o mais comum | Confira `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/`OPENAI_API_KEY` na máquina worker |
| `permissão expirou após N min sem resposta` | Ninguém respondeu o pedido | Responda mais cedo, ou ajuste regras/política |
| Agente recebe `O painel do Carbon não respondeu a este pedido de permissão…` | Painel inalcançável durante a espera | Rede/túnel |
| `o worker informou uma pergunta do agente, mas ela não chegou ao painel — use “rodar de novo”` | Eventos com a pergunta não foram entregues antes do resultado | Rode de novo; verifique a rede |
| Tarefa remota volta a rodar do zero depois de responder uma pergunta | Comportamento esperado: recomeça com as decisões no prompt | Ver [operations.md](operations.md#perguntas-do-agente-em-execução-remota) |

## AgentCore

| Sintoma | Causa | Correção |
| --- | --- | --- |
| Opção desabilitada: `AgentCore desativado nas configurações` / `configure o ARN do runtime AgentCore` / `configure a URL pública do painel…` | Configuração incompleta | *Configurações → Execução → Workers e AgentCore* |
| `credenciais AWS não encontradas nesta máquina (AWS_PROFILE, ~/.aws ou variáveis de ambiente)` | Nenhuma fonte de credencial no host do painel | `aws configure`/`aws sso login` ou variáveis |
| `AgentCore: falha ao invocar o runtime após 4 tentativas — <Erro> (HTTP N): …` | ARN/região/qualifier errados, sessão SSO expirada, permissão `bedrock-agentcore:InvokeAgentRuntime` ausente, throttling | Confira os campos e a política IAM de quem invoca |
| Tarefa fica `running` sem log | Container não alcança o painel (egress, URL, TLS) | Logs do runtime no CloudWatch (`/aws/bedrock-agentcore/runtimes/*`) |
| Container responde `403 panelUrl não autorizada neste container` | `CARBON_PANEL_URL` do runtime ≠ `panelPublicUrl` do painel | Alinhe as duas URLs e refaça o deploy |
| `409 tarefa indisponível para esta sessão` | Tarefa cancelada/já pega antes do claim do container | — |
| `deploy.sh: dist/agentcore.mjs não encontrado…` | Entrypoint não foi gerado | `npm run build:worker` na raiz do Carbon |

## Listener

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `Não consegui abrir o listener de workers: CARBON_WORKER_LISTEN inválido: "…" (use host:porta, ex. 0.0.0.0:3418)` | Formato errado | `127.0.0.1:3418` |
| `Defina CARBON_WORKER_TLS_CERT e CARBON_WORKER_TLS_KEY juntos (ou nenhum).` | Só um dos dois | Defina ambos |
| `EADDRINUSE` | Porta ocupada | Outra porta |
| Uploads grandes cortados | Proxy na frente com limite de corpo menor | Aumente o limite do proxy/túnel para ≥ `maxBundleMb` |

## Onde olhar

- Worker: `docker compose logs -f worker` · `kubectl -n carbon-<nome> logs -f -l app.kubernetes.io/name=carbon-worker`.
- Painel: terminal do `npm start` (linhas `[worker-proxy]` do listener e `[carbon]`).
- Tarefa: log no Mission Control.
- AgentCore: CloudWatch Logs.
