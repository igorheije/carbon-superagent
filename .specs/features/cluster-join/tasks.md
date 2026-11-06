# Cluster join — Tasks

Gate padrão de cada tarefa: `npx vitest run <arquivos tocados>`; ao fim de cada bloco: `npm run check`.

| ID | O quê | Onde | Depende | Reqs | Feito quando | Status |
|---|---|---|---|---|---|---|
| T1 | Migração: colunas `availability`, `joined_via`, `hostname` + tabela `join_tokens`; setting `workers.requireJoinApproval` | `server/db.ts`, `repo/settings.ts` | — | NODE-01, JOIN-01 | migração idempotente; teste de schema | Done |
| T2 | Repo de workers: campos novos, `setAvailability`, `createWorker` com opções | `repo/workers.ts`, `auth/worker-auth.ts` | T1 | NODE-01 | testes de repo | Done |
| T3 | Tokens de join: girar/desativar/info/consumir (atômico, ttl, max-uses) | `auth/join-tokens.ts` (+test) | T1 | JOIN-01, JOIN-02 | corrida max-uses=1 → só 1 consome; girar invalida anterior | Done |
| T4 | Rotas worker `join` e `leave` + rate limit por IP | `app/api/worker/join`, `leave` | T2, T3 | JOIN-04, JOIN-07 | 201 com cwk_; 401 genérico; 429; pending quando aprovação ligada | Done |
| T5 | Claim respeita disponibilidade (relida a cada iteração) + `hello` devolve `availability` | `worker/_lib/claim.ts`, `hello/route.ts`, `shared/worker-protocol.ts` | T2 | NODE-02 | nó pausado não recebe tarefa; pausa no meio do poll respeitada | Done |
| T6 | Rotas admin: join-token (GET/POST/DELETE), availability, remover offline; frota com status combinado | `app/api/admin/workers/**`, `_lib/fleet.ts` | T3, T5 | JOIN-01, NODE-03, NODE-04 | testes de rota (admin only, 403 member) | Done |
| T7 | Gerador puro dos comandos de join (CLI + docker) | `setup-kit/join-command.ts` | — | UI-01 | snapshot + escape do token | Done |
| T8 | Worker: `node-state.ts` (0600, atômico, por hostname) | `src/worker/node-state.ts` | — | JOIN-05 | testes de permissão/corrupção | Done |
| T9 | Worker: client `join`/`leave`, `join.ts`, config (`STATE_DIR`, `JOIN_TOKEN`), main subcomandos, `EXIT_REMOVED` | `src/worker/*` | T8, T4 (contrato) | JOIN-05, JOIN-06, JOIN-07 | testes com painel fake | Done |
| T10 | CLI: `carbon join`, `carbon leave`, `carbon join-token` | `bin/carbon.mjs`, `bin/join-token.mjs` | T3, T9 | JOIN-03 | teste do parser + execução em DB temporário | Done |
| T11 | UI: bloco "Entrar no cluster" + ações por nó | `components/settings/Machines*`, `lib/client/api.ts` | T6, T7 | UI-01, UI-02 | verificação visual 1440/390 | Done |
| T12 | Kits: Compose modo join (volume de estado), K8s StatefulSet | `setup-kit/compose.ts`, `k8s.ts` | T9 | KIT-01, KIT-02 | snapshots atualizados de propósito | Deferred (docker run cobre containers) |
| T13 | E2E local: painel + 2 workers com o mesmo cjt_; pausa; rotação; restart sem duplicar | script em scratchpad | T1–T10 | Success Criteria | roteiro executado e registrado | Done |
| T14 | Docs `docs/distributed/cluster-join.md` + links | `docs/`, `README.md` | T13 | DOC-01 | revisado | Done |

Paralelizável: [T3, T7, T8] após T1; [T11, T12] após T6/T9.
