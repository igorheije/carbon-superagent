# Execução distribuída — Design

**Spec:** `.specs/features/distributed-execution/spec.md`
**Status:** Done (2026-11-06) — T1, T3–T25 entregues; T2 cancelado (U5)

Legenda de confiança: [Certo] lido no código/doc oficial · [Provável] inferência · [Incerto] validar antes de implementar.

---

## Ideia central

**Um só protocolo de worker para tudo.** O mesmo pacote "worker" roda:

1. **Local** (como hoje, dentro do processo do painel — sem rede);
2. **Pool** (Compose/K8s em outras máquinas) — loop de *claim* de qualquer tarefa `pool`;
3. **AgentCore** — container invocado pelo painel para **uma** tarefa específica; dentro dele o mesmo worker faz claim *daquela* tarefa e reporta pelo mesmo protocolo.

O painel continua dono de **estado, fila, entrega e UI**. Worker é só "braço": prepara código, roda o executor (Claude/Codex CLI) e manda eventos. Assim o AgentCore não exige um segundo caminho de streaming: [Certo] o stream do Invoke fecha em 60 min e o Invoke síncrono em 15 min — o painel **não depende** do stream; o container fala com o painel por HTTPS de saída, igual a um worker de pool.

```mermaid
graph LR
  UI[Painel UI / SSE] --- C[(SQLite: tasks + leases + workers)]
  subgraph Painel central
    R[Scheduler] --> C
    WAPI["/api/worker/* (listener separado)"] --> C
    D[AgentCore dispatcher] -->|InvokeAgentRuntime / StopRuntimeSession| AWS
  end
  subgraph Máquina A/B (Compose ou K8s)
    W1[carbon worker] -->|claim/eventos/entrega HTTPS| WAPI
    W2[carbon worker] --> WAPI
  end
  subgraph AWS sa-east-1
    AWS[AgentCore Runtime microVM] -->|mesmo protocolo HTTPS| WAPI
  end
  W1 -->|clone/push| GIT[(Git remoto)]
  AWS -->|clone/push| GIT
  R -->|git fetch branch / importa bundle| REPO[(repo local do projeto)]
```

---

## Mudança no modelo: `runtime` separado de `executor`

[Certo] `executor` é union fechado `"claude" | "codex"` com CHECK no SQLite (`db.ts:167`). Em vez de enfiar `agentcore` ali (exigiria rebuild da tabela e misturaria "qual CLI" com "onde roda"), adiciona-se **uma coluna nova**:

```ts
// src/lib/domain/types.ts
export type TaskRuntime = "local" | "pool" | "agentcore";

export interface TaskPlacement {
  readonly runtime: TaskRuntime;
  readonly workerId: string | null;        // quem tem o lease
  readonly workerName: string | null;      // para a UI
  readonly agentcoreSessionId: string | null;
}
```

Migração (append em `db.ts`, sem CHECK novo para não precisar rebuild):

```sql
ALTER TABLE tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'local';
ALTER TABLE tasks ADD COLUMN lease_worker TEXT;
ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER;   -- epoch ms
ALTER TABLE tasks ADD COLUMN lease_seq INTEGER NOT NULL DEFAULT 0; -- último evento aceito
ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tasks_runtime_queue ON tasks (runtime, status, position);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'pool' | 'agentcore'
  token_hash TEXT NOT NULL UNIQUE, -- sha256 (mesmo padrão de sessions)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  version TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}'  -- JSON: executors, git, max_parallel
);

CREATE TABLE IF NOT EXISTS task_tokens (   -- uso único para AgentCore
  token_hash TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
```

Validação do valor de `runtime` fica no schema zod da API (`schemas.ts`), não em CHECK.

---

## Code Reuse Analysis

| Existente | Local | Uso |
|---|---|---|
| `applyExecutorEvent` (puro) | `src/server/runner/apply.ts:87` | Painel aplica eventos remotos com o mesmo redutor |
| `ExecutorEvent` normalizado | `src/server/executors/events.ts` | Formato do fio worker→painel (já serializável) |
| `buildCommand` / `startExecutor` | `src/server/executors/spawn.ts` | Worker executa a CLI exatamente como hoje |
| Prompt e marcadores `CARBON_*` | `runner/prompt.ts`, `protocol.ts` | Painel monta o prompt e envia no claim (worker não precisa de DB) |
| `prepareWorktree`, `commit`, diff | `runner/worktree.ts`, `workspace.ts` | Worker usa em clone próprio; painel usa para importar branch |
| `NO_COMMITS_BASE` / `baseCommitOf` | `runner/local-delivery.ts` | Bundle para repo sem commits |
| `pushAndOpenPr`, `applyToWorkingDir`, `mergeIntoBranch` | `workspace.ts`, `local-delivery.ts` | Inalterados: operam sobre o branch já importado |
| `saveSnapshot` + throttle + `notify` | `runner.ts:68-89` | Extrair para módulo reutilizável pelo handler de eventos remotos |
| Hash de token (sha256) + `handle()`/`HttpError` | `repo/users.ts`, `http.ts` | Auth de worker |
| Rate limit em memória | `auth/rate-limit.ts` | Rate limit por token |
| `bin/carbon.mjs` (subcomandos) | `bin/carbon.mjs:293` | `carbon worker`, `carbon worker init` |
| `recoverInterruptedTasks` | `repo/tasks.ts:163`, `instrumentation.ts` | Passa a filtrar `runtime='local'` |

