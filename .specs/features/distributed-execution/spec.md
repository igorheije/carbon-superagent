# Execução distribuída (workers remotos + AWS AgentCore) — Especificação

**Status:** Done (2026-11-06) — T1, T3–T25 entregues; T2 cancelado (U5)
**Escopo:** Complex (novo domínio, mexe no núcleo do runner, rede e segurança)
**Data:** 2026-11-06

## Problem Statement

Hoje o Carbon executa **uma tarefa por vez, na mesma máquina do painel**: o runner é um singleton em memória, o repo é um caminho local (`projects.repo_path`), o worktree, o commit, o push e o PR saem do disco do painel, e o painel só escuta em `127.0.0.1`. Isso limita a vazão a 1 tarefa e prende a execução ao notebook de quem roda o Carbon. O objetivo é poder **escalar a execução** para outras máquinas (pods Docker/Kubernetes) e para o **AWS Bedrock AgentCore Runtime**, mantendo o painel como **ponto central** onde tudo aparece: status, log, diff, perguntas, entrega.

## Decisões já tomadas (usuário, 2026-11-06)

| # | Decisão |
|---|---|
| U1 | AgentCore entra como **Runtime remoto**: a tarefa roda numa microVM do AgentCore Runtime, clona o repo, commita e devolve branch/diff. |
| U2 | Setup de workers em **Docker Compose e Kubernetes**. |
| U3 | Código chega no worker por **git remoto quando houver**, e por **bundle via painel** quando não houver (ex.: repo sem remoto/sem commits). |
| U4 | **Worker puxa** (HTTPS de saída para o painel). O painel precisa de URL alcançável (pública ou túnel/VPN). |
| U5 | **AgentCore fica pronto, não implantado.** Nada é criado na AWS neste trabalho: o código, os testes (SDK mockado), o kit de deploy e a documentação ficam prontos para quem quiser usar. Marcado como "experimental — não validado em conta AWS real". |

## Goals

- [ ] Rodar N tarefas em paralelo em M máquinas, com o painel mostrando todas ao vivo, sem mudar a experiência de quem cria/acompanha tarefas.
- [ ] Deixar o runtime AgentCore implementado e testado com SDK mockado, com kit de deploy e documentação para quem quiser rodar na própria conta AWS (sem implantar nada neste trabalho).
- [ ] Gerar, pelo painel ou CLI, arquivos de setup prontos (Compose e Kubernetes) para subir workers em outra máquina em < 10 min.
- [ ] Zero regressão no modo local atual (padrão continua "local", 1 por vez).

## Out of Scope

| Item | Motivo |
|---|---|
| Autoscaling automático por tamanho de fila (KEDA/HPA custom) | P3 futuro; escala manual (`replicas`/`--scale`) cobre o MVP |
| Multi-tenant / vários painéis centrais | Um painel central por instalação |
| Trocar SQLite por Postgres | Fila e leases cabem no SQLite com WAL; reavaliar se >20 workers |
| Executar o próprio painel na nuvem (deploy do central) | Só documentar opções de exposição (túnel/VPN) |
| AgentCore Gateway/Memory/Policy/Evaluations | Só Runtime (+ Identity/Secrets se necessário) |
| Compute "Instances" do AgentCore (sessões > 8h) | [Certo] indisponível em sa-east-1 |
| Draft de descrição (`draft/run.ts`) e indexador remotos | Continuam locais no painel |

---

## User Stories

### P1: Protocolo de worker e fila distribuída ⭐ MVP

**User Story:** Como dono do Carbon, quero que tarefas possam ser executadas por processos "worker" fora do painel, para rodar várias ao mesmo tempo.

