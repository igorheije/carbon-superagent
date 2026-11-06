# Execução distribuída — Tasks

**Design:** `.specs/features/distributed-execution/design.md`
**Status:** Draft — aguardando aprovação

**Gates** (não há `.specs/codebase/TESTING.md`; derivado de `package.json` e `vitest.config.ts`):
- **quick:** `npx vitest run <arquivos de teste da tarefa>`
- **full:** `npm run check` (tsc + eslint + vitest)
- **build:** `npm run check && npm run build`

**Testes por camada:** função pura/repo/rota → unit (vitest, git real em tmp como `local-delivery.test.ts`); processo worker → integração (painel em memória + worker em processo); UI → sem teste automatizado hoje (gate build + verificação manual); arquivos gerados → snapshot test.

**Execução com Orca (`orca orchestration worker-start`):** cada grupo `[P]` de uma fase vira um worker Orca em worktree próprio (`--worktree new-top-level`), com posse exclusiva dos arquivos listados em "Where". Eu (coordenador) integro, rodo o gate full e só depois libero a fase seguinte. Tarefas sem `[P]` rodam em sequência num único worker.

---

## Execution Plan

### Fase 0 — Preparação
```
T1   (T2 cancelado — U5)
```
### Fase 1 — Fundação no painel (paralelo após T2)
```
      ┌→ T3 (migração+repo) → T4 (scheduler) ─┐
T1 ───┼→ T5 [P] (auth de worker) ──────────────┼→ T7 (rotas /api/worker)
      └→ T6 [P] (extrair executors shared) ────┘
```
### Fase 2 — Worker e transporte (paralelo após T7)
```
      ┌→ T8 [P] (worker client) ─┐
T7 ───┼→ T9 [P] (code transport) ┼→ T11 (run-task) → T12 (loop + CLI)
      └→ T10 [P] (remote-delivery no painel)
```
### Fase 3 — AgentCore (após T11)
```
T11 ─┬→ T13 [P] (agentcore-entry no container)
     └→ T14 [P] (dispatcher no painel) → T15 (settings+seletor)
```
### Fase 4 — Setup kit, segurança de exposição, UI, P2 (após T12 / T15)
```
T12 ─┬→ T16 [P] (Dockerfile.worker)
     ├→ T17 [P] (gerador compose+k8s) ─┐
     ├→ T18 [P] (gerador agentcore)  ──┼→ T19 (rota admin + CLI init + UI Máquinas)
     └→ T20 [P] (proxy listener)       │
T15 ────────────────────────────────────┘
T19 → T21 (UI placement na tarefa) → T22 (permissões remotas) → T23 (perguntas/retomada) → T24 (E2E + docs + revisão de segurança)
```

---

## Task Breakdown

### T1: Mapear codebase (brownfield mínimo)
**What:** Criar `.specs/codebase/TESTING.md` e `CONCERNS.md` com o que o mapa já levantou (runner singleton, CHECK de executor, sem testes de `runner.ts`/`startExecutor`).
**Where:** `.specs/codebase/`
**Depends on:** None · **Requirement:** — · **Tools:** Skill `tlc-spec-driven`
**Done when:** [ ] arquivos criados com gates acima · **Tests:** none · **Gate:** —

### T2: ~~Spike na AWS~~ — CANCELADO (decisão U5)
Nada é implantado na AWS. As premissas [Incerto] do design viram **avisos na documentação** (T24) em vez de bloqueios; o código do AgentCore é testado com SDK mockado e entrypoint rodando localmente.

### T3: Migração + repositório de leases e workers
**What:** Migração (colunas `runtime`, `lease_*`, `cancel_requested`; tabelas `workers`, `task_tokens`) e funções de repo.
**Where:** `src/server/db.ts`, `src/server/repo/workers.ts` (novo), `src/server/repo/tasks.ts`, `src/lib/domain/types.ts`
**Depends on:** T1 · **Reuses:** padrão de migração `user_version` · **Requirement:** WRK-01
**Done when:** [ ] migração aplica em banco existente sem perder dados · [ ] `recoverInterruptedTasks` só afeta `runtime='local'` · [ ] `db.test.ts` + `workers.test.ts` passam
**Tests:** unit · **Gate:** quick

