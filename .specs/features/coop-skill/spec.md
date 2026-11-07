# Skill "trabalho cooperativo" (Claude Code + servidor Orca pareado) — Especificação

**Status:** Implementing (2026-11-07) — skill escrita e testada localmente; UAT no servidor pendente
**Escopo:** Complex (domínio novo para o repo: Orca como executor remoto; segurança de credencial e rede)
**Depende de:** só Orca (local + `orca-ide serve` no servidor), `ssh`, `git`, `node ≥ 22`. **Não** depende do Carbon: o proxy vai embutido na skill.
**Decisões do usuário:** ver `context.md`

## Problem Statement

Hoje, para um servidor ajudar nas tarefas, a pessoa precisa subir o painel Carbon, configurar o túnel, ligar o
Claude Code compartilhado e despachar pelo painel. Quem já está **numa sessão do Claude Code** (no Orca) não tem um
caminho direto para dizer "conecta no meu servidor e manda essa parte pra lá". A skill `carbon-coop` resolve isso:
a sessão local vira **coordenadora**, o servidor vira **worker Orca pareado**, o Claude Code do servidor usa a
**conta deste computador** pelo proxy (sem a credencial sair daqui), e o resultado volta como **branch git** na sessão.

## Goals

- [ ] Da primeira conexão até a primeira tarefa rodando no servidor em ≤ 10 min, só com o que a skill guia.
- [ ] Zero credencial em disco no servidor e zero credencial no transcript da sessão (token, pairing code, senha).
- [ ] Zero porta nova exposta na internet: tudo por uma conexão SSH aberta daqui.
- [ ] Toda tarefa remota termina com um branch buscável localmente (`git fetch`) ou com uma falha explicada.

## Out of Scope

| Item | Motivo |
| --- | --- |
| Painel Carbon / pool / CLI do Carbon | Skill depende só do Orca (U4). Do Carbon vem apenas a cópia do proxy e a receita de túnel. |
| Linux/Windows como coordenador | O proxy lê o login no Keychain (macOS). Coordenador fora do macOS = P3 com `--token-file`. |
| Provisionar VPS (criar máquina, DNS, firewall) | A skill parte de um servidor já acessível por SSH com chave. |
| Autenticação SSH por senha | Nunca. Só chave; a skill recusa e orienta se pedir senha. |
| Auto-merge na branch principal | Resultado volta como branch; merge é decisão da pessoa. |
| Vários servidores ao mesmo tempo | P3. MVP = 1 servidor pareado. |

---

## User Stories

### P1: Conectar a sessão a um servidor ⭐ MVP

**User Story**: Como dev numa sessão do Claude Code, quero rodar `/carbon-coop connect usuario@host` e ter o servidor
pareado como worker Orca usando meu Claude Code, para dividir trabalho sem configurar nada à mão.

**Acceptance Criteria**:

1. WHEN a skill inicia THEN SHALL checar pré-requisitos locais (macOS, `orca` CLI, `ssh`, `git`, `node ≥ 22`, login do
   Claude Code; o proxy é o `scripts/claude-auth-proxy.mjs` da própria skill) e listar o que falta, sem instalar nada localmente sem confirmação. (COOP-01)
2. WHEN o acesso SSH exige senha ou falha THEN SHALL parar e orientar a configurar chave (`ssh-copy-id`), sem pedir nem aceitar senha no chat. (COOP-02)
3. WHEN o servidor não tem usuário dedicado THEN SHALL propor (e só executar após confirmação) criar usuário sem sudo e fora do grupo `docker`, e instalar Node/Claude Code/Orca (`orca-ide`, AppImage ou .deb) — mostrando de onde baixa, versão e hash antes de rodar. (COOP-03)
4. WHEN o proxy local não está rodando THEN SHALL subi-lo em `127.0.0.1:8787` e confirmar que responde, avisando do prompt do Keychain ("Permitir sempre"). (COOP-04)
5. WHEN conecta THEN SHALL abrir **uma** conexão SSH com `-R 127.0.0.1:8787` (proxy) e `-L 127.0.0.1:<porta>` (runtime Orca do servidor), com `ExitOnForwardFailure` e keepalive. (COOP-05)
6. WHEN o runtime Orca do servidor sobe THEN SHALL escutar só em `127.0.0.1`, e o Claude Code dele SHALL apontar para o proxy (`ANTHROPIC_BASE_URL`) com token placeholder. (COOP-06)
7. WHEN pareia THEN o pairing code SHALL ir do servidor para `orca environment add` dentro de um único comando, sem aparecer no transcript nem em arquivo. (COOP-07)
8. WHEN termina THEN SHALL rodar um smoke test (worker remoto responde "ok" via Claude Code) e mostrar `orca host list` com o servidor. (COOP-08)

**Independent Test**: em servidor limpo, `/carbon-coop connect` → `orca environment list` mostra o servidor e um worker trivial termina com `worker_done`.

### P1: Mandar trabalho para o servidor e trazer o resultado ⭐ MVP

**User Story**: Como dev, quero dizer "manda a parte X pro servidor" e receber de volta um branch com o trabalho, para revisar e integrar aqui.

