# Carbon SuperAgent — plano e decisões

> Documento de trabalho: decisões de arquitetura, fases e riscos. O estado atual do produto está no [README](../README.md). Base conceitual: [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype).

## 0. Premissas e decisões (validar)

| # | Decisão | Por quê | Status |
|---|---|---|---|
| D1 | **Portar o modelo de domínio** do dsh-superagent, **não** o runtime | O protótipo depende do DeepSeek Harness (`@deepseek-ai/dsh-*` 0.2.1-alpha), runtime alpha, single-repo, sem Linear. Rodar em cima dele trava a plataforma num runtime instável. O valor está no domínio (Source → Trigger → Thread → Eval → Ticket → Assignment → Channel) e na filosofia "mínima atenção humana". | [Provável] correto — validar se há requisito de usar DSH |
| D2 | Next.js 15 App Router + TS + Tailwind v4 + `motion` | Stack do time (Node/React), deploy simples (Vercel ou container) | Fechado |
| D3 | Executor = CLI local do usuário (`claude -p` stream-json ou `codex exec --json`) num git worktree por Ticket | Usa o plano que a pessoa já paga; sem API key nem infra; isolamento por worktree | Fechado (v0.2) |
| D4 | Local-first: `node:sqlite` (Node 22.13+) + fila serial em processo | Zero dependência nativa para quem baixa e roda; pgvector fica para o RAG (F3) | Fechado (v0.2) |
| D5 | GitHub **App** (não PAT/OAuth de usuário) + Linear **OAuth app** com webhooks | Permissão mínima por repo, identidade própria do agente, auditável | Fechado |
| D6 | Humano faz merge. Auto-merge desligado por padrão | Herdado do dsh: "people merge until the agent's PRs have been right for a while" | Fechado |
| D7 | Autoaprendizado **propõe**, humano **promove** | Regra do repo: sistemas de aprendizado não se autopromovem | Fechado |

**Tensão de design:** o DS Agno pede animação contida (e destaque laranja, trocado por verde success na v0.3) ("no infinite decorative loops"). O pedido é "impressionante, animado". Resolução: toda animação é **ligada a estado real** (agente ativo = pulso; dado fluindo = partícula na aresta; nada anima quando o sistema está ocioso). Respeita `prefers-reduced-motion`.

## 1. Domínio (portado do dsh-superagent)

```
Source(GitHub|Linear) ──Trigger──▶ Thread ──batch──▶ Eval(gate+assessment, Policy)
                                     │                    │ accept → Mandate
                                     └─Subscription───▶ Ticket ──Assignment──▶ Executor
                                                          └──Channel(outbox)──▶ PR / comentário Linear
```

- **Trigger** imutável, idempotente (aceitar 2x = 1 Ticket). Chave: `source:event_id`.
- **Eval** sem estado: gate (allowlist por Source, menção ao agente, label `agent:run` no Linear) + assessment por LLM (escopo, risco, duplicata).
- **Mandate** imutável: versão da Policy, escopo, quem pediu. Escopo maior = novo Ticket.
- **Ticket** tem estado próprio (open → ended → reopen por mensagem humana).
- **Outbox**: toda escrita externa (PR, comentário, status Linear) passa por outbox com retry e dedupe.
- **accept mode `observe`** primeiro: registra o que faria, sem fazer.

## 2. Pipeline de execução (por Ticket)

| Estágio | Agente | Saída | Gate |
|---|---|---|---|
| Intake | `triage` | Ticket normalizado (issue Linear + contexto GitHub) | Policy |
| Plan | `planner` | plano com critérios de aceite | se mudança exige decisão de design → pergunta estruturada e para |
| Research | `researcher` | contexto RAG (código, ADRs, tickets/PRs passados, lições) | — |
| Code | `coder` | commits em branch `agent/<ticket>` no sandbox | — |
| Test | `tester` | testes novos + suíte verde | falha 3x → reporta como falha, não contorna |
| Review | `reviewer` + `security-reviewer` | findings CRITICAL/HIGH resolvidos | CRITICAL bloqueia |
| Deliver | `delivery` | PR draft/ready + comentário no Linear + status | humano aprova merge |
| Reflect | `learner` | lições candidatas | humano promove |

"Para por impacto, não por esforço": mudança local vai até PR revisável; mudança que exige decisão para com uma pergunta.