**Acceptance Criteria:**
1. WHEN uma tarefa é criada com `runtime = "pool"` THEN o painel SHALL deixá-la `queued` sem executá-la localmente, disponível para claim por worker.
2. WHEN um worker autenticado chama claim THEN o painel SHALL entregar no máximo uma tarefa por chamada, atomicamente (duas chamadas concorrentes nunca recebem a mesma tarefa), com lease de duração definida.
3. WHEN o worker envia eventos (log, plano, uso, perguntas, resultado) THEN o painel SHALL aplicá-los ao snapshot da tarefa pelo mesmo redutor usado localmente (`applyExecutorEvent`) e notificar o SSE.
4. WHEN o worker para de renovar o lease por mais que o TTL THEN o painel SHALL marcar a tarefa como `failed` com motivo "worker sumiu" (ou recolocar na fila, conforme configuração) e liberar o lease.
5. WHEN o painel reinicia THEN tarefas com lease remoto válido SHALL continuar `running` (só tarefas locais viram `failed`).
6. WHEN um worker sem token válido chama qualquer rota `/api/worker/*` THEN o painel SHALL responder 401 sem revelar se a tarefa existe.
7. WHEN o usuário cancela uma tarefa remota THEN o worker SHALL recebê-lo na próxima renovação/poll e matar o agente em ≤ 30 s.

**Independent Test:** Subir painel + `carbon worker` na mesma máquina com outro `CARBON_DATA_DIR`; criar 2 tarefas pool; ver as 2 rodando em paralelo em 2 workers e chegando a `done` com diff no painel.

### P1: Transporte de código (git remoto e bundle) ⭐ MVP

**User Story:** Como dono do Carbon, quero que o worker receba o código do projeto e devolva o commit, com ou sem remoto git.

**Acceptance Criteria:**
1. WHEN o projeto tem remoto e o worker tem credencial git THEN o worker SHALL clonar do remoto, trabalhar num branch `agent/*` e fazer push do branch; o painel SHALL fazer `git fetch` desse branch no repo local.
2. WHEN o projeto não tem remoto (ou `transport = "bundle"`) THEN o painel SHALL servir um `git bundle` do ponto de partida e o worker SHALL enviar de volta um bundle com o(s) commit(s) da tarefa; o painel SHALL importar o branch no repo local.
3. WHEN o repo não tem commits THEN o painel SHALL gerar o bundle a partir de um snapshot (mesma regra do `NO_COMMITS_BASE` atual).
4. WHEN o branch chega no repo central THEN "Aplicar na pasta", "Merge local" e "Abrir PR" SHALL funcionar igual às tarefas locais.
5. WHEN o upload excede o limite (padrão 200 MB) THEN o painel SHALL recusar com 413 e a tarefa SHALL falhar com mensagem clara.

**Independent Test:** Repo sem remoto → tarefa pool → branch `agent/*` aparece no repo central → "Aplicar na pasta" funciona.

### P1: Tokens de worker e exposição segura do painel ⭐ MVP

**User Story:** Como admin, quero cadastrar máquinas com tokens próprios e revogáveis, e expor o painel sem abrir a interface web inteira.

**Acceptance Criteria:**
1. WHEN o admin cria um worker no painel THEN o painel SHALL gerar um token exibido uma única vez e guardar só o hash.
2. WHEN o token é revogado THEN chamadas seguintes desse worker SHALL receber 401 e suas tarefas em andamento SHALL seguir a regra de lease expirado.
3. WHEN `CARBON_WORKER_LISTEN` está configurado THEN o painel SHALL expor apenas `/api/worker/*` nessa interface/porta, mantendo a UI em localhost (salvo opção explícita).
4. Todas as rotas de worker SHALL ter rate limit por token e limite de tamanho de corpo.

### P1: Executor AgentCore Runtime ⭐ MVP

**User Story:** Como dono do Carbon, quero escolher "AgentCore" ao criar uma tarefa e ela rodar na minha conta AWS, aparecendo no painel como as outras.

