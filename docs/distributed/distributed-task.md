# Tarefa distribuída (uma tarefa em vários computadores)

O cluster normal divide a **fila**: cada tarefa roda inteira num computador livre. A tarefa distribuída divide
**uma tarefa** em partes que rodam ao mesmo tempo em computadores diferentes, e junta tudo num PR só.

## Como usar

Ao criar a tarefa, marque **Dividir entre os computadores do cluster**. Funciona com Claude Code e Codex.

## O que acontece

1. **Divisão (neste computador).** O agente planeja, faz a base compartilhada (tipos, interfaces, contratos) e declara
   de 1 a 4 partes independentes, uma por linha:
   ```
   CARBON_SUBTASK: <título> | <arquivos ou globs que a parte pode mexer> | <brief autocontido>
   ```
   Se a tarefa for pequena ou muito acoplada, ele não divide e segue como uma tarefa comum.
2. **Partes (no cluster).** O Carbon commita a base no branch da tarefa (`chore: base para as partes de …`) e cria uma
   subtarefa por parte (`FRG-12.1`, `FRG-12.2`, …), já no começo da fila. Cada parte parte do branch da tarefa principal,
   só pode mexer nos arquivos dela e só commita: sem push e sem PR.
   - Com pelo menos um computador do pool online, as partes vão para o cluster (o código chega por bundle do painel).
   - Sem nenhum, rodam neste computador, uma por vez.
3. **Integração (neste computador).** Quando todas as partes terminam, a tarefa principal volta para o começo da fila:
   - cada parte concluída é integrada com `git merge --no-ff`;
   - conflito: o merge é desfeito e o patch da parte vai para o agente aplicar à mão;
   - parte que falhou: o agente faz aquela parte ele mesmo.

   O agente junta tudo, roda os testes e entrega **um PR**, com o diff completo contra a base do projeto.

No painel, o bloco **Tarefa distribuída** mostra cada parte, o computador onde roda e o resultado do merge. Na fila,
a tarefa principal mostra `⇉ N` e cada parte mostra `↳ CHAVE`.

## Limites

- No máximo 4 partes; uma parte não divide de novo.
- A tarefa principal (divisão e integração) sempre roda no computador do painel, que tem o repositório.
- "Rodar de novo" na tarefa principal descarta a divisão e cancela as partes que ainda não começaram.
  Uma parte que já está rodando termina sozinha.
- As partes gastam tokens como tarefas separadas.
