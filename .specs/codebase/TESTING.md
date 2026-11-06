# Testing

- Runner: vitest (`vitest.config.ts`): `src/**/*.test.ts`, ambiente node, alias de `server-only` para stub.
- Padrão: funções puras testadas direto; fluxos de git testados com **git real em diretório temporário** (`local-delivery.test.ts`, `worktree.test.ts`), banco descartável via `CARBON_DATA_DIR` antes do `import()` dinâmico dos módulos.
- Rotas: chamar o handler exportado direto ou testar a função de domínio que ele usa.
- Sem infra de teste de UI (componentes): validar com `npm run build` + verificação manual.

## Gates

| Gate | Comando |
|---|---|
| quick | `npx vitest run <arquivos>` |
| full | `npm run check` (tsc + eslint + vitest) |
| build | `npm run check && npm run build` |

## Coverage matrix

| Camada | Teste exigido | Parallel-safe |
|---|---|---|
| repo / db / scheduler | unit (banco temporário) | Sim (cada arquivo usa seu próprio CARBON_DATA_DIR) |
| rotas `/api/**` | unit | Sim |
| git (worktree, entrega, transporte) | unit com git real em tmp | Sim |
| worker (processo) | integration (executor fake JSONL) | Sim |
| geradores de setup | snapshot | Sim |
| UI | none (build) | — |
