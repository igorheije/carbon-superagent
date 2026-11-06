# Concerns

| Área | Risco | Onde |
|---|---|---|
| Runner singleton em memória | Concorrência 1, estado perdido no restart; não escala para workers | `src/server/runner/runner.ts:51,419` |
| CHECK `executor IN ('claude','codex')` | Novo valor exige rebuild de tabela no SQLite | `src/server/db.ts:167` |
| `recoverInterruptedTasks` marca toda running como failed | Mataria trabalho remoto | `src/server/repo/tasks.ts:163` |
| Sem testes de `runner.ts` e `startExecutor` | Mudanças no ciclo de vida sem rede de segurança | `src/server/runner/runner.ts`, `src/server/executors/spawn.ts` |
| Painel só em localhost, auth só por cookie | Expor para workers muda modelo de ameaça | `bin/carbon.mjs:14`, `src/middleware.ts` |
| Permissões pendentes em Map em memória | Exigem processo vivo no mesmo nó | `src/server/runner/runner.ts:366-392` |