## 3. Base de conhecimento (RAG)

- **Fontes indexadas:** código do repo (chunking por AST/símbolo), README/ADRs/docs, issues e PRs fechados, review comments, lições promovidas.
- **Retrieval híbrido:** BM25 (tsvector) + vetor (pgvector HNSW) → fusão RRF → rerank. Filtros por repo/path/linguagem.
- **Reindex incremental** por webhook `push` (só arquivos alterados).
- **Avaliação:** conjunto de perguntas-ouro por repo; métrica recall@k / nDCG antes de mudar chunking.

## 4. Autoaprendizado

Sinais (estruturados, não texto livre): review comment pedindo mudança, diff humano sobre o PR do agente, teste que falhou e foi corrigido, PR rejeitado, tempo até merge.

1. `learner` gera **lição candidata** (`quando X, fazer Y`, evidência linkada, escopo repo/path).
2. Painel mostra candidatas → humano **promove / descarta**.
3. Lições promovidas entram no RAG com peso; confiança decai sem reforço.
4. **Eval de regressão:** antes de promover, roda tickets históricos no modo `observe` e compara.

## 5. Segurança e compliance (LGPD)

- Segredos só em secret manager; tokens GitHub App de curta duração; nada em log.
- Sandbox sem rede por padrão; allowlist (registry npm, GitHub API).
- **Redação de PII/dados de saúde** antes de qualquer prompt e antes de indexar (repositórios podem ter fixtures/logs com dados sensíveis). Repos com dados de paciente: fora do RAG até validação do DPO/jurídico.
- Webhooks com verificação de assinatura (GitHub `X-Hub-Signature-256`, Linear `Linear-Signature`) + idempotência.
- Auditoria: cada Trigger, Decision, Mandate e escrita externa é persistida.

## 6. Fases e mapeamento ECC

| Fase | Entrega | Superfícies ECC |
|---|---|---|
| **F0** | Front "Mission Control" com motor de simulação determinístico; telas Pipeline, Conhecimento, Aprendizado, Integrações | `frontend-design`, `ui-ux-pro-max`, `react-reviewer`, `tdd-guide` (motor puro testado) |
| **v0.2 (entregue)** | CLI `npm run setup`, wizard web, login local multi-pessoa com personas, skills (criar/importar/exportar), executores Claude Code + Codex, worktree, commit/PR via gh, import Linear/GitHub, lições reais | `tdd-guide`, `security-reviewer` |
| F1 | Webhooks (GitHub App / Linear) em vez de import manual: GitHub App + Linear OAuth, webhooks assinados, tabelas Source/Trigger/Thread/Ticket, SSE substituindo o simulador | `/plan-prd`, `/prp-plan`, `architect`, `database-reviewer`, `security-reviewer`, `e2e-runner` |
| F2 | Executor (Claude Agent SDK em sandbox), pipeline Plan→Deliver em modo `observe` | `vercel:vercel-sandbox`, `claude-api`, `tdd-guide`, `code-reviewer` |
| F3 | RAG (indexação, híbrido, eval) | `RAG Pipeline Engineer`, `Search Relevance Engineer` |
| F4 | Autoaprendizado + eval de regressão + promoção no painel | `/learn`, `/evolve` (como referência de padrão), `agent-evaluator` |
| F5 | Accept mode `act`, métricas, custos por Ticket | `/quality-gate`, `/security-scan`, `/cost-report`, `e2e-runner` |

## 7. Critérios de aceite F0

- `npm run build` e `npm test` verdes.
- Simulação roda um Ticket ponta a ponta com estágios, logs, diff, PR e lição candidata.
- Dark/light, `prefers-reduced-motion`, layout funcional em 1280px e 390px.
- Nenhum token/credencial no front; botões "Conectar" chamam rotas que retornam `501` explícito enquanto F1 não existe.

## 8. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Agente abre PR ruim em repo de produção | Alto | `observe` primeiro, allowlist curta, humano faz merge |
| Vazamento de dado sensível para LLM | Alto (LGPD) | redação, exclusão de repos sensíveis, ZDR no provedor |
| Custo de tokens por Ticket descontrolado | Médio | orçamento por Ticket, corte por estágio, relatório |
| Loop de auto-aprendizado reforçando erro | Médio | promoção humana + eval de regressão |