**Acceptance Criteria:**
1. WHEN uma tarefa tem `runtime = "agentcore"` THEN o painel SHALL chamar `InvokeAgentRuntime` com um `runtimeSessionId` determinístico da tarefa (≥ 33 caracteres) e um payload com id da tarefa, URL do painel e um **token de uso único** escopado à tarefa.
2. WHEN o container AgentCore recebe a invocação THEN ele SHALL responder rápido, executar a tarefa em background usando o mesmo protocolo de worker (claim da tarefa específica, eventos, entrega), e `/ping` SHALL retornar `HealthyBusy` enquanto trabalha.
3. WHEN a tarefa termina THEN o container SHALL entregar o commit (push ou bundle) antes de liberar a sessão, e o painel SHALL chamar `StopRuntimeSession`.
4. WHEN a sessão excede o limite (8h, ou `maxRunMinutes` menor) THEN a tarefa SHALL falhar com motivo explícito.
5. WHEN as credenciais AWS ou o ARN não estão configurados THEN "AgentCore" SHALL aparecer desabilitado no seletor com o motivo.
6. O painel SHALL limitar o número de sessões AgentCore simultâneas (padrão 3) para controlar custo.

**Independent Test:** Teste de integração com o cliente do SDK mockado: dispatch chama Invoke com sessão ≥ 33 caracteres e token de uso único; o entrypoint do container (rodando localmente, sem AWS) executa a tarefa pelo protocolo de worker e a tarefa chega a `done` com branch importado. Validação em conta AWS real fica para quem implantar.

### P2: Gerador de setup (Compose + Kubernetes + AgentCore)

**User Story:** Como admin, quero baixar os arquivos para subir workers em outra máquina sem montar nada à mão.

**Acceptance Criteria:**
1. WHEN o admin clica "Adicionar máquina" e escolhe Compose THEN o painel SHALL gerar um `.zip` com `docker-compose.yml`, `.env` (URL do painel, token, executor, réplicas), `README.md` e comando de escala (`docker compose up -d --scale worker=N`).
2. WHEN escolhe Kubernetes THEN SHALL gerar `namespace.yaml`, `secret.yaml`, `deployment.yaml` (réplicas, recursos, `terminationGracePeriodSeconds` suficiente) e `kustomization.yaml`.
3. O mesmo gerador SHALL estar disponível por CLI: `carbon worker init --target compose|k8s --out <dir>`.
4. WHEN escolhe AgentCore THEN SHALL gerar `Dockerfile` arm64, política IAM mínima e script `deploy.sh` (build multi-arch, push ECR, create/update runtime) — sem executar nada na AWS.
5. Arquivos gerados SHALL nunca conter segredos de IA do painel; credenciais do modelo e do git ficam como placeholders a preencher na máquina destino.

### P2: Permissões e perguntas em execução remota

**Acceptance Criteria:**
1. WHEN o agente remoto pede permissão fora da allowlist THEN o worker SHALL enviar `permission_request` ao painel e aguardar resposta (até o timeout atual), e o painel SHALL mostrá-la como hoje.
2. WHEN o agente faz uma pergunta (`CARBON_QUESTION`) THEN a tarefa SHALL ir para `waiting`; ao responder, SHALL voltar para a fila do mesmo runtime; como a sessão do Claude não existe em outra máquina, a retomada SHALL usar as decisões no prompt (como o Codex hoje).

### P2: Visão de frota no painel

**Acceptance Criteria:**
1. WHEN existem workers THEN o painel SHALL listar cada um: nome, runtime, status (online/ocioso/ocupado/offline), última batida, tarefa atual, versão.
2. Cada tarefa SHALL mostrar onde rodou (local, nome do worker, ou sessão AgentCore).

### P3: Autoscaling por fila

Endpoint de métrica (`/api/worker/metrics`: tarefas na fila por runtime) para KEDA/HPA. Fora do MVP.

---

## Edge Cases

