# Cluster join — Design

**Spec:** `.specs/features/cluster-join/spec.md`
Legenda: [Certo] lido no código · [Provável] inferência · [Incerto] validar.

## Ideia central

Join é só **uma troca de credencial**: `cjt_` (token do cluster, compartilhado) → `cwk_` (credencial do nó, exclusiva).
Depois do join, o nó é um worker `pool` comum: mesmo `hello`, `claim`, heartbeat, eventos e entrega da
execução distribuída. Nada no protocolo de tarefa muda (`PROTOCOL_VERSION` inalterado; o join é rota nova).

```mermaid
sequenceDiagram
  participant A as Admin (painel)
  participant P as Painel /api/worker/*
  participant N as Servidor novo
  A->>P: gerar/girar token de join (cjt_, só hash salvo)
  A-->>N: copia "carbon join https://painel --token cjt_…"
  N->>P: POST /api/worker/join (Bearer cjt_) {name, hostname, executors, parallel, version}
  P->>P: valida + conta uso (transação) + cria worker pool (joined_via=join, availability=active|pending)
  P-->>N: 201 {nodeId, token: cwk_…, availability}
  N->>N: grava <stateDir>/nodes/<hostname>.json (0600)
  N->>P: hello / claim (Bearer cwk_) — loop normal
  A->>P: pausar / retomar / aprovar / remover nó
  P-->>N: claim → 204 enquanto pausado/pendente; 401 se removido → exit 3
```

## Banco (migração append em `db.ts`) [Certo: padrão `MIGRATIONS` + `PRAGMA user_version`]

```sql
ALTER TABLE workers ADD COLUMN availability TEXT NOT NULL DEFAULT 'active'; -- active | paused | pending
ALTER TABLE workers ADD COLUMN joined_via TEXT NOT NULL DEFAULT 'manual';   -- manual | join
ALTER TABLE workers ADD COLUMN hostname TEXT;
CREATE TABLE IF NOT EXISTS join_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,          -- null = sem validade
  max_uses INTEGER,            -- null = ilimitado
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
```
Valores validados em zod/TS, sem CHECK (mesma regra da coluna `runtime`).

Setting novo: `workers.requireJoinApproval: boolean` (padrão `false`).

## Componentes (painel)

| Módulo | Responsabilidade |
|---|---|
| `src/server/auth/join-tokens.ts` | `rotateJoinToken(adminId, {ttlMs?, maxUses?}) → {token, info}` (revoga os ativos e cria um, numa transação) · `disableJoinToken()` · `joinTokenInfo()` (sem segredo: criado em, expira, usos) · `consumeJoinToken(token, now)` (UPDATE condicional `uses < max_uses AND expires_at > now AND revoked_at IS NULL`, `RETURNING`) |
| `src/server/auth/worker-auth.ts` | exporta guarda de falhas por IP para reuso; `createWorker` ganha opções `{joinedVia, hostname, availability}` |
| `src/server/repo/workers.ts` | colunas novas no `Worker`; `setAvailability(id, a)`; `deleteOfflineJoined` (P2) |
| `src/app/api/worker/join/route.ts` | Bearer `cjt_` → `consumeJoinToken` → `createWorker(... joinedVia:'join')` → `setCapabilities` → 201. Falha: 401 genérico + `recordFailure` por IP; 429 no limite |
| `src/app/api/worker/leave/route.ts` | `requireWorker` → `revokeWorker(self)` → 200 |
| `src/app/api/worker/_lib/claim.ts` | `pollClaim` relê `availability` do worker **a cada iteração**; ≠ `active` → não chama `claimNext` (segue o long-poll até o prazo; 204) |
| `src/app/api/admin/workers/join-token/route.ts` | `GET` info · `POST` gira (corpo: ttlHours?, maxUses?) e devolve token + comandos · `DELETE` desativa |
| `src/app/api/admin/workers/[id]/availability/route.ts` | `POST {availability: active|paused}`; aprovar = `active` |
| `fleet.ts` | `FleetWorker` ganha `availability`, `joinedVia`, `hostname`; status: `revoked` > `pending` > `paused` (se online) > `busy/idle` > `offline` |
| `src/server/setup-kit/join-command.ts` (puro) | `joinCommands({panelUrl, token, image})` → `{cli, docker}` (cita o token com aspas simples; placeholder quando sem URL) |