### T4: Scheduler (claim atômico, renew, sweep)
**What:** `claimNext`, `claimSpecific`, `renew`, `sweepExpiredLeases`; `kick()` local passa a filtrar `runtime='local'`.
**Where:** `src/server/runner/scheduler.ts` (novo), `src/server/runner/runner.ts`
**Depends on:** T3 · **Requirement:** WRK-02, WRK-04, WRK-05
**Done when:** [ ] teste de concorrência: 20 claims simultâneos, nenhuma tarefa duplicada · [ ] lease expirado → failed/requeue conforme setting · [ ] cancel aparece no renew
**Tests:** unit · **Gate:** quick

### T5: Auth de worker e token de tarefa [P]
**What:** `createWorker`, `revokeWorker`, `requireWorker`, `issueTaskToken`, `consumeTaskToken`; exceção no `middleware.ts` para `/api/worker/`.
**Where:** `src/server/auth/worker-auth.ts` (novo), `src/middleware.ts`
**Depends on:** T3 · **Reuses:** hash de `repo/users.ts`, `auth/rate-limit.ts` · **Requirement:** SEC-01, SEC-03, AGC-03
**Done when:** [ ] token só existe em claro no retorno de criação · [ ] revogado → 401 · [ ] token de tarefa não reutilizável e preso à tarefa · [ ] rate limit por token
**Tests:** unit · **Gate:** quick

### T6: Extrair executores para módulo compartilhado [P]
**What:** Mover `spawn.ts`, parsers, `events.ts`, `protocol.ts` para `src/shared/executors/` sem `server-only`; manter re-exports em `src/server/executors/`.
**Where:** `src/shared/executors/*`, `src/server/executors/*`
**Depends on:** T1 · **Requirement:** WRK-06 (pré-requisito)
**Done when:** [ ] testes existentes de spawn/parsers passam sem alteração · [ ] `npm run build` verde
**Tests:** unit (existentes) · **Gate:** build

### T7: Rotas `/api/worker/*` (hello, claim, heartbeat, events)
**What:** Rotas com zod; `events` aplica `applyExecutorEvent` com idempotência por `seq` e chama o mesmo save+notify do runner (extraído para `runner/live.ts`).
**Where:** `src/app/api/worker/**`, `src/server/runner/live.ts` (novo), `src/server/schemas.ts`
**Depends on:** T4, T5, T6 · **Requirement:** WRK-02, WRK-03, WRK-05, SEC-03
**Done when:** [ ] 401 sem token · [ ] 409 `lease_lost` · [ ] evento duplicado ignorado · [ ] SSE emite change ao receber evento · [ ] 426 em versão velha
**Tests:** unit (handlers chamados direto, como as rotas existentes) · **Gate:** full

### T8: Cliente do protocolo no worker [P]
**What:** `client.ts` com retry exponencial, buffer de eventos com `seq` (máx. 5 MB), long-poll de claim.
**Where:** `src/worker/client.ts`
**Depends on:** T7 · **Requirement:** WRK-06
**Done when:** [ ] reenvio após falha de rede preserva ordem · [ ] buffer cheio → descarta `text` antes de `result/error`
**Tests:** unit (fetch mockado) · **Gate:** quick

### T9: Transporte de código no worker [P]
**What:** `code.ts`: clone (git) ou restore (bundle), branch `agent/*`, push ou `git bundle create`.
**Where:** `src/worker/code.ts`
**Depends on:** T7 · **Reuses:** `worktree.ts` (nomes de branch), `NO_COMMITS_BASE` · **Requirement:** CODE-01, CODE-02
**Done when:** [ ] testes com git real: remoto bare local (push) e bundle (incl. repo sem commits) · [ ] push recusado → fallback bundle
**Tests:** unit (git real) · **Gate:** quick

