# Cluster join (estilo Docker Swarm) — Especificação

**Status:** Done (2026-11-06) — exceto KIT-01/02 (adiados; `docker run` cobre containers)
**Escopo:** Large (estende a execução distribuída já entregue; sem domínio novo)
**Data:** 2026-11-06
**Depende de:** `.specs/features/distributed-execution` (Done)

## Problem Statement

A execução distribuída já existe: workers remotos fazem claim de tarefas `pool` no painel por HTTPS. Mas
**colocar um servidor novo exige trabalho manual por máquina**: o admin cria a máquina no painel
(Configurações → Máquinas ou `carbon worker init`), copia um token `cwk_` exclusivo, monta `.env` com
`CARBON_PANEL_URL` + `CARBON_WORKER_TOKEN` e sobe o worker. Para 5 servidores são 5 cadastros e 5 tokens.

O objetivo é o modelo do Docker Swarm: **o painel (admin/manager) mostra um único comando de join;
em cada servidor novo roda-se esse comando e ele entra no cluster sozinho**, aparece na lista de nós e
começa a pegar tarefas. O admin consegue pausar (drain), retomar e remover nós, e girar o token de join.

## Analogia (para alinhar vocabulário)

| Docker Swarm | Carbon |
|---|---|
| `docker swarm init` (manager) | painel com `CARBON_WORKER_LISTEN` + URL pública configurada |
| `docker swarm join-token worker` | Configurações → Máquinas → "Adicionar servidor" (mostra o comando) / `carbon join-token` |
| `docker swarm join --token SWMTKN-… host:2377` | `carbon join https://painel --token cjt_…` (ou `docker run … carbon-worker join`) |
| `docker swarm join-token --rotate worker` | "Girar token" / `carbon join-token --rotate` |
| `docker node ls` | lista de nós (já existe: FLT-01) |
| `docker node update --availability drain` | "Pausar" (para de pegar tarefas novas, termina as atuais) |
| `docker node rm` | "Remover" (revoga a credencial do nó) |
| `docker swarm leave` | `carbon leave` |

## Decisões (tomadas por mim, reversíveis — usuário autorizou seguir após as specs)

| # | Decisão | Motivo |
|---|---|---|
| D1 | **Um token de join ativo por vez**, prefixo `cjt_`, só hash no banco, exibível de novo enquanto ativo (guardado cifrado não; ver D2) | Igual ao swarm; girar invalida o anterior |
| D2 | O token de join é **mostrado só na criação/rotação** (como o `cwk_`). Para ver de novo, gira. | Não guardar segredo em claro no SQLite |
| D3 | Join **troca** o `cjt_` por uma credencial própria do nó (`cwk_`, como hoje). O `cjt_` nunca é usado para claim | Revogar um nó não afeta os outros; vazamento do `cjt_` não dá acesso a tarefas já em curso |
| D4 | **Entrada automática por padrão** (swarm-like), com opção "exigir aprovação" nas configurações: nó entra como `pending` e só pega tarefa após o admin aprovar | Pedido do usuário ("só faço o join"); aprovação cobre quem quer mais controle |
| D5 | Token de join com **validade opcional** (padrão: sem validade, como o swarm) e **máximo de usos opcional** | Permite token de uso único para setups sensíveis |
| D6 | O nó **persiste a credencial em disco** (`<stateDir>/node.json`, 0600). Reiniciar o worker não faz join de novo; `carbon join` com credencial existente e válida reaproveita | Evita nós duplicados a cada restart do container |
| D7 | Nome do nó = `--name` ou hostname; colisão de nome é permitida, o id é a identidade | Swarm também aceita hostnames repetidos |
| D8 | Pausar/retomar/remover valem para nós de join e para máquinas antigas criadas com token manual | Uma só lista de nós |
| D9 | Labels e restrições de placement (ex.: "só em nó com GPU") ficam **fora** (P3) | Não pedido; claim por executor já cobre o principal |

## Goals

- [ ] Servidor novo entra no cluster com **um comando** e aparece em Máquinas em < 1 min, sem cadastro manual por máquina.
- [ ] Admin pausa, retoma e remove nós pelo painel; nó pausado termina o que está fazendo e não pega tarefa nova.
- [ ] Girar o token de join impede joins novos com o token antigo sem derrubar nós já no cluster.
- [ ] Zero regressão: máquinas criadas pelo fluxo atual (token manual, kits Compose/K8s) continuam funcionando.

## Out of Scope

