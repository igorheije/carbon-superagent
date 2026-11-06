# Operação

## Frota (*Configurações → Máquinas*)

Cada máquina cadastrada aparece com: nome, tipo, status, última batida, tarefa atual e versão. Ações: **Adicionar máquina** e **Revogar**.

| Status | Rótulo | Regra |
| --- | --- | --- |
| `busy` | ocupada | Vista há menos de 2 × `leaseMs` e com ao menos uma tarefa sob lease (`running` ou `waiting`) |
| `idle` | ociosa | Vista há menos de 2 × `leaseMs`, sem tarefa |
| `offline` | offline | Nunca conectou, ou sem contato há mais de 2 × `leaseMs` (padrão 2 min) |
| `revoked` | revogada | Token revogado |

- "Última batida" é atualizada no máximo a cada 30 s por máquina.
- A versão vem do `hello` (`<versão do Carbon>+p<protocolo>`, ex.: `0.2.0+p1`).
- Várias réplicas/processos com o mesmo token formam **uma** máquina.
- Sessões AgentCore não aparecem na frota (não têm registro em `workers`); o card da tarefa mostra a sessão.

Cada tarefa registra onde rodou (placement): esta máquina, nome do worker ou sessão AgentCore.

## Fila e claim

- Tarefas `pool` em fila são entregues na ordem da fila (a mesma ordem/prioridade do painel) ao primeiro worker que fizer claim **com o executor da tarefa**. Uma tarefa `codex` nunca vai para um worker que só tem `claude`.
- A fila local (`runtime = local`) continua serial e independente: uma tarefa local e N remotas podem rodar ao mesmo tempo.
- Não existe afinidade de máquina: qualquer worker válido pode pegar qualquer tarefa pool.
- Tarefas AgentCore são despachadas pelo painel a cada 5 s, até o limite de sessões simultâneas.

## Lease e worker que some

| Configuração (`workers.*`) | Padrão | Faixa | Efeito |
| --- | --- | --- | --- |
| `leaseMs` | 60 000 | 10 000–600 000 | Duração do lease; heartbeats a cada `leaseMs/3` |
| `pollMs` | 25 000 | 1 000–60 000 | Informado ao worker no `hello` |
| `requeueOnLeaseLoss` | `false` | — | Lease vencido: `false` → `failed`; `true` → volta para `queued` |
| `maxBundleMb` | 200 | 1–2000 | Limite do bundle de resultado |

Estas chaves não têm campo na UI hoje: altere pela API de configurações (`PUT /api/settings`, sessão de admin) se precisar.

A cada 15 s o painel varre leases vencidos. Mensagens no log da tarefa:

- `worker <nome> parou de responder (<hora>) — use “rodar de novo”` (padrão);
- `worker <nome> parou de responder (<hora>) — tarefa devolvida à fila` (com `requeueOnLeaseLoss`).

Se o worker voltar depois disso, qualquer chamada da tarefa recebe `409 lease_lost` e ele descarta o trabalho. Com `requeueOnLeaseLoss`, cuidado com tarefas que falham sempre no meio: elas voltam à fila indefinidamente.

## Reinício do painel

- Tarefas **locais** em execução viram `failed` no boot (como antes).
- Tarefas **remotas** com lease válido continuam `running`; o worker segue enviando eventos (o buffer local reenvia o que não teve ack).
- Tarefas pool em `running` **sem** lease (o painel caiu no meio da importação do resultado) viram `failed` com `painel reiniciou durante a entrega — use “rodar de novo”`.
- Sessões AgentCore em andamento são reconhecidas no boot e encerradas quando a tarefa terminar.
- Rate limits e o contador de requisições ficam em memória e zeram no reinício.

## Cancelamento

- **Pool:** o cancelamento marca a tarefa; o worker recebe `cancel: true` no próximo heartbeat (≤ `leaseMs/3`, 20 s no padrão), mata o agente e reporta `canceled`.
- **AgentCore antes do claim:** o painel encerra a sessão (`StopRuntimeSession`) e falha a tarefa na hora.
- **AgentCore depois do claim:** igual ao pool (heartbeat); ao terminar, o painel encerra a sessão.
- Tarefa remota que não está executando: `esta tarefa não está executando` (`409`).