### T10: Importar resultado no painel + rotas bundle/result [P]
**What:** `GET bundle` e `POST result` (stream com limite); `remote-delivery.ts` faz fetch do branch/bundle, preenche workspace+diff e chama `deliver`.
**Where:** `src/server/runner/remote-delivery.ts`, `src/app/api/worker/tasks/[id]/bundle|result/route.ts`
**Depends on:** T7 · **Reuses:** `local-delivery.ts`, `workspace.ts` · **Requirement:** CODE-02, CODE-03
**Done when:** [ ] branch importado e "Aplicar na pasta" funciona sobre ele (teste reaproveitando `local-delivery.test.ts`) · [ ] 413 acima do limite
**Tests:** unit (git real) · **Gate:** full

### T11: `runClaimedTask` (orquestração no worker)
**What:** Preparar código → `buildCommand/startExecutor` → eventos em lote 500 ms → heartbeat → cancel → commit → entrega → `result`.
**Where:** `src/worker/run-task.ts`
**Depends on:** T8, T9, T10 · **Requirement:** WRK-03, WRK-05, CODE-01..03
**Done when:** [ ] teste de integração: painel (handlers) + worker com executor fake (script que emite JSONL) chega a `done` com branch importado · [ ] cancel mata o processo em ≤ 30 s
**Tests:** integration · **Gate:** full

### T12: Loop `carbon worker` + build do worker
**What:** `loop.ts` (slots paralelos, SIGTERM gracioso) e subcomando `carbon worker` em `bin/carbon.mjs`; build `dist/worker.mjs` (esbuild).
**Where:** `src/worker/loop.ts`, `bin/carbon.mjs`, `package.json` (script `build:worker`)
**Depends on:** T11 · **Requirement:** WRK-06
**Done when:** [ ] 2 workers locais processam 3 tarefas pool em paralelo (teste manual documentado + teste de loop com claim mockado)
**Tests:** unit · **Gate:** build

### T13: Entrypoint AgentCore no container [P]
**What:** `agentcore-entry.ts`: HTTP 8080, `POST /invocations` → 202 + `runClaimedTask` em background via `claimSpecific`; `GET /ping` Healthy/HealthyBusy.
**Where:** `src/worker/agentcore-entry.ts`
**Depends on:** T11 · **Requirement:** AGC-02
**Done when:** [ ] teste: invocação responde < 1 s; `/ping` muda para HealthyBusy durante a tarefa e volta
**Tests:** unit · **Gate:** quick

### T14: Dispatcher AgentCore no painel [P]
**What:** `runtimes/agentcore.ts`: loop de dispatch, `maxConcurrent`, Invoke com token de tarefa, Stop ao fim, retry 3x.
**Where:** `src/server/runtimes/agentcore.ts`, `package.json` (`@aws-sdk/client-bedrock-agentcore` com versão fixa)
**Depends on:** T11 · **Requirement:** AGC-01, AGC-03
**Done when:** [ ] testes com cliente SDK mockado: concorrência respeitada, sessionId ≥ 33 chars, Stop chamado em done/failed/cancel
**Tests:** unit · **Gate:** quick

### T15: Settings AgentCore + seletor "Onde rodar"
**What:** Settings (`agentcore`, `panelPublicUrl`, `workers`), disponibilidade com motivo, campo `runtime` na criação de tarefa.
**Where:** `src/server/repo/settings.ts`, `src/app/api/tasks/route.ts`, componente de criação de tarefa, página de settings
**Depends on:** T14 · **Requirement:** AGC-04, WRK-01
**Done when:** [ ] sem ARN/credencial → opção desabilitada com motivo · [ ] padrão continua `local`
**Tests:** unit (settings) · **Gate:** build

