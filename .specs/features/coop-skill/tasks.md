# Skill "trabalho cooperativo" — Tasks

**Design**: `.specs/features/coop-skill/design.md`
**Status**: In Progress (2026-11-07) — T2,T3,T5–T10 feitos; T1 parcial; T4 virou guia manual; T11 pendente

| Task | Estado |
| --- | --- |
| T1 | Parcial: Q1/Q3/Q6/Q7 respondidas pela doc oficial; instalação no VPS bloqueada pelo modo automático (download de binário e chave em `authorized_keys`) |
| T2 preflight, T3 tunnel (+ proxy.sh, serve.sh), T5 pair, T6 code-sync | Feitos, 9 testes com ssh/orca falsos |
| T4 prepare-server | Virou `references/server-setup.md` (passos manuais com confirmação), não script |
| T7, T8 (só security + server-setup; o guia do Orca é carregado em runtime), T9, T10 | Feitos; `claude plugin validate .` ok |
| T11 UAT | Pendente: precisa do Orca e da chave no servidor |

## Plano de execução

```
Fase 0 (gate):  T1 spike ──► revisar design se Q1–Q6 mudarem algo
Fase 1:         T2 ─┬─► T4 ─► T5
                T3 ─┘
Fase 2 [P]:     T6, T7, T8 (dependem de T5)
Fase 3:         T9 ─► T10 ─► T11
```

Orquestração (skill `orchestration`): o coordenador é esta sessão; tarefas `[P]` viram um worker Orca cada
(`worker-start --worktree new-child --agent claude`), cada um com só a própria task + TESTING.md. T1 e T11 rodam
na sessão principal (precisam do VPS e de decisão humana).

## Tasks

| ID | O quê | Onde | Depende | Pronto quando | Testes / Gate | Req |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | **Spike** Q1–Q6 no VPS de teste, sem código de produto | notas em `context.md` | — | Cada Q com [Certo]/[Incerto] + evidência | manual | todos |
| T2 | `scripts/preflight.sh` (JSON) | `skills/carbon-coop/scripts/` | T1 | Detecta cada falta; nunca lê segredo (`-w`) | bats ou vitest chamando o script com PATH falso; quick | COOP-01,02 |
| T3 | `scripts/tunnel.sh start/stop/status` | idem | T1 | PID file 0600; escolhe porta livre | teste com `ssh` falso; quick | COOP-05,20 |
| T4 | `scripts/prepare-server.sh` idempotente | idem | T2 | 2ª execução não muda nada; sem sudo/docker para `carbon` | rodar 2× no VPS; manual | COOP-03,06 |
| T5 | `scripts/pair.sh` | idem | T3,T4 | `orca environment list` mostra servidor; code ausente do stdout | teste: stdout não casa `orca://pair` | COOP-07,08 |
| T6 [P] | `scripts/code-sync.sh push/fetch` | idem | T5 | base sobe, `coop/<slug>` volta; recusa `blockedRepos` | git real em tmp (padrão `local-delivery.test.ts`) | COOP-10,11 |
| T7 [P] | `templates/worker-spec.md` | idem | T5 | Contém objetivo, critério, push para bare, sem infra, `ask` em dúvida | snapshot | COOP-12 |
| T8 [P] | `references/orca.md`, `references/security.md` | idem | T5 | Sem copiar o guia do Orca; aponta `orca skills get` | revisão | COOP-13,15 |
| T9 | `SKILL.md` (connect/dispatch/status/disconnect) | `skills/carbon-coop/` | T6,T7,T8 | Fluxo P1 completo referenciando scripts | `npm run check` | COOP-12..22 |
| T10 | `.claude-plugin/plugin.json` + seção no README/docs | raiz, `docs/distributed/` | T9 | `/plugin install` pelo repo carrega a skill | build | U3 |
| T11 | **UAT** ponta a ponta no VPS | — | T10 | Success Criteria da spec ✅ (incl. grep de segredos e `ss -tlnp`) | manual | todos P1 |

## Checagens

- Granularidade: cada task = 1 script/arquivo ✅
- Diagrama × `Depende`: T2,T3←T1; T4←T2; T5←T3,T4; T6–T8←T5; T9←T6–T8; T10←T9; T11←T10 ✅
- Testes × TESTING.md: scripts de git usam git real em tmp (parallel-safe) ✅; doc/skill = none + build ✅