## Desligar um worker

SIGTERM (`docker compose down`, remoção de pod, Ctrl+C): para de pegar tarefas e espera as atuais até `CARBON_WORKER_GRACE_SECONDS` (120 s padrão; 540 s no kit Kubernetes; 60 s na imagem AgentCore). Esgotado o prazo, cancela e reporta `canceled`. Segundo sinal: sai na hora (código 130).

Códigos de saída do worker: `0` parada normal · `1` erro fatal (configuração inválida, token recusado) · `2` protocolo desatualizado (`426`).

## Permissões em execução remota

Funciona como localmente (Claude Code em `guarded`/`auto`):

1. O worker responde sozinho o que a política de aprovação e as regras do repositório permitem (mesma lógica do painel).
2. O resto vira `permission_request` no painel: card no Mission Control e aviso no topo, com ferramenta e comando/arquivo exatos.
3. O worker espera a resposta por long-poll. **Permitir**, **Negar**, **Liberar tudo nesta tarefa** e **Sempre neste repositório** funcionam; "sempre neste repositório" é recusado para comandos de shell/interpretador em tarefas remotas (permita uma vez ou libere a tarefa).
4. Sem resposta em `permissionTimeoutMinutes` (padrão 15): negado, com `permissão expirou após N min sem resposta` no log.
5. Se o painel ficar inalcançável enquanto o agente espera, o worker nega com: `O painel do Carbon não respondeu a este pedido de permissão; siga sem essa ação ou pare e explique.`

Uma sessão AgentCore esperando permissão continua ativa e contando no limite de sessões simultâneas (e no custo).

## Perguntas do agente em execução remota

Quando o agente emite `CARBON_QUESTION`:

1. O worker termina a execução e reporta `waiting`; **nada é entregue**, o clone é descartado.
2. A tarefa vai para `waiting` e mostra a pergunta com opções. O log diz: `execução remota: ao responder, a tarefa volta para a fila do mesmo runtime e o agente recomeça com as suas decisões no contexto`.
3. Ao responder, a tarefa volta para a fila **do mesmo runtime** (pool ou AgentCore). Qualquer worker pode pegá-la.
4. A nova execução **recomeça da base com as decisões** no prompt (`resume.decisions`). A sessão do Claude não é retomada: ela existia em outra máquina/container.

Implicação: o trabalho feito antes da pergunta é refeito. Para tarefas longas com decisões previsíveis, deixe as decisões na descrição da tarefa.

## Limites

| Limite | Valor |
| --- | --- |
| Tarefas por processo worker | 1–64 (`CARBON_WORKER_PARALLEL`) |
| Réplicas por kit | 1–100 |
| Tempo máximo por tarefa | `maxRunMinutes` 5–240 (padrão 45) |
| Corpo JSON | 1 MB |
| Eventos por lote | 500 |
| Buffer de eventos não confirmados (worker) | 5 MB por tarefa |
| Bundle de resultado | `maxBundleMb` (padrão 200 MB) |
| Requisições por token | 600 por minuto |
| Long-poll (claim, permissões) | 25 s |
| Sessões AgentCore simultâneas | 1–20 (padrão 3) |
| Sessão AgentCore | até 8 h (teto da AWS) |
| Log da tarefa no painel | últimas 400 linhas, como nas tarefas locais |

## Testar a instalação de ponta a ponta

```sh
npm run build && npm run build:worker
npm run e2e:distributed            # --keep mantém o diretório temporário com os logs
```

Sobe painel real, listener com TLS autoassinado, 2 workers com um `claude` falso, 3 tarefas pool (transporte git e bundle) e um "AgentCore" local com endpoint falso da AWS. Não toca o seu `.carbon-data` e não usa AWS.