**Acceptance Criteria**:

1. WHEN despacha THEN SHALL publicar o código **commitado** no servidor por um remoto git via SSH (`git push coop <ref>`), avisando se há mudanças não commitadas que não vão junto. (COOP-10)
2. WHEN o repo ainda não existe no servidor THEN SHALL criá-lo (clone do bare) e registrá-lo com `orca repo add --environment`. (COOP-11)
3. WHEN despacha THEN SHALL usar `orca orchestration worker-start --on <servidor> --worktree new-top-level --repo <selector> --agent claude` com spec escrita pela skill (objetivo, arquivos, critério de pronto, "commite no branch e não faça push para remotos de terceiros"), e encerrar o turno. (COOP-12)
4. WHEN o worker faz `ask` THEN a sessão SHALL responder se a resposta decorre da tarefa; senão SHALL perguntar à pessoa. (COOP-13)
5. WHEN chega `worker_done` THEN SHALL `git fetch coop <branch>`, mostrar resumo do diff e testes reportados, e oferecer: revisar, mesclar localmente (sem push) ou descartar. (COOP-14)
6. WHEN o worker para sem `worker_done` (escalation) THEN SHALL mostrar o motivo e oferecer reenviar, redirecionar com `send` ou cancelar — nunca marcar como concluído. (COOP-15)
7. WHEN a pessoa divide uma tarefa em partes THEN SHALL despachar partes independentes em paralelo (uma por worker) e integrar os branches no fim. (COOP-16)

**Independent Test**: com servidor pareado, pedir "adicione um teste para a função Y" → branch `coop/<slug>` aparece local com commit e teste.

### P1: Desconectar com segurança ⭐ MVP

**Acceptance Criteria**:

1. WHEN `/carbon-coop disconnect` THEN SHALL fechar o túnel e o proxy, e o servidor SHALL perder acesso à conta imediatamente. (COOP-20)
2. WHEN há workers ativos THEN SHALL listar e pedir confirmação antes de derrubar. (COOP-21)
3. WHEN `/carbon-coop status` THEN SHALL mostrar túnel, proxy (chamadas/falhas), runtime remoto, workers ativos e branches pendentes de revisão. (COOP-22)

### P2: Reconectar sozinho

1. WHEN a pessoa opta por persistência THEN SHALL instalar túnel como `launchd` (local) e `orca serve --supervise` como `systemd --user` (servidor), mostrando os arquivos antes. (COOP-30)
2. WHEN o túnel cai THEN o runtime remoto SHALL continuar vivo e os workers SHALL receber 5xx do proxy até voltar (não perdem o worktree). (COOP-31)

### P3: Coordenador fora do macOS / vários servidores

1. WHEN coordenador não é macOS THEN SHALL usar `--token-file` (0600) gerado por `claude setup-token` em terminal separado. (COOP-40)
2. WHEN há mais de um servidor pareado THEN SHALL escolher pelo menor número de workers ativos. (COOP-41)

---

## Edge Cases

- WHEN o repo local tem mudanças não commitadas THEN SHALL avisar que só o commitado viaja e oferecer commit WIP num branch temporário (nunca na branch atual sem confirmar).
- WHEN o projeto está marcado como "não pode sair desta máquina" (lista em `.carbon-coop.json` → `blockedRepos`) THEN SHALL recusar o despacho. Ex.: repos com dados de clientes/saúde.
- WHEN a porta 8787 ou a porta local do runtime está ocupada THEN SHALL dizer quem ocupa e escolher outra porta, refletindo no túnel e no `ANTHROPIC_BASE_URL`.
- WHEN as versões do Orca local e remota divergem THEN SHALL avisar e parar antes de parear.
- WHEN o servidor roda serviços de produção THEN SHALL lembrar que o usuário do worker fica sem sudo/docker e que a tarefa não deve mexer em infraestrutura.
- WHEN o login do Claude Code vence durante a tarefa THEN o proxy renova via `claude` local (503 temporário); a skill não tenta renovar.
- WHEN o servidor já tem `orca serve` de outra pessoa/perfil THEN SHALL parar (exit 3 do `orca serve`) e não forçar.

---

## Requirement Traceability

| ID | Story | Fase | Status |
| --- | --- | --- | --- |
| COOP-01..08 | P1 Conectar | Design | Pending |
| COOP-10..16 | P1 Despachar/trazer | Design | Pending |
| COOP-20..22 | P1 Desconectar/status | Design | Pending |
| COOP-30..31 | P2 Reconectar | Design | Pending |
| COOP-40..41 | P3 | - | Pending |

**Coverage:** 22 requisitos; 18 P1 mapeados em `tasks.md`; P2/P3 adiados.

## Success Criteria

- [ ] Fluxo P1 completo validado de ponta a ponta no VPS de teste (usuário `carbon`, sem sudo).
- [ ] `grep` no transcript e em `~carbon` não encontra token, refresh token nem pairing code.
- [ ] `ss -tlnp` no servidor mostra só listeners em `127.0.0.1` para 8787 e runtime Orca.