---

## Componentes

### 1. Scheduler (painel) — `src/server/runner/scheduler.ts`
- **Propósito:** separar "quem executa" de "fila". `kick()` atual só pega `runtime='local'`; o resto fica para claim/dispatcher.
- **Interfaces:**
  - `claimNext(workerId, caps, leaseMs): ClaimedTask | null` — transação `BEGIN IMMEDIATE`; `UPDATE tasks SET status='running', lease_worker=?, lease_expires_at=? WHERE id=(SELECT id FROM tasks WHERE runtime='pool' AND status='queued' AND executor IN (...) ORDER BY position LIMIT 1) AND status='queued' RETURNING *`.
  - `claimSpecific(taskId, workerId)` — usado pelo AgentCore.
  - `renew(taskId, workerId): {cancel: boolean} | 'lease_lost'`.
  - `sweepExpiredLeases(now)` — a cada 15 s; expira → `failed` ("worker sumiu") ou `queued` se `settings.requeueOnLeaseLoss`.
- **Reusa:** `repo/tasks.ts`.

### 2. API de worker — `src/app/api/worker/**`
Rotas (todas com `requireWorker()`; JSON `{success,data,error}` via `handle()`):

| Método/rota | Corpo → Resposta |
|---|---|
| `POST /api/worker/hello` | `{version, executors[], git:boolean, maxParallel}` → `{protocol:1, leaseMs, pollMs}` (426 se versão velha) |
| `POST /api/worker/claim` | `{executors[]}` → `ClaimedTask` ou 204 (long-poll até 25 s) |
| `POST /api/worker/tasks/:id/heartbeat` | `{}` → `{cancel:boolean}` ou 409 `lease_lost` |
| `POST /api/worker/tasks/:id/events` | `{seq, events: ExecutorEvent[]}` → `{acceptedSeq}` (idempotente por `seq`) |
| `GET  /api/worker/tasks/:id/bundle` | → `application/octet-stream` (git bundle da base) |
| `POST /api/worker/tasks/:id/result` | `{status, branch, commit, transport:'push'|'bundle', error?}` + bundle opcional (multipart/stream, limite 200 MB) |
| `GET  /api/worker/tasks/:id/permissions` | long-poll de respostas de permissão (P2) |

`ClaimedTask` = tudo que o worker precisa sem acessar o DB:
```ts
interface ClaimedTask {
  taskId: string; key: string; leaseMs: number;
  executor: "claude" | "codex"; model: ModelChoice;
  prompt: string;                    // montado no painel (prompt.ts + skills + memória/PROJECT_MAP como texto)
  resume: { decisions: string[] } | null;
  code: { transport: "git"; remoteUrl: string; baseRef: string; branch: string }
      | { transport: "bundle"; baseRef: string; branch: string; bundleUrl: string };
  limits: { maxRunMinutes: number };
  permissionRules: PermissionRule[];  // allowlist já resolvida
}
```

### 3. Auth de máquina — `src/server/auth/worker-auth.ts`
- `createWorker(name, kind, adminId) → {worker, token}` (token 32 bytes base64url, prefixo `cwk_`; só hash no banco).
- `requireWorker(req) → Worker` (Bearer; 401 genérico; atualiza `last_seen_at` com throttle).
- `issueTaskToken(taskId, ttl) / consumeTaskToken(token, taskId)` para AgentCore (uso único, TTL = maxLifetime).
- `middleware.ts`: `/api/worker/` fora da checagem de cookie/origem, mas **com** Bearer obrigatório no handler.

