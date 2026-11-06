# Carbon SuperAgent

Agentes autônomos que pegam uma tarefa do **Linear**, do **GitHub**, do **Jira**, de uma menção no **Slack** ou no **Telegram** (ou escrita à mão) e entregam um commit/PR revisável — rodando no **seu computador**, com o **Claude Code** ou o **Codex** do seu plano. Sem API key extra. Quando o agente precisa decidir algo, a pergunta chega com opções: um clique, no painel ou no chat, e a tarefa continua de onde parou.

```
tarefa → intake → plan → research → code → test → review → deliver → reflect
          (worktree isolado por tarefa · você só é chamado quando precisa decidir)
```

Por padrão tudo roda local, uma tarefa por vez. Quando precisar de mais vazão, a **execução distribuída** leva tarefas para **workers** em outras máquinas (Docker Compose ou Kubernetes) e, de forma experimental, para o **AWS Bedrock AgentCore Runtime** — com o painel continuando como o lugar onde tudo aparece. Ver [Execução distribuída](#execução-distribuída).

**Site:** [carbon-superagent.vercel.app](https://carbon-superagent.vercel.app) · **Docs:** [carbon-superagent.vercel.app/docs.html](https://carbon-superagent.vercel.app/docs.html) · **Licença:** MIT

![Mission control: pipeline de agentes, fila, sessão ao vivo e plano com critérios de aceite](docs/screenshots/mission-control.png)

<table><tr>
<td><img src="docs/screenshots/knowledge.png" alt="Base de conhecimento do projeto"></td>
<td><img src="docs/screenshots/new-task.png" alt="Nova tarefa com modelo e esforço"></td>
</tr></table>

## Inspiração

O Carbon nasceu da filosofia do [**deepseek-ai/dsh-superagent-prototype**](https://github.com/deepseek-ai/dsh-superagent-prototype): um agente que leva a tarefa de ponta a ponta, com etapas explícitas (intake, plano, pesquisa, código, teste, revisão, entrega, reflexão), memória e autoaprendizado, e que só chama o humano quando há uma decisão a tomar. *Menos atenção humana, mais valor entregue.*

Aqui essa ideia virou uma plataforma web local:

- em vez de um protótipo de linha de comando, um painel com o pipeline, a sessão do agente e o plano ao vivo;
- em vez de um modelo próprio, os agentes de código que você já paga: **Claude Code** ou **Codex**;
- ligada ao seu **Linear**, **GitHub** e **Jira**, e ao **Slack** e **Telegram** do time, com uma base de conhecimento por repositório e lições que você promove.

Projeto independente, sem afiliação com DeepSeek, Anthropic ou OpenAI.

## Começar em 2 minutos

Requisitos: **Node 22.13+**, **git** e **um** agente logado: **Claude Code** ou **Codex** (não precisa dos dois; com os dois, você escolhe por tarefa).

```sh
git clone https://github.com/leolegends/carbon-superagent.git && cd carbon-superagent
npm install
npm run setup
```

O `setup` verifica a máquina, oferece instalar o agente que faltar, compila o painel e abre o navegador num assistente que cria seu perfil de admin, escolhe o agente e o repositório. Depois:

```sh
npm start        # sobe o painel em http://localhost:3417
npm run doctor   # diagnóstico do ambiente
```

> Só quer olhar? No painel, troque para **demo** no topo: simulação completa sem rodar nada.

## Como funciona

| Peça | O que faz |
| --- | --- |
| **Executores** | `claude -p … --output-format stream-json` ou `codex exec --json`. Cada CLI usa o login que já existe no seu computador; o Carbon nunca lê esses tokens. |
| **Branch por tarefa** | Cada tarefa ganha o branch `agent/<tarefa>` no seu repositório e roda num **worktree temporário** em `.carbon-data/worktrees/<tarefa>`: ele existe só enquanto o agente trabalha ou espera sua resposta. Ao terminar com tudo commitado, a pasta é removida e o branch fica; com mudança não commitada, o worktree é mantido. Seu branch atual nunca é tocado. Se a base configurada não existe, usa `origin/<base>`, o branch atual ou `main`/`master`/`develop`/`staging` e avisa no log; em repositório **sem nenhum commit**, cria um branch órfão com uma cópia dos arquivos como base (respeita `.gitignore`, ignora `node_modules`/`.venv`/builds e arquivos acima de 10 MB). |
| **Protocolo de progresso** | O agente imprime `CARBON_STAGE`, `CARBON_PLAN`, `CARBON_TESTS`, `CARBON_FINDING`, `CARBON_LESSON`, `CARBON_QUESTION` e `CARBON_OPTION`; o painel transforma isso em pipeline, plano, testes, review e perguntas ao vivo. |
| **Entrega** | O Carbon (não o agente) faz o commit no branch da tarefa. Depois, no card **Branch e entrega**, você leva as mudanças do jeito que o repositório permite: **PR** para um branch escolhido, **merge local** ou **aplicar na pasta** (ver abaixo). Com push automático ligado, o PR abre sozinho — **draft** no modo `observe`. Tarefas do Linear recebem comentário com o link; as do Jira, comentário e mudança de status. |
| **Pipeline** | Grafo ao vivo com o agente ativo animado. **Expandir** abre uma visão interativa: clique em cada etapa para ver o que o agente fez nela (métricas, plano, arquivos lidos, testes, achados, PR e o log só daquela etapa). |
| **Onde roda** | Cada tarefa escolhe **Onde rodar**: *Esta máquina* (padrão, fila serial), *Pool de workers* (processos `carbon worker` em outras máquinas, várias tarefas em paralelo) ou *AgentCore* (experimental). O executor (Claude Code ou Codex) é escolhido à parte. Ver [Execução distribuída](#execução-distribuída). |
| **Multi-agentes** | Opcional por tarefa (*Usar multi-agentes se necessário*, só Claude Code): o agente divide o trabalho independente em até 4 sub-agentes em paralelo, cada um com arquivos próprios; o principal integra e roda os testes. O painel mostra quantos sub-agentes estão rodando, com o que cada um está mexendo e quando terminam. Gasta mais tokens. |
| **Tarefa distribuída** | Opcional por tarefa (*Dividir entre os computadores do cluster*): o agente prepara a base, divide em até 4 partes que rodam ao mesmo tempo em outros computadores, junta tudo com merge, roda os testes e abre um PR só. Ver [tarefa distribuída](docs/distributed/distributed-task.md). |
| **Memória do Claude Code** | Opcional (*Configurações → Execução*): a tarefa recebe a memória que o Claude Code já guardou para aquele repositório (`~/.claude/projects/<repo>/memory`), como no terminal. Use só se o painel tiver uma única conta. |
| **Aprendizado** | O agente propõe lições; você promove ou descarta. Lições promovidas entram no prompt das próximas tarefas. Nada se autopromove. |

## Entrega: branch, aplicar, merge ou PR

Quando a tarefa termina com commit, o card **Branch e entrega** mostra o branch (`agent/<tarefa> ← base`), o commit, o tamanho do diff e se o worktree ainda existe. Para levar as mudanças, ele oferece só o que funciona no seu repositório:

| Opção | Quando aparece | O que faz |
| --- | --- | --- |
| **Abrir PR** | o repositório tem remoto | Lista os branches do remoto (com `git fetch`), sugere o destino (a base da tarefa ou o padrão do remoto) em opções rápidas e num select com todos; faz push e `gh pr create --base <destino>`, com opção de draft. |
| **Merge local** | o repositório tem commits | Merge `--no-ff` do branch da tarefa num branch local escolhido. Se for o branch aberto na sua pasta, ela precisa estar limpa; qualquer outro é mesclado num worktree temporário, sem mexer na sua pasta. Com conflito, o merge é abortado e nada muda. |
| **Aplicar na pasta** | sempre (inclusive repositório sem commits) | Aplica o diff da tarefa na pasta do projeto como mudanças não commitadas, para você revisar com `git status` e commitar. Só aplica se encaixar limpo; senão, nada é escrito. |

O branch da tarefa nunca é apagado pelo Carbon. Para ver o que mudou a qualquer momento: `git log --stat agent/<tarefa>`. No boot, worktrees de tarefas terminadas ou apagadas que estejam limpos são removidos; os que têm mudanças não commitadas ficam.

## Eficácia do agente

No Mission Control, a barra **Eficácia do agente** mostra se o Carbon está ajudando, calculada só com o que ele registra em cada tarefa do projeto carregada no painel:

| Métrica | Cálculo |
| --- | --- |
| **Sucesso** | concluídas ÷ terminadas (concluídas + falhas) |
| **Entrega** | concluídas que deixaram commit ou PR ÷ concluídas |
| **Autonomia** | terminadas sem nenhuma intervenção humana (pergunta respondida ou permissão decidida por uma pessoa) |
| **Plano cumprido** | passos confirmados pelo agente ÷ passos planejados |
| **Testes verdes** | testes passando ÷ executados, no último resultado de cada tarefa |
| **Revisão limpa** | achados CRITICAL/HIGH resolvidos ÷ todos os CRITICAL/HIGH |
| **Índice de utilidade** | média simples das métricas acima que já têm dados |
| **Eficiência** | tempo médio, custo médio, tokens médios e intervenções por tarefa |

Cada métrica mostra a base (ex.: "12 de 12 testes"); sem dados, aparece "sem dados", nunca um palpite. Tempo e custo são gravados por tarefa a partir da versão que trouxe a barra; o custo vem do Claude Code (no Codex fica vazio). O botão **como calculamos** abre as fórmulas no próprio painel.

## Quando o agente pergunta

O agente só para quando uma decisão o bloqueia. Ele envia uma pergunta por decisão (`CARBON_QUESTION`) com 2 a 4 opções (`CARBON_OPTION`), uma delas marcada como recomendada; para nomes e valores (repositório, branch, caminho) ele propõe candidatos que achou no projeto em vez de pedir para você digitar.

- A pergunta aparece num card acima do pipeline e, se configurados, no **Slack** e no **Telegram** com um botão por opção. Um clique responde; "outra resposta" abre um campo livre.
- A tarefa **continua de onde parou**, no mesmo worktree: no Claude Code a mesma sessão é retomada (`--resume`), com tudo que o agente já leu; no Codex, uma execução nova recebe as decisões no prompt.
- Respostas viram **decisões fixas**: entram em todos os prompts seguintes da tarefa, inclusive em "rodar de novo", para o agente não perguntar a mesma coisa duas vezes.

## Descrição gerada por IA

Em *Nova tarefa*, escreva só o "O que fazer" e clique **gerar com IA**: o seu agente (Haiku/esforço baixo no Claude; esforço baixo no Codex), em **modo somente leitura**, usa o título, a **base de conhecimento** (mapa + arquivos relevantes) e as **lições promovidas** para escrever Contexto, Onde mexer, Critérios de aceite (Dado/quando/então), Fora de escopo e Como validar — aparecendo no campo enquanto é escrito. Se já houver texto, o botão vira **refinar com IA** e preserva suas intenções. Dá para parar no meio e desfazer. O que não dá para confirmar no código vem marcado como `[a confirmar]`.

## Modelos: manual ou automático

Em cada tarefa (e como padrão em *Configurações → Execução*) você escolhe o modelo:

| Agente | Opções | O que o automático faz |
| --- | --- | --- |
| Claude Code | Automático, Haiku, Sonnet, Opus, Fable | Lê título e descrição: tarefa pontual → `--model haiku --effort low`; escopo médio → `sonnet` / `medium`; refactor, segurança, migração ou muitos arquivos → `opus` / `high` |
| Codex | Automático, padrão da CLI, nome livre | Mantém o modelo do seu Codex e ajusta `model_reasoning_effort` (low/medium/high) |

**Esforço de raciocínio** também é escolhível por tarefa e como padrão: Claude `low/medium/high/xhigh/max` (`--effort`), Codex `low/medium/high` (`model_reasoning_effort`). Modelo e esforço são independentes — dá para fixar Opus e deixar o esforço no automático, ou o contrário.

O roteamento é determinístico e explicável (sem chamada extra de LLM): o log da tarefa mostra o modelo escolhido e o motivo, e o diálogo de nova tarefa mostra a escolha ao vivo enquanto você digita.

## Base de conhecimento do projeto

A primeira coisa depois do setup é mapear o repositório:

1. **Grafo estático (segundos):** todos os arquivos versionados → linguagem, imports, símbolos exportados, títulos de docs; imports viram arestas; detecta stack, scripts, diretórios, arquivos centrais e pontos de entrada. Busca textual com SQLite FTS5.
2. **Visão geral por IA (opcional, ~30 s):** o seu agente lê o projeto em **modo somente leitura** (Claude: `dontAsk` + Read/Glob/Grep; Codex: `--sandbox read-only`) e escreve o que o projeto faz.

Em cada tarefa o Carbon injeta no prompt a visão geral, a estrutura e os **arquivos mais relevantes para aquela tarefa** (busca + vizinhos no grafo), e grava o mapa completo em `.carbon/PROJECT_MAP.md` no worktree (fora dos commits). Se o repositório mudou desde a última indexação, o grafo é atualizado antes da tarefa começar.

## Pessoas, personas e skills

- **Login por pessoa.** O admin convida em *Configurações → Pessoas*; a senha temporária aparece uma vez e é trocada no primeiro acesso.
- **Personas**: Engenharia, Produto, Design, QA, Dados. A persona de quem pede a tarefa define o framing do agente, o entregável (ex.: Produto escreve specs em `docs/`) e as skills carregadas.
- **Skills** no formato `SKILL.md` (o mesmo do Claude Code e do Codex): crie no painel, importe de um link do GitHub, envie um arquivo ou cole. Cada skill pode valer para todas as personas ou só algumas. **Skills importadas entram desligadas** até alguém revisar. Elas são instaladas em `.claude/skills/` e `.codex/skills/` de cada worktree e ficam fora dos commits.

## Harness: 28 skills nativas

O Carbon já vem com uma coleção de skills (`carbon-*`) que transforma boas práticas de engenharia em instruções que o agente segue em toda tarefa. Elas foram adaptadas do [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (skills e agentes de TDD, verificação, revisão, segurança e afins) para o protocolo do Carbon: falam a língua dos marcadores `CARBON_*`, respeitam o worktree isolado e nunca mandam o agente commitar ou dar push.

| Grupo | Skills | Para quê |
| --- | --- | --- |
| Contexto | `search-first`, `iterative-retrieval`, `context-budget` | Reaproveitar antes de escrever; buscar contexto em rodadas curtas; não desperdiçar janela |
| Agente | `agent-self-debug`, `decision-ledger`, `docs-sync` | Sair de loops com regra de parada; registrar decisões de design; manter docs em dia |
| Qualidade | `bugfix-regression`, `verification-loop`, `self-review`, `silent-failure-hunt`, `refactor-safely`, `performance-loop`, `test-plan` | Teste falhando antes do fix; build/tipos/lint/testes antes de entregar; revisão com severidade; erros engolidos; refactor sem mudar comportamento; otimização medida |
| Segurança e dados | `security-review`, `lgpd-data-guard`, `dependency-hygiene` | Checklist OWASP; dados pessoais e de saúde fora de logs e fixtures; dependências com critério |
| Backend | `api-contract`, `db-migration-safety`, `error-handling`, `observability`, `production-audit` | Contrato de API consistente; migrações reversíveis e sem downtime; erros tratados; logs úteis; "o que quebra em produção?" |
| Interface e E2E | `frontend-quality`, `e2e-critical-flow`, `design-review` | Estados completos, acessibilidade, responsivo; fluxo crítico com teste determinístico |
| Personas | `pr-description`, `product-spec`, `qa-acceptance`, `data-analysis` | Resumo do PR; spec de produto; critérios virando testes; análise reproduzível sem número inventado |

Cada skill vale para todas as personas ou só para as relevantes (Engenharia recebe a coleção completa; Produto, Design, QA e Dados recebem as gerais mais as suas). Em *Skills*, o admin pode desligar qualquer uma ou mudar para quais personas ela vale. Skills novas desta coleção chegam sozinhas em instalações existentes, sem sobrescrever essas escolhas.

## Projetos

Um Carbon atende vários repositórios. Cada **projeto** tem sua fila de tarefas, base de conhecimento, lições e regras de permissão; agente, modelos, política e pessoas são globais. Troque pelo seletor no topo (cada pessoa tem seu projeto ativo) e gerencie em *Configurações → Projetos*. A fila de execução é única: as tarefas de todos os projetos rodam em ordem, cada uma no repositório do seu projeto.

## Integrações: Jira, Slack e Telegram

Configure em *Configurações → Integrações* (admin). Cada canal tem botão **Testar** e passo a passo na própria tela.

| Canal | Cria tarefa | O Carbon devolve |
| --- | --- | --- |
| **Jira Cloud** | Issue com a label `carbon` (configurável) ou comentário `/carbon <pedido>` | Comentário ao entrar na fila, ao perguntar (com as opções), ao concluir (com o PR) e ao falhar; move a issue para "Em andamento" e "Em revisão" (nomes configuráveis) |
| **Slack** | `@carbon <tarefa>` no canal configurado | Atualizações na thread da menção; perguntas com um botão por opção |
| **Telegram** | `/carbon <tarefa>` ou `@seubot <tarefa>` no chat autorizado | Respostas no chat; perguntas com botões |

Como o Carbon roda só em `127.0.0.1`, os serviços chegam até ele por **webhook através de um túnel HTTPS**:

```sh
cloudflared tunnel --url http://127.0.0.1:3417   # ou ngrok http 3417
```

Cole a URL pública em *Integrações → Túnel* e escolha o projeto que recebe as tarefas. Depois:

- **Jira:** informe site (`https://<empresa>.atlassian.net`), e-mail e [API token](https://id.atlassian.com/manage-profile/security/api-tokens); clique em **Gerar URL do webhook** e cadastre em *Configurações do Jira → Sistema → WebHooks* com os eventos *Issue criada*, *Issue atualizada* e *Comentário criado* (ou use Automação → "Enviar requisição web").
- **Slack:** crie o app em *api.slack.com/apps → From a manifest* com o manifest que a tela gera (escopos `app_mentions:read`, `chat:write`; eventos e interatividade já apontando para a sua URL), instale, cole o bot token e o signing secret e o ID do canal, e convide o bot no canal.
- **Telegram:** crie o bot no @BotFather, cole o token, clique em **Registrar webhook** e mande `/carbon oi` ao bot: ele responde com o chat id para você autorizar.

Segurança das integrações:

- Webhooks só são aceitos com a prova do serviço: assinatura v0 do Slack (janela de 5 min), header secreto do Telegram, HMAC ou segredo na URL do Jira. Sem isso, `401`.
- Só o canal do Slack e o chat do Telegram configurados criam tarefas e respondem perguntas. Retentativas e menções repetidas não duplicam tarefa.
- Tokens e segredos ficam no banco local, **nunca voltam ao navegador** e são testados antes de salvar.
- O túnel expõe também o painel (protegido por login). Use senhas fortes e desligue o túnel quando não precisar.

## Esqueci a senha

O Carbon roda local e não envia e-mail. Quem tem acesso ao computador redefine:

```sh
npm run reset-password                 # escolhe a conta e digita a nova senha (ou gera uma temporária)
npm run reset-password -- --email voce@empresa.com --generate
```

Todas as sessões da conta são encerradas. Senhas temporárias ficam marcadas para troca em *Configurações → Perfil*.

## Permissões do agente

| Perfil | Claude Code | Codex |
| --- | --- | --- |
| `guarded` (padrão) | `acceptEdits` + shell só para git leitura, testes, build e lint | `--sandbox workspace-write` |
| `auto` | `--permission-mode auto` | `--sandbox workspace-write` |
| `unrestricted` | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

Em todos os perfis `git push`, `git commit` e `rm -rf` ficam bloqueados para o agente no Claude Code.

**Permissões no painel (Claude Code):** em `guarded` e `auto`, quando o agente quer usar algo que não está liberado (um comando fora da lista, escrever fora do worktree, buscar na web…), a execução pausa e aparece um card no Mission Control, mais um aviso no topo de qualquer página, com a ferramenta e o comando/arquivo exato. Opções: **Permitir**, **Permitir sempre nesta tarefa** (quando o Claude sugere uma regra) ou **Negar**. Fica registrado quem decidiu. Sem resposta no prazo (padrão 15 min), o pedido é negado. Funciona via `--permission-prompts host --permission-prompt-tool stdio` em `stream-json`. O Codex não tem pedidos interativos em `codex exec`: o sandbox dele bloqueia direto.

**Política de aprovação** (*Configurações → Execução*): **inteligente** (padrão) aprova sozinho o que é de baixo risco dentro do projeto — ler, editar, testar, build, lint, `git status/diff` — e só pergunta instalações, rede, ações fora do projeto e arquivos sensíveis; **autônomo** nunca pergunta; **perguntar tudo** mostra cada pedido. Em todos, `sudo`, `git push`, `rm -rf` fora do projeto, `curl | sh`, credenciais em `~/.ssh`/`~/.aws` e escrita em `.git/` são negados automaticamente. No card dá para escolher **Sempre neste repositório** (salva uma regra, ex.: `npm install`, removível em Configurações) ou **Liberar tudo nesta tarefa**.

**Plano honesto:** cada passo termina como feito, pulado (com o motivo do agente, via `CARBON_SKIPPED`) ou **sem confirmação** — o Carbon nunca marca sozinho um passo que o agente não confirmou.

**Isolamento:** por padrão as execuções do Claude ignoram suas configurações pessoais, hooks e MCPs (`--setting-sources project,local --strict-mcp-config`); as do projeto continuam valendo. Isso garante que o perfil acima seja o que vale e reduziu o contexto de uma tarefa de teste de ~92k para ~30k tokens. Dá para desligar em *Configurações → Execução*.

## Execução distribuída

Rode várias tarefas ao mesmo tempo em outras máquinas. O painel continua dono da fila, do estado e da entrega; os workers só executam e falam com ele por HTTPS de saída (não precisam de porta aberta).

| Onde rodar | Quem executa | Paralelismo |
| --- | --- | --- |
| **Esta máquina** (padrão) | O processo do painel | 1 tarefa por vez |
| **Pool de workers** | `carbon worker` em Docker Compose, Kubernetes ou direto no Node | réplicas × `CARBON_WORKER_PARALLEL` por máquina |
| **AgentCore** — *experimental* | Uma sessão do AWS Bedrock AgentCore Runtime por tarefa, na sua conta | até `agentcore.maxConcurrent` (padrão 3) |

O código vai para o worker por **git** (clone do `origin` e push do branch `agent/*`) ou, sem remoto/commits, por **bundle** servido pelo painel; o branch volta para o repositório do painel e **Aplicar na pasta**, **Merge local** e **Abrir PR** funcionam como numa tarefa local. Permissões aparecem no painel como sempre; uma **pergunta** do agente encerra a execução remota e, ao responder, a tarefa volta à fila e recomeça da base com as suas decisões no prompt.

Em resumo:

1. Exponha só `/api/worker/*` (abaixo) e defina a **URL pública do painel** (`https://`) em *Configurações → Execução*.
2. **Cluster join (estilo Docker Swarm):** *Configurações → Máquinas → Entrar no cluster* (ou `carbon join-token --rotate`) gera um token; em cada servidor rode `carbon join https://painel --token cjt_…` ou o `docker run` mostrado. O servidor entra sozinho e dá para pausar, retomar ou remover pelo painel. Ver [cluster join](docs/distributed/cluster-join.md).
3. Alternativa com kit por máquina: *Configurações → Máquinas → Adicionar máquina* gera o kit (Compose ou Kubernetes) com o token da máquina — ou `node bin/carbon.mjs worker init --target compose|k8s|agentcore --out <pasta> …` no host do painel.
   Na máquina worker: gere a imagem com `deploy/worker/Dockerfile` (mesma versão do painel), preencha as credenciais do modelo no `.env` e `docker compose up -d`.

Documentação completa em [`docs/distributed/`](docs/distributed/README.md) — [cluster join](docs/distributed/cluster-join.md), [quickstart](docs/distributed/quickstart.md), [Compose](docs/distributed/docker-compose.md), [Kubernetes](docs/distributed/kubernetes.md), [AgentCore](docs/distributed/agentcore.md), [protocolo](docs/distributed/protocol.md), [segurança](docs/distributed/security.md), [operação](docs/distributed/operations.md), [variáveis](docs/distributed/environment.md), [troubleshooting](docs/distributed/troubleshooting.md), [FAQ](docs/distributed/faq.md) — e no site: [carbon-superagent.vercel.app/docs.html](https://carbon-superagent.vercel.app/docs.html).

### Expor o painel para workers

Workers só precisam alcançar `/api/worker/*`. Um listener separado encaminha apenas essas rotas; a UI e o resto da API continuam em `127.0.0.1`.

```bash
# .env.local (ou variável de ambiente)
CARBON_WORKER_LISTEN=127.0.0.1:3418
# opcional: TLS direto no listener
CARBON_WORKER_TLS_CERT=/caminho/cert.pem
CARBON_WORKER_TLS_KEY=/caminho/key.pem
```

`npm start` sobe o listener junto com o painel. Ele encaminha **só** caminhos `/api/worker/...` (o resto recebe `404` sem corpo), recusa path traversal (também codificado), forma absoluta, `CONNECT` e upgrades, responde `401` sem `Authorization: Bearer cwk_…`/`ctk_…`, limita conexões (256, 32 por IP — `CARBON_WORKER_MAX_CONNECTIONS`/`_PER_IP`), corpo (1 MB fora do bundle) e tempo total (60 s; 30 min no bundle), e registra uma linha por requisição sem `Authorization` nem query string. Só o listener (debug): `CARBON_WORKER_LISTEN=127.0.0.1:3418 CARBON_PORT=3417 node bin/worker-proxy.mjs`.

Como expor, em ordem de preferência — sempre com **HTTPS** (o worker recusa `http://` fora de loopback):

1. **Tailscale**: `tailscale serve --https=443 http://127.0.0.1:3418` e `https://<host>.<tailnet>.ts.net` nos workers.
2. **Cloudflare Tunnel** apontando **só para a porta do listener**, nunca para a do painel (3417): `cloudflared tunnel --url http://127.0.0.1:3418`. Num túnel nomeado, o `ingress` deve ter um único serviço `http://127.0.0.1:3418` e terminar em `http_status:404`.
3. Reverse proxy próprio com TLS (Caddy, nginx) para `127.0.0.1:3418`.

Detalhes em [docs/distributed/exposing-the-panel.md](docs/distributed/exposing-the-panel.md). Revogue em *Configurações → Máquinas* os tokens de máquinas que você não usa mais.

## Segurança

- A UI e a API do painel escutam só em `127.0.0.1`. **Não exponha a porta do painel (3417) na internet**: quem acessa o painel dispara agentes com acesso de escrita ao seu repositório. Para as integrações, use um túnel só enquanto precisar dele (ver acima).
- **Com workers ativos o modelo muda:** o listener `CARBON_WORKER_LISTEN` expõe `/api/worker/*` para outras máquinas (só essas rotas, com token `Bearer`, rate limit por token, corpo JSON ≤ 1 MB, HTTPS obrigatório fora de loopback), e o **código do repositório sai da máquina do painel** para os workers que você cadastrou ou para a sua conta AWS. Tokens de máquina são mostrados uma vez, guardados como sha256 e revogáveis; o worker remove `CARBON_WORKER_TOKEN` e `CARBON_GIT_TOKEN` do ambiente e o agente recebe só variáveis permitidas; o token git só é enviado aos hosts `https://` de `CARBON_GIT_HOSTS` (vazio = nunca). Tarefas no mesmo processo worker compartilham `HOME`: para isolar uma da outra, use `CARBON_WORKER_PARALLEL=1` (padrão) e escale por réplicas. Nunca exponha a porta 3417 diretamente: os limites por IP confiam no `X-Forwarded-For` definido pelo listener. Credenciais de modelo e de git ficam na máquina worker; o painel nunca as envia. Modelo de ameaça em [docs/distributed/security.md](docs/distributed/security.md).
- Senhas com scrypt, sessões em cookie `httpOnly` guardadas como hash, rate limit no login, checagem de origem em requisições que mudam estado.
- Descrições de tarefa (Linear, GitHub, Jira, Slack, Telegram) são tratadas como dados não confiáveis no prompt.
- Dados ficam em `.carbon-data/` (SQLite com permissão `600`). Chaves e tokens de Linear, Jira, Slack e Telegram ficam nesse banco e nunca voltam ao navegador.
- Não use em repositórios com dados pessoais ou de saúde sem antes validar com quem responde por LGPD na sua empresa.

## Desenvolvimento

```sh
npm run dev      # Next.js com Turbopack em 127.0.0.1:3417
npm run check    # tsc + eslint + vitest
npm run build:worker      # dist/worker.mjs e dist/agentcore.mjs (workers remotos)
npm run e2e:distributed   # painel + 2 workers + AgentCore local, sem AWS (depois de build e build:worker)
```

Estrutura: `bin/carbon.mjs` (CLI) · `src/server` (SQLite, auth, executores, runner) · `src/app/api` (rotas) · `src/components` (painel) · `src/lib/sim` (modo demo) · `src/worker` (worker remoto e entrypoint AgentCore) · `src/shared` (protocolo de worker e executores) · `deploy/worker` (imagem do worker). Plano e fases em [`docs/PLAN.md`](docs/PLAN.md).

## Limites conhecidos

- O parser do Codex segue o formato documentado de `codex exec --json` e tem testes unitários, mas ainda **não foi exercitado contra a CLI real** neste repositório. O do Claude Code foi validado ponta a ponta.
- No modo local, uma tarefa por vez (fila serial). Com workers, as tarefas do pool rodam em paralelo (réplicas × `CARBON_WORKER_PARALLEL`) além da fila local; não há afinidade de máquina nem autoscaling por fila (escala manual).
- Execução remota não retoma a sessão do agente: depois de uma pergunta, a tarefa recomeça da base com as decisões no prompt. Lease vencido (worker some) falha a tarefa por padrão.
- O runtime **AgentCore é experimental**. Veja os [pontos de atenção](docs/distributed/agentcore.md#pontos-de-atenção) (egress, login do Claude Code no container, parâmetros da CLI `bedrock-agentcore-control`).
- A imagem do worker não é publicada em registry: é construída a partir deste repositório (`deploy/worker/Dockerfile`).
- A limpeza de worktrees no boot considera as últimas 500 tarefas; pastas de tarefas mais antigas são tratadas como órfãs (removidas só se estiverem limpas).
- O `gh pr create` pelo card exige um remoto do GitHub com `gh` autenticado; em outros remotos (GitLab, Bitbucket), use merge local ou aplicar na pasta.
- As integrações com Jira, Slack e Telegram têm testes unitários e de ponta a ponta com requisições assinadas, mas ainda **não foram exercitadas contra os serviços reais** neste repositório. Use **Testar** em cada canal ao configurar.
- As threads do Slack por tarefa ficam em memória: depois de reiniciar o Carbon, a próxima atualização abre uma thread nova (tarefas criadas por menção continuam respondendo na thread de origem).
- Retomar a sessão após uma resposta funciona no Claude Code; no Codex a tarefa recomeça no mesmo worktree com as decisões no prompt.
- A busca da base de conhecimento é lexical (FTS5 + símbolos + grafo de imports). Ela acha pelo vocabulário do código; perguntas em português sobre código escrito em inglês acham menos. Busca semântica (embeddings) está no plano (F3).
- O scanner usa regex (sem compilador): cobre bem TS/JS, Python, Go e docs; outras linguagens entram com símbolos, mas sem resolução de imports.
- Com o isolamento desligado, a CLI do Claude carrega o seu `CLAUDE.md`, hooks e MCPs globais nas execuções do Carbon (mais tokens e permissões pessoais por cima do perfil escolhido).

## Identidade e créditos

- Visual próprio: monocromático, Geist/Geist Mono e grid técnico, com **verde success** como único destaque e vermelho reservado para erro, remoção e urgência.
- Animações de reveal, skeletons e o mascote de loading (anel de carbono em `public/carbon-mark.svg`) usam [`ascii-reveal`](https://github.com/quanhoangindex/ascii-reveal) (MIT), fixado em `0.3.0`. A lib respeita `prefers-reduced-motion` (vira um fade curto).
