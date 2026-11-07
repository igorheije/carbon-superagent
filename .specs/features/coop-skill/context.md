# Skill "trabalho cooperativo" — Contexto e decisões

## Decisões do usuário (2026-11-07)

| # | Decisão |
| --- | --- |
| U1 | Base de execução: **Orca paired server** (`orca serve` no servidor + `orca environment add` local + `worker-start --on`). Não usa o pool do Carbon. |
| U2 | MVP = **ciclo completo**: conectar → despachar → acompanhar/responder → trazer branch → desconectar. |
| U3 | A skill fica **no repo do Carbon** (`skills/carbon-coop/`), instalável como plugin pelo repo público. |
| U4 | A skill **não depende do Carbon** (painel, worker, CLI). Só de Orca + `ssh` + `git` + `node`. O proxy de autenticação vai **embutido na skill** (`scripts/claude-auth-proxy.mjs`, cópia de `bin/claude-auth-proxy.mjs`, só módulos nativos do Node). |

## Restrições herdadas (sessões anteriores)

- Nunca usar senha (SSH por chave). Nunca pôr token ou pairing code no chat.
- Usuário do worker sem sudo e fora do grupo `docker`.
- Repos com dados sensíveis (ex.: `payments-ms`) não saem da máquina: `blockedRepos`.
- Commits sem `Co-Authored-By` (CLAUDE.md do projeto).

## A critério do agente

- Nome da skill (`carbon-coop`), layout dos scripts, nomes de branch (`coop/<slug>`), portas padrão.
- Transporte de código: remoto git por SSH (bare no servidor) — espelha o "só o commitado viaja" do Carbon.

## Incertezas a resolver no spike (T1) — não assumir

| # | Pergunta | Confiança atual |
| --- | --- | --- |
| Q1 | O `orca serve` roda headless em Linux (VPS sem desktop) e como se instala lá? | [Certo] pela doc oficial: `orca-ide serve` (AppImage/.deb, v1.4.253), `orca serve service install` para systemd. [Incerto] no Ubuntu 20.04 do VPS (glibc 2.31, libfuse2/Xvfb) — não testado: download bloqueado pelo modo automático |
| Q2 | O agente `claude` lançado pelo runtime remoto herda `ANTHROPIC_BASE_URL`? | [Certo] o `claude` da conta do worker funciona pelo proxy com as variáveis (validado). [Incerto] se o `orca-ide serve` repassa o ambiente ao agente |
| Q3 | Pareamento atravessando `ssh -L`? | [Certo] pela doc: `orca-ide serve --bind 127.0.0.1 --pairing-address 127.0.0.1` é o exemplo oficial para túnel SSH |
| Q4 | Pedidos de permissão do worker remoto | [Certo] (UAT 2026-11-07): o Orca lança `claude --dangerously-skip-permissions` (configuração de novas abas de agente); não há pedidos. Proteção = conta sem sudo/docker + spec |
| Q5 | Versões do Orca | [Certo] 1.4.253 nas duas pontas pareou e despachou; versões diferentes não testadas |
| Q6 | O pairing code dá acesso? | [Certo] pela doc: dá acesso ao runtime, "trate como senha"; cada cliente ganha grant revogável; `orca-ide pair` gera novo sem reiniciar |
| Q7 | Modo **SSH target** do Orca (instala relay sozinho, sem `orca serve`) serve? | [Certo] pela doc: existe, mas `worker-start --on` só aceita servidor pareado → sem ask/worker_done de volta. Fica como fallback "só entregar" (P3) |