### 4. Listener separado — `bin/carbon.mjs` + `src/server/worker-gateway.ts`
- [Certo] hoje `next start -H 127.0.0.1`. Opção `CARBON_WORKER_LISTEN=0.0.0.0:3418`: um servidor HTTP pequeno (node:http) no mesmo processo... **[Incerto]** Next em `next start` não expõe hook para segundo listener; alternativa robusta: **proxy reverso mínimo** em `bin/carbon.mjs` que escuta na porta pública e **só encaminha `/api/worker/*`** para o Next em localhost; qualquer outra rota → 404. Recomendação: proxy (sem mexer no Next).
- Documentar exposição: Cloudflare Tunnel / Tailscale (preferido) / reverse proxy com TLS. Nunca HTTP puro fora de LAN/VPN.

### 5. Worker runtime (pacote reutilizável) — `src/worker/`
Código **sem** `server-only`, sem DB, roda em Node puro (empacotado com `tsx` ou build `esbuild` para `dist/worker.mjs`).
- `client.ts` — cliente HTTP do protocolo (retry exponencial, buffer de eventos com `seq`, limite 5 MB).
- `code.ts` — prepara código: `git clone --filter=blob:none --branch <base>` ou `git clone` de bundle; cria branch `agent/*`; ao fim `git push` ou `git bundle create <base>..<branch>`.
- `run-task.ts` — `runClaimedTask(task, client)`: prepara código → `buildCommand`/`startExecutor` (reuso direto de `src/server/executors/spawn.ts`, que precisa deixar de importar `server-only` → mover para `src/shared/executors/` com re-export) → envia eventos em lote a cada 500 ms → heartbeat a cada `leaseMs/3` → commit → entrega → `result`.
- `loop.ts` — `carbon worker`: `hello` → N slots (`CARBON_WORKER_PARALLEL`, padrão 1) → claim long-poll → `runClaimedTask`. SIGTERM: para de fazer claim, espera tarefas até `graceSeconds`, senão cancela e reporta `failed`.
- `agentcore-entry.ts` — servidor HTTP na porta 8080: `POST /invocations` `{taskId, panelUrl, taskToken}` → responde 202 imediato e chama `runClaimedTask` em background; `GET /ping` → `{"status":"HealthyBusy"}` enquanto há tarefa, `"Healthy"` quando ocioso. [Certo] contrato porta 8080, `/invocations`, `/ping`, arm64.

### 6. Dispatcher AgentCore (painel) — `src/server/runtimes/agentcore.ts`
- Dependência: `@aws-sdk/client-bedrock-agentcore` [Certo nome do pacote; tipo exato do stream no SDK JS: Incerto].
- `dispatch(task)`: se sessões ativas < `agentcore.maxConcurrent` → `issueTaskToken` → `InvokeAgentRuntimeCommand({agentRuntimeArn, qualifier, runtimeSessionId: "carbon-task-" + task.id.padEnd(33,"0"), payload: JSON})` → marca `running`, `agentcoreSessionId`. Não lê o stream além do ack.
- `onFinish(task)`: `StopRuntimeSessionCommand` (libera custo; [Certo] sessão ociosa cairia em 15 min de qualquer jeito).
- Loop: a cada 5 s pega `runtime='agentcore' AND status='queued'`.
- Credenciais AWS: cadeia padrão do SDK no host do painel (`AWS_PROFILE`/SSO/env). Nada de chave AWS no SQLite.
- Settings novos (`repo/settings.ts`): `agentcore: {enabled, region:"sa-east-1", runtimeArn, qualifier, maxConcurrent:3}`; `panelPublicUrl`; `workers: {leaseMs:60000, requeueOnLeaseLoss:false, maxBundleMb:200}`.

### 7. Importação do resultado (painel) — `src/server/runner/remote-delivery.ts`
- `transport=push` → `git fetch <remote> agent/x:agent/x` no `repoPath`.
- `transport=bundle` → `git bundle verify` + `git fetch <bundle> agent/x:agent/x`.
- Depois: preenche `workspace {branch, base, commit, isActive:false}` e `diff` (via `git diff --numstat base..branch`) → reaproveita `deliver` existente (push+PR se `autoPush`).

