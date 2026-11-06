# Tarefa distribuída (uma tarefa dividida entre computadores) — Especificação

**Status:** Done (2026-11-06)
**Escopo:** Large (núcleo do runner + protocolo + UI; reaproveita cluster join, pool e entrega)
**Data:** 2026-11-06
**Depende de:** execução distribuída, cluster join, multi-agentes (todos na `main`)

## Problem Statement

Hoje o cluster divide a **fila**: cada tarefa roda inteira num computador. Uma tarefa grande (ex.: "API + tela + testes")
continua presa a uma máquina, mesmo com vários computadores ociosos. O multi-agentes divide a tarefa, mas os sub-agentes
do Claude Code rodam **no mesmo processo e na mesma máquina** (a ferramenta `Agent` não roda remoto).

Objetivo: o agente principal **planeja e divide** a tarefa em partes independentes; cada parte vira uma **subtarefa** que
roda em outro computador do cluster; quando todas terminam, o agente principal **integra** (merge dos branches), roda os
testes e entrega **um PR só**.

## Decisões (minhas, reversíveis — usuário autorizou seguir)

| # | Decisão | Motivo |
|---|---|---|
| D1 | Divisão no nível do **Carbon** (fan-out/fan-in de tarefas), não dos sub-agentes do CLI | Sub-agentes do CLI não rodam em outra máquina; tarefas já rodam (pool, bundle, entrega) |
| D2 | O agente declara as partes com o marcador **`CARBON_SUBTASK: <título> \| <arquivos> \| <brief>`** (2–4) e para | Mesmo protocolo de linha dos outros marcadores; funciona com Claude Code e Codex |
| D3 | A tarefa-mãe roda **sempre no painel** (runtime `local`): divisão e integração | O repo e os branches das filhas estão no painel; merge sem transporte extra |
| D4 | Filhas vão para o **pool** se houver ≥1 computador ativo online; senão rodam locais, em série (com aviso) | Nunca travar esperando máquina que não existe |
| D5 | Filhas partem do **branch da mãe** (commit de divisão) e só **commitam** (sem push/PR) | A mãe entrega um PR só, com tudo integrado |
| D6 | Profundidade 1: filha não divide. Máximo 4 filhas. Brief ≤ 2000 caracteres | Controle de custo e de complexidade |
| D7 | Integração: o painel faz `git merge --no-ff` de cada filha concluída no worktree da mãe; conflito → `merge --abort` e o **patch** da filha vai no prompt para o agente aplicar à mão | Merge limpo é automático; conflito vira trabalho explícito do agente |
| D8 | Filha que falhou: a mãe recebe o motivo e faz aquela parte ela mesma | Uma parte ruim não derruba a tarefa |
| D9 | Sem divisão (o agente não emite `CARBON_SUBTASK`): a tarefa segue normal. Uma parte só também divide (o agente parou para ela) | A opção é "se valer a pena", como o multi-agentes |
| D10 | Fan-in por **reconciliação periódica** (3 s) + gatilho ao fim de cada execução local | Robusto a reinício do painel e a filhas remotas/locais |

## User Stories

### P1: Opção ao criar a tarefa ⭐
1. WHEN o usuário marca **"Dividir entre os computadores do cluster"** THEN a tarefa SHALL ser criada com `distributed: true` e runtime `local`.
2. A opção SHALL mostrar quantos computadores do pool estão online (0 → aviso de que as partes rodarão aqui, em série).

### P1: Divisão (fan-out) ⭐
1. WHEN a tarefa distribuída roda THEN o prompt SHALL pedir: planejar, fazer só a base compartilhada (interfaces, tipos), e declarar 2–4 partes independentes com `CARBON_SUBTASK`, cada uma com os arquivos que ela pode mexer, e parar.
2. WHEN a execução termina com ≥2 `CARBON_SUBTASK` válidas THEN o painel SHALL commitar o worktree da mãe ("chore: base para subtarefas"), criar as filhas (chave `<MÃE>.<n>`, mesmo executor/modelo/persona, base = branch da mãe) e deixar a mãe em `waiting` com o estado `split.running`.
3. Marcadores `CARBON_SUBTASK` de uma filha, ou de uma tarefa não distribuída, SHALL ser ignorados.

### P1: Filhas ⭐
1. O prompt da filha SHALL conter o brief, a lista de arquivos que ela pode mexer, o contexto da tarefa-mãe e a regra "não mexa em outros arquivos; não divida".
2. Local: `prepareWorktree` a partir do branch da mãe. Remoto: `planCode` com base = branch da mãe (bundle, já que o branch não está no remoto).
3. Ao terminar, a filha SHALL só commitar no próprio branch: **sem push e sem PR**.

### P1: Integração (fan-in) ⭐
1. WHEN todas as filhas estão em estado final (`done`/`failed`) THEN a mãe SHALL voltar à fila (primeira da fila) com `split.integrating`.
2. A execução de integração SHALL: mergear as filhas concluídas no worktree da mãe; para conflito, abortar e passar o patch ao agente; para falha, passar o motivo; o agente integra, roda os testes e entrega.
3. A entrega da mãe SHALL ter o diff completo contra a base do projeto (não só as mudanças da integração) e um PR só.

### P2: Painel
1. A mãe SHALL mostrar "Subtarefas distribuídas": chave, título, status, onde roda (computador ou "este computador"), arquivos.
2. Na fila, filha SHALL mostrar "↳ MÃE"; mãe SHALL mostrar "⇉ N partes".

### P2: Cancelar / rodar de novo
1. WHEN a mãe é "rodada de novo" THEN as filhas não finalizadas SHALL ser canceladas e o `split` descartado.

## Edge Cases
- Painel reinicia com filhas rodando → o reconciliador retoma o fan-in quando elas terminarem.
- Filha pergunta (`CARBON_QUESTION`) → fica `waiting`; a mãe espera.
- Arquivos sobrepostos entre filhas → o prompt proíbe; se acontecer, vira conflito no merge (D7).
- Filha sem mudanças → conta como concluída sem merge.

## Fora do escopo
- Divisão recursiva (filha que divide), afinidade de máquina por parte, mais de 4 partes.
- Mãe rodando em worker remoto.

## Requirement Traceability

| ID | Story | Status |
|---|---|---|
| DT-01 | Opção na criação + `distributed` | Done |
| DT-02 | Marcador `CARBON_SUBTASK` | Done |
| DT-03 | Prompt de divisão / filha / integração | Done |
| DT-04 | Fan-out: commit da base + criação das filhas | Done |
| DT-05 | Base = branch da mãe (local e remoto) | Done |
| DT-06 | Filha sem push/PR | Done |
| DT-07 | Reconciliação e fan-in | Done |
| DT-08 | Merge + patches de conflito + entrega com diff completo | Done |
| DT-09 | Painel das subtarefas + selos na fila | Done |
| DT-10 | Rodar de novo cancela filhas | Done |