- WHEN dois workers fazem claim ao mesmo tempo THEN só um SHALL ganhar (UPDATE condicional em transação).
- WHEN o worker termina a tarefa depois que o lease expirou e a tarefa já foi reatribuída THEN o painel SHALL rejeitar os eventos (409, `lease_lost`) e o worker SHALL descartar.
- WHEN a rede cai no meio THEN o worker SHALL guardar eventos em buffer local limitado e reenviar em ordem (sequência monotônica; painel ignora duplicados).
- WHEN o projeto é removido do painel com tarefa remota rodando THEN o painel SHALL cancelar a tarefa.
- WHEN o worker roda versão de protocolo incompatível THEN o claim SHALL responder 426 com a versão mínima.
- WHEN o push do branch falha (sem permissão) THEN o worker SHALL cair para bundle se o painel permitir.
- WHEN o payload de log é enorme THEN o painel SHALL truncar como hoje (`ticket-log` máx. 400 linhas).

---

## Requirement Traceability

| ID | Story | Fase | Status |
|---|---|---|---|
| WRK-01 | P1 Protocolo: runtime por tarefa (`local`/`pool`/`agentcore`) | Design | Pending |
| WRK-02 | P1 Protocolo: claim atômico com lease | Design | Pending |
| WRK-03 | P1 Protocolo: eventos → `applyExecutorEvent` + SSE | Design | Pending |
| WRK-04 | P1 Protocolo: expiração de lease e recuperação no boot | Design | Pending |
| WRK-05 | P1 Protocolo: cancelamento remoto | Design | Pending |
| WRK-06 | P1 Protocolo: processo `carbon worker` (loop de claim) | Design | Pending |
| CODE-01 | P1 Transporte: git remoto (clone/push/fetch) | Design | Pending |
| CODE-02 | P1 Transporte: bundle (download base / upload resultado) | Design | Pending |
| CODE-03 | P1 Transporte: entrega reaproveita local-delivery/PR | Design | Pending |
| SEC-01 | P1 Tokens de worker (hash, revogação, escopo) | Design | Pending |
| SEC-02 | P1 Listener separado só para `/api/worker/*` | Design | Pending |
| SEC-03 | P1 Rate limit + limite de corpo | Design | Pending |
| AGC-01 | P1 AgentCore: dispatcher (Invoke/Stop, sessão, limite de concorrência) | Design | Pending |
| AGC-02 | P1 AgentCore: entrypoint do container (`/invocations`, `/ping` HealthyBusy) | Design | Pending |
| AGC-03 | P1 AgentCore: token de uso único por tarefa | Design | Pending |
| AGC-04 | P1 AgentCore: config/settings + disponibilidade no seletor | Design | Pending |
| SET-01 | P2 Gerador Compose | Design | Pending |
| SET-02 | P2 Gerador Kubernetes | Design | Pending |
| SET-03 | P2 Gerador AgentCore (Dockerfile arm64, IAM, deploy.sh) | Design | Pending |
| SET-04 | P2 UI "Adicionar máquina" + CLI `worker init` | Design | Pending |
| RMT-01 | P2 Permissões remotas | Design | Pending |
| RMT-02 | P2 Perguntas/retomada remota | Design | Pending |
| FLT-01 | P2 Visão de frota | Design | Pending |
| FLT-02 | P3 Métrica de fila para autoscaling | - | Deferred |

**Coverage:** 24 total, 23 mapeados para tarefas, 1 adiado (FLT-02).

## Success Criteria

- [ ] 3 tarefas pool rodando em paralelo em 2 máquinas, todas visíveis ao vivo no painel.
- [ ] Fluxo AgentCore completo coberto por teste com SDK mockado + entrypoint local; README explica como implantar e quais pontos não foram validados em AWS real.
- [ ] Máquina nova operando como worker em < 10 min a partir do zip gerado.
- [ ] `npm run check` verde; nenhum teste existente alterado para passar (exceto onde o contrato mudou de propósito).
- [ ] Com `runtime=local` (padrão), comportamento idêntico ao atual.