## Componentes (worker)

| Módulo | Responsabilidade |
|---|---|
| `src/worker/node-state.ts` | `nodeFile(stateDir, hostname)` = `<stateDir>/nodes/<hostname-seguro>.json` · `readNodeState` (recusa se modo ≠ 0600 em POSIX ou JSON inválido) · `writeNodeState` atômico (tmp + rename, 0600) · `removeNodeState` |
| `src/worker/client.ts` | `join(joinToken, body)` e `leave()` |
| `src/worker/join.ts` | `runJoin(opts)`: se há estado salvo para este painel → `hello` com ele; ok → reusa; 401 → apaga e faz join novo. Senão `join` → grava → devolve config |
| `src/worker/config.ts` | `CARBON_WORKER_STATE_DIR` (padrão `~/.carbon-worker`; imagem: `/var/lib/carbon-worker`); `CARBON_JOIN_TOKEN` entra em `SECRET_ENV_NAMES`; sem `CARBON_WORKER_TOKEN` → lê o estado salvo |
| `src/worker/main.ts` | subcomandos: `join <url> --token … [--name …]` (join e segue no loop), `leave`, padrão = loop. Se `CARBON_JOIN_TOKEN` + `CARBON_PANEL_URL` no env e sem credencial → faz join (modo Docker/K8s) |
| `src/worker/loop.ts` | 401 com credencial vinda de join → `EXIT_REMOVED = 3` e mensagem "nó removido do cluster" |
| `bin/carbon.mjs` | `carbon join …` / `carbon leave` repassam para `dist/worker.mjs`; `carbon join-token [--rotate] [--ttl 24h] [--max-uses N] [--disable]` roda no host do painel (DB direto, como `worker init`) |

### Identidade do nó por hostname

Docker Compose com `--scale` não dá índice de réplica [Certo: Compose não expõe índice como env]. Chave do
estado = hostname: container reiniciado mantém hostname (sem nó novo); container **recriado** vira nó novo e o
antigo fica offline → ação "Remover nós offline" na UI. K8s: `StatefulSet` (hostname estável `worker-0..N`) +
`volumeClaimTemplates`. Bare-metal: hostname estável.

## Segurança

- `cjt_` e `cwk_`: 32 bytes aleatórios base64url, só sha256 no banco (padrão atual). `cjt_` nunca em log/snapshot.
- Join sob o listener público já existente (só `/api/worker/*`); rate limit de falhas por IP reusado.
- Vazamento do `cjt_` = qualquer um entra no cluster e recebe tarefas (código + prompt). Mitigações: girar, validade,
  máximo de usos, "exigir aprovação", e aviso na UI. [Certo] mesmo modelo de risco do token de join do Swarm.
- `node.json` 0600 e recusa se permissão aberta; worker remove tokens do env após leitura (regra atual).
- Remover nó = revogação existente (tarefas em curso seguem a regra de lease perdido).

## Erros

| Cenário | Resposta | Worker |
|---|---|---|
| `cjt_` inválido/expirado/esgotado/girado | 401 genérico | exit 1, "token de join recusado" |
| Muitas falhas do mesmo IP | 429 | exit 1 |
| Credencial salva revogada | 401 em hello/claim | apaga estado, exit 3 |
| Nó pausado/pendente | claim 204 | segue em long-poll, loga 1x "aguardando aprovação/pausado" via `hello.availability` |
| `node.json` com permissão aberta | — | exit 1 explicando `chmod 600` |