| Item | Motivo |
|---|---|
| Vários managers / alta disponibilidade do painel (Raft) | Um painel central por instalação (mesma regra da execução distribuída) |
| Labels/constraints de placement | D9 — P3 |
| Overlay network / service discovery entre nós | Nós só falam com o painel (pull HTTPS) |
| Instalação como serviço do sistema (systemd/launchd) automática | P3; documentar unit de exemplo |
| Publicar imagem em registry público | Imagem continua sendo construída localmente (`Dockerfile.worker`) |
| AgentCore via join | AgentCore é invocado pelo painel, não faz join |

---

## User Stories

### P1: Token de join ⭐ MVP

**User Story:** Como admin, quero um token de join único para o cluster, para colocar quantos servidores quiser sem cadastrar um a um.

**Acceptance Criteria:**
1. WHEN o admin gera (ou gira) o token de join THEN o painel SHALL criar um token `cjt_` novo, guardar só o sha256, invalidar o anterior e exibi-lo uma única vez junto do comando pronto (`carbon join <url> --token …` e a variante `docker run`).
2. WHEN não há URL pública do painel configurada THEN o painel SHALL avisar que o comando precisa da URL (`panelPublicUrl`) e mostrar o comando com placeholder.
3. WHEN o token tem validade ou máximo de usos e um deles se esgota THEN joins seguintes SHALL receber 401 genérico.
4. WHEN o admin desativa o join THEN nenhum token SHALL ser aceito até gerar outro.
5. O mesmo SHALL existir por CLI no host do painel: `carbon join-token [--rotate] [--ttl 24h] [--max-uses N]`.

### P1: Comando `carbon join` ⭐ MVP

**User Story:** Como admin, quero rodar um comando no servidor novo e ele entrar no cluster e começar a trabalhar.

**Acceptance Criteria:**
1. WHEN `carbon join <url> --token cjt_…` roda THEN o worker SHALL chamar `POST /api/worker/join` com nome, hostname, versão, executores detectados e paralelismo, receber `{nodeId, token: cwk_…}`, gravar `<stateDir>/node.json` (0600) e seguir direto para o loop normal de worker.
2. WHEN `node.json` já existe com credencial aceita pelo painel THEN `carbon join` SHALL reaproveitá-la (não cria nó novo) e `carbon worker` sem `CARBON_WORKER_TOKEN` SHALL usá-la.
3. WHEN a credencial salva é recusada (nó removido) THEN o worker SHALL sair com mensagem "este nó foi removido do cluster; rode carbon join de novo" e código ≠ 0 (sem loop de restart barulhento: código 3 documentado).
4. WHEN o token de join é inválido THEN SHALL sair com código ≠ 0 e mensagem genérica, sem ecoar o token.
5. A URL SHALL seguir a regra atual (https obrigatório fora de loopback).
6. O token de join SHALL ser aceito também por env (`CARBON_JOIN_TOKEN`, `CARBON_PANEL_URL`) para Docker/K8s, e removido do ambiente após a leitura.
7. `carbon leave` SHALL avisar o painel (`POST /api/worker/leave`, revoga a própria credencial), apagar `node.json` e sair; tarefas em curso seguem a regra de SIGTERM (graça).

### P1: Endpoint de join no painel ⭐ MVP

**Acceptance Criteria:**
1. `POST /api/worker/join` SHALL ficar sob `/api/worker/*` (passa pelo listener público existente) e aceitar `Authorization: Bearer cjt_…`.
2. WHEN o token é válido THEN SHALL criar um worker `pool` com `joined_via = 'join'`, gerar a credencial `cwk_` (só hash), contar 1 uso e responder 201 `{nodeId, token, status}`.
3. Falhas SHALL responder 401 genérico, com rate limit por IP (reusa o limitador de falhas de auth) — 429 após o limite.
4. WHEN "exigir aprovação" está ligado THEN o nó SHALL nascer `pending`; `hello` SHALL funcionar e `claim` SHALL responder 204 sem lease até a aprovação.
5. O corpo SHALL ser validado (zod) e limitado; nome truncado/limpo como no cadastro manual.

### P1: Disponibilidade do nó (ativo / pausado / pendente) ⭐ MVP

**User Story:** Como admin, quero pausar um servidor para manutenção sem matar o que ele está rodando.

**Acceptance Criteria:**
1. WHEN o admin pausa um nó THEN `claim` desse nó SHALL responder 204 sem lease; tarefas em andamento SHALL continuar até o fim normalmente.
2. WHEN o admin retoma THEN o próximo `claim` SHALL voltar a receber tarefas.
3. WHEN o admin aprova um nó `pending` THEN ele SHALL virar `active`.
4. WHEN o admin remove um nó THEN a credencial SHALL ser revogada (regra atual de revogação/lease).
5. O status exibido SHALL combinar disponibilidade e saúde: `pendente`, `pausado`, `ocupado`, `ocioso`, `offline`, `removido`.