### 8. Gerador de setup — `src/server/setup-kit/`
Funções puras `renderCompose(opts)`, `renderK8s(opts)`, `renderAgentCore(opts)` → `Record<path, string>`; zip via `node:zlib`+tar ou lib pequena [Incerto: escolher lib zip; alternativa `.tar.gz` nativo]. Rota `POST /api/admin/workers` cria worker + devolve kit; CLI `carbon worker init`.
- Imagem do worker: `Dockerfile.worker` multi-arch (`linux/amd64,linux/arm64`): Node 22 + git + `@anthropic-ai/claude-code` + `@openai/codex` (opcional por build-arg) + `dist/worker.mjs`. Usuário não-root.
- Compose: serviço `worker` com `restart: unless-stopped`, `env_file: .env`, volume para cache de clones, `stop_grace_period: 120s`.
- K8s: `Deployment` (replicas N, `terminationGracePeriodSeconds: 600`, requests/limits), `Secret` (token, credenciais de modelo/git como placeholders), `NetworkPolicy` só egress.
- AgentCore: `Dockerfile` (arm64), `iam-policy.json` (mínimo: ECR pull, logs), `deploy.sh` (buildx → ECR → `aws bedrock-agentcore-control create-agent-runtime|update-agent-runtime` com `maxLifetime`, `idleRuntimeSessionTimeout`), `README.md`. **Não executa nada na AWS.**

### 9. UI
- `TaskForm`/criação: seletor "Onde rodar: Esta máquina · Pool de workers · AgentCore" (desabilitado com motivo quando indisponível).
- Card de tarefa: badge de placement (worker/sessão).
- Admin → "Máquinas": lista (FLT-01), "Adicionar máquina" (gera kit), revogar.

---

## Credenciais (regra)

| Credencial | Onde vive | Nunca |
|---|---|---|
| Token do worker | `.env`/Secret na máquina worker; hash no painel | em log, no snapshot |
| Login do modelo (Claude/Codex) | Na máquina/imagem do worker (`ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`) | sair do painel para o worker |
| Token git (push) | Worker: env `GIT_TOKEN` ou credential helper; AgentCore: Secrets Manager/AgentCore Identity [Incerto qual] | no `ClaimedTask` |
| AWS (painel → Invoke) | Cadeia padrão do SDK no host do painel | no SQLite |
| Token de tarefa AgentCore | Payload do Invoke, uso único, TTL | reutilizável |

Logs de evento do agente podem conter código e segredos do repo: mesma política atual (fica no SQLite local, `chmod 600`).

---

## Error Handling

| Cenário | Tratamento | Usuário vê |
|---|---|---|
| Worker some (sem heartbeat) | `sweepExpiredLeases` → failed/requeue | "worker X parou de responder às 14:02" |
| Evento com lease perdido | 409 `lease_lost`; worker cancela local | nada (tarefa já reatribuída) |
| Push recusado | Worker tenta bundle; se painel negar → failed | "push sem permissão no remoto" |
| Bundle > limite | 413 | "resultado maior que 200 MB" |
| AgentCore Invoke falha (throttle/credencial) | Retry 3x com backoff; depois failed | mensagem do SDK resumida |
| Sessão AgentCore atinge 8h | Container reporta failed antes; painel faz Stop | "limite de 8h do AgentCore" |
| Versão de protocolo antiga | 426 | worker loga e sai com código 2 |
| Painel reinicia | Tarefas remotas mantidas; workers reenviam buffer | sem perda |

---

## Tech Decisions

| Decisão | Escolha | Motivo |
|---|---|---|
| `runtime` como coluna nova | não mexer em `executor` | Evita rebuild de tabela por CHECK; separa "qual CLI" de "onde roda" |
| Pull (long-poll HTTPS) | sem WebSocket | Atravessa NAT/proxy; decisão U4; simples de testar |
| AgentCore usa o mesmo protocolo | não consumir stream do Invoke | [Certo] stream 60 min, Invoke síncrono 15 min |
| Prompt montado no painel | worker sem DB | Worker fino; skills/memória/PROJECT_MAP continuam centrais |
| Listener separado por proxy | não expor UI | Minimiza superfície; UI segue em localhost |
| SQLite com `BEGIN IMMEDIATE` para claim | sem Postgres | Suficiente para dezenas de workers [Provável] |
| Imagem multi-arch | amd64 + arm64 | arm64 obrigatório no AgentCore [Certo]; amd64 para PCs |

## Riscos e validações (não bloqueiam — viram avisos na documentação, decisão U5)

1. **[Incerto]** Egress de internet no modo de rede público do AgentCore (clone/push, API do modelo) — validar com runtime de teste.
2. **[Incerto]** Login do Claude Code em container sem browser: usar `ANTHROPIC_API_KEY` ou Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) dentro do AgentCore — custo e termos a validar.
3. **[Incerto]** Tipo do stream de resposta do `InvokeAgentRuntimeCommand` no SDK JS (só precisamos do ack).
4. Expor o painel muda o modelo de ameaça (README diz "só localhost"): revisão de segurança obrigatória antes do merge (SEC-*).
5. Mover `spawn.ts`/parsers para fora de `server-only` pode afetar imports do Next — tarefa isolada com gate de build.