### T16: `Dockerfile.worker` multi-arch [P]
**What:** Node 22 + git + Claude Code (+ Codex por build-arg), usuário não-root, `dist/worker.mjs`.
**Where:** `deploy/worker/Dockerfile`
**Depends on:** T12 · **Requirement:** SET-01, SET-02, SET-03
**Done when:** [ ] `docker buildx build --platform linux/amd64,linux/arm64` ok (local) · [ ] `carbon worker --version` no container
**Tests:** none · **Gate:** build

### T17: Gerador Compose + Kubernetes [P]
**What:** `renderCompose`, `renderK8s` puras → arquivos (ver design §8).
**Where:** `src/server/setup-kit/compose.ts`, `k8s.ts`
**Depends on:** T12 · **Requirement:** SET-01, SET-02
**Done when:** [ ] snapshot tests · [ ] nenhum segredo real nos arquivos (teste) · [ ] YAML válido (parse)
**Tests:** unit (snapshot) · **Gate:** quick

### T18: Gerador AgentCore (Dockerfile arm64, IAM, deploy.sh) [P]
**What:** `renderAgentCore` → `Dockerfile`, `iam-policy.json`, `deploy.sh`, `README.md`.
**Where:** `src/server/setup-kit/agentcore.ts`
**Depends on:** T13 · **Requirement:** SET-03
**Done when:** [ ] snapshot test · [ ] `deploy.sh` passa `shellcheck` · [ ] nada executa na AWS
**Tests:** unit (snapshot) · **Gate:** quick

### T19: Admin "Máquinas" + CLI `worker init`
**What:** `POST/GET/DELETE /api/admin/workers` (cria, lista com status, revoga, devolve kit `.tar.gz`); página Admin → Máquinas; `carbon worker init --target compose|k8s|agentcore --out`.
**Where:** `src/app/api/admin/workers/**`, `src/components/admin/Machines*.tsx`, `bin/carbon.mjs`
**Depends on:** T15, T17, T18 · **Requirement:** SET-04, FLT-01, SEC-01
**Done when:** [ ] token aparece uma vez · [ ] revogar funciona · [ ] status online/ocupado/offline pela `last_seen_at`
**Tests:** unit (rotas) · **Gate:** build

### T20: Proxy listener `CARBON_WORKER_LISTEN` [P]
**What:** Proxy em `bin/carbon.mjs` que expõe só `/api/worker/*`; resto 404; limite de corpo; docs de túnel (Cloudflare Tunnel/Tailscale).
**Where:** `bin/carbon.mjs`, `bin/worker-proxy.mjs` (novo), `README.md`
**Depends on:** T12 · **Requirement:** SEC-02
**Done when:** [ ] teste: `/` e `/api/tasks` → 404 na porta pública; `/api/worker/hello` encaminhado
**Tests:** unit · **Gate:** quick

### T21: Placement na UI da tarefa
**What:** Badge "rodou em: esta máquina / worker X / AgentCore"; cancel funciona para remoto.
**Where:** `src/components/mission/*`
**Depends on:** T19 · **Requirement:** FLT-01, WRK-05
**Done when:** [ ] verificação manual em dev + build verde · **Tests:** none · **Gate:** build

### T22: Permissões remotas (P2)
**What:** `permission_request` remoto → pendência no painel → long-poll de resposta no worker → `respond` no executor.
**Where:** `src/app/api/worker/tasks/[id]/permissions/route.ts`, `src/worker/run-task.ts`, `src/server/runner/runner.ts`
**Depends on:** T21 · **Requirement:** RMT-01
**Done when:** [ ] teste de integração com executor fake pedindo permissão · **Tests:** integration · **Gate:** full

### T23: Perguntas e retomada remota (P2)
**What:** `waiting` → resposta → requeue no mesmo `runtime`; retomada por decisões no prompt (sem `--resume` remoto).
**Where:** `src/server/runner/runner.ts`, `src/server/runner/questions.ts`
**Depends on:** T22 · **Requirement:** RMT-02
**Done when:** [ ] teste: pergunta → resposta → nova execução recebe decisões · **Tests:** unit · **Gate:** full