### P2: UI "Adicionar servidor" e lista de nós

**Acceptance Criteria:**
1. Máquinas SHALL ter um bloco "Entrar no cluster" com: botão gerar/girar token, opções (validade, usos, exigir aprovação), comando `carbon join` e `docker run` copiáveis, aviso de que o token é mostrado uma vez.
2. Cada nó SHALL mostrar origem (join / manual), slots (`tarefas atuais / maxParallel`), e ações Pausar/Retomar/Aprovar/Remover conforme o estado.
3. WHEN um nó novo entra THEN a lista SHALL atualizar sem recarregar (poll atual da aba ou SSE).

### P2: Kits Compose/K8s com join

**Acceptance Criteria:**
1. O kit Compose SHALL suportar `CARBON_JOIN_TOKEN` em vez de token por máquina, com volume persistente para `stateDir` (D6), permitindo `docker compose up -d --scale worker=N` onde cada réplica é um nó.
2. O kit K8s SHALL usar `StatefulSet` ou volume por pod para persistir `node.json` quando em modo join [decidir no design].

### P3: Labels e placement

Deferido (D9).

---

## Edge Cases

- WHEN dois `carbon join` simultâneos usam um token com `max-uses=1` THEN só um SHALL entrar (decremento condicional em transação).
- WHEN o token é girado durante um join em andamento THEN o join SHALL falhar ou suceder atomicamente (nunca nó criado com contador inconsistente).
- WHEN o nó é pausado enquanto um long-poll de claim está aberto THEN o poll SHALL parar de entregar tarefa em ≤ 1 intervalo de checagem (1 s).
- WHEN `node.json` está corrompido ou com permissão aberta (não 0600) THEN o worker SHALL recusar e explicar (não usar credencial exposta).
- WHEN o container reinicia sem volume persistente THEN SHALL fazer join de novo e criar nó novo; o antigo vira offline. Documentar o volume.
- WHEN o admin remove um nó offline THEN SHALL funcionar sem contato com o nó.

---

## Requirement Traceability

| ID | Story | Fase | Status |
|---|---|---|---|
| JOIN-01 | P1 Token de join: gerar/girar/desativar, só hash | Tasks | Done |
| JOIN-02 | P1 Token de join: validade e máximo de usos atômico | Tasks | Done |
| JOIN-03 | P1 CLI `carbon join-token` no host do painel | Tasks | Done |
| JOIN-04 | P1 Endpoint `POST /api/worker/join` + rate limit | Tasks | Done |
| JOIN-05 | P1 `carbon join` (troca de token, `node.json` 0600, segue para o loop) | Tasks | Done |
| JOIN-06 | P1 Reuso de credencial salva / erro "nó removido" (exit 3) | Tasks | Done |
| JOIN-07 | P1 `carbon leave` + `POST /api/worker/leave` | Tasks | Done |
| NODE-01 | P1 Disponibilidade active/paused/pending no banco | Tasks | Done |
| NODE-02 | P1 Claim respeita disponibilidade | Tasks | Done |
| NODE-03 | P1 Ações admin: pausar/retomar/aprovar/remover | Tasks | Done |
| NODE-04 | P1 Status combinado na frota | Tasks | Done |
| UI-01 | P2 Bloco "Entrar no cluster" | Tasks | Done |
| UI-02 | P2 Ações por nó na lista | Tasks | Done |
| KIT-01 | P2 Kit Compose em modo join | - | Deferred |
| KIT-02 | P2 Kit K8s em modo join | - | Deferred |
| DOC-01 | P2 Documentação (`docs/distributed/cluster-join.md` + README) | Tasks | Done |
| PLC-01 | P3 Labels/placement | - | Deferred |

## Success Criteria

- [ ] Painel + 2 workers em pastas/`stateDir` diferentes entram com o **mesmo** `cjt_`, aparecem como 2 nós e rodam tarefas pool em paralelo.
- [ ] Pausar um nó: ele termina a tarefa atual e a próxima vai para o outro.
- [ ] Girar o token: join com o antigo → 401; nós existentes seguem trabalhando.
- [ ] Reiniciar um worker não cria nó duplicado.
- [ ] `npm run check` verde; testes existentes inalterados (salvo contrato mudado de propósito).