### T24: E2E, docs e revisão de segurança
**What:** Roteiro E2E (painel + 2 workers Compose; AgentCore via entrypoint local + SDK mockado), README (seções Workers e AgentCore — esta marcada **experimental, não validada em AWS real**, listando as premissas incertas do design como avisos), atualizar "Segurança" e "Limites", revisão com agente `security-reviewer`.
**Where:** `README.md`, `docs/`, `.specs/features/distributed-execution/`
**Depends on:** T23, T16, T20 · **Requirement:** todos (verificação)
**Done when:** [ ] Success Criteria do spec checados com evidência · [ ] nenhum achado CRITICAL/HIGH aberto
**Tests:** e2e (manual roteirizado) · **Gate:** build

---

## Validação pré-aprovação

### Check 1 — Granularidade
| Task | Uma entrega? | OK |
|---|---|---|
| T1–T2 | docs / spike | ✅ |
| T3 | migração + repo do mesmo domínio | ✅ |
| T4, T5, T6, T8, T9, T13, T14, T16, T17, T18, T20 | um módulo cada | ✅ |
| T7 | rotas do mesmo recurso + extração `live.ts` necessária | ✅ (limite; dividir se passar de ~300 linhas) |
| T10 | rotas bundle/result + importador (mesmo fluxo) | ✅ |
| T11, T12, T15, T19, T21–T24 | um fluxo cada | ✅ |

### Check 2 — Diagrama × Depends on
| Task | Depends on (definição) | Diagrama | OK |
|---|---|---|---|
| T3 | T1 | T1→T3 | ✅ |
| T4 | T3 | T3→T4 | ✅ |
| T5 | T3 | (fase 1, após migração) | ✅ |
| T6 | T1 | T1→T6 | ✅ |
| T7 | T4,T5,T6 | T4/T5/T6→T7 | ✅ |
| T8,T9,T10 | T7 | T7→T8/T9/T10 | ✅ |
| T11 | T8,T9,T10 | →T11 | ✅ |
| T12 | T11 | T11→T12 | ✅ |
| T13,T14 | T11 | T11→T13/T14 | ✅ |
| T15 | T14 | T14→T15 | ✅ |
| T16,T17,T20 | T12 | T12→ | ✅ |
| T18 | T13 | (fase 4) | ✅ |
| T19 | T15,T17,T18 | →T19 | ✅ |
| T21→T22→T23 | sequência | T19→T21→T22→T23 | ✅ |
| T24 | T23,T16,T20 | →T24 | ✅ |

Nota: no diagrama da fase 1, T5 sai de T2 por legibilidade; a dependência real é T3 (migração cria `workers`). Workers Orca respeitam a definição.

### Check 3 — Testes co-localizados
| Camada | Exige | Tasks | OK |
|---|---|---|---|
| repo/scheduler/auth | unit | T3,T4,T5 | ✅ |
| rotas API | unit | T7,T10,T19,T20 | ✅ |
| worker | unit/integration | T8,T9,T11,T12,T13 | ✅ |
| AWS SDK | unit com mock | T14 | ✅ |
| geradores | snapshot | T17,T18 | ✅ |
| UI | none (build) | T15,T21 | ✅ (sem infra de teste de UI hoje) |

---

## Ferramentas por tarefa (proposta — confirmar)

| Tasks | Executor | Skills/MCP |
|---|---|---|
| T1 | eu (coordenador) | `tlc-spec-driven` |
| T2 | cancelado (U5) | — |
| T3–T7 | workers Orca (`claude`), fase 1: T5 e T6 em paralelo | `tdd-guide`, `database-reviewer` em T3 |
| T8–T10 | 3 workers Orca em paralelo | — |
| T11–T15 | worker Orca sequencial; T13/T14 em paralelo | `security-reviewer` em T5/T14 |
| T16–T20 | workers Orca em paralelo | — |
| T21–T24 | sequencial | `security-reviewer`, `e2e-runner` em T24 |
