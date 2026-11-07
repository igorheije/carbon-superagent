# Skill `carbon-coop` — trabalho cooperativo com um servidor (experimental)

Uma skill do Claude Code que transforma **qualquer sessão** em coordenadora de trabalho cooperativo:
um servidor seu (VPS, máquina dedicada) é pareado como **servidor Orca**, recebe partes do trabalho e
devolve o resultado como **branch git**. Os workers no servidor usam o **Claude Code deste computador**
por um proxy local: a credencial nunca sai daqui.

**Não depende do Carbon.** Precisa só de [Orca](https://github.com/stablyai/orca), `ssh`, `git` e
Node 22+. O painel, o pool e o CLI do Carbon não são usados.

> **Experimental.** Scripts testados com `ssh` e `orca` simulados; o teste ponta a ponta num servidor
> real ainda está pendente (ver [Status](#status)).

## Instalar

Requer Claude Code com suporte a plugins.

**Um passo** (Claude Code 2.1.275+):

```text
/plugin install carbon-coop --marketplace leolegends/carbon-superagent
```

**Dois passos** (versões anteriores):

```text
/plugin marketplace add leolegends/carbon-superagent
/plugin install carbon-coop@carbon-superagent
```

**Manual** (sem plugin, só a skill):

```bash
git clone --depth 1 https://github.com/leolegends/carbon-superagent.git /tmp/carbon-superagent
mkdir -p ~/.claude/skills && cp -R /tmp/carbon-superagent/skills/carbon-coop ~/.claude/skills/
```

Confira: numa sessão nova, `/carbon-coop` aparece entre as skills.

## Pré-requisitos

| Onde | O quê |
| --- | --- |
| Este computador | macOS (o proxy lê o login do Claude Code no Keychain), Orca, `ssh`, `git`, Node 22+, Claude Code logado |
| Servidor | Conta própria **sem sudo e fora do grupo `docker`**, acesso SSH **por chave**, Node 22+, Claude Code (sem login), `orca-ide` na **mesma versão** do Orca daqui |

Passo a passo do servidor: [`skills/carbon-coop/references/server-setup.md`](../../skills/carbon-coop/references/server-setup.md).
Fora do macOS, o proxy usa um token de `claude setup-token` num arquivo `0600` (ver [segurança](../../skills/carbon-coop/references/security.md)).

## Usar

Na sessão do Claude Code, peça em linguagem natural ou pelo comando:

| Pedido | O que a skill faz |
| --- | --- |
| `/carbon-coop connect usuario@host` | Checa tudo (`preflight`), liga o proxy, abre **uma** conexão SSH com os dois túneis, sobe `orca-ide serve` no servidor e pareia (environment `coop-<nome>`) |
| "manda a parte X pro servidor" | Envia o **código commitado** (`git push` para `~/coop/<repo>.git` no servidor), inicia um worker Orca lá com uma spec escrita pela skill e encerra o turno |
| (o Orca acorda a sessão) | Pergunta do worker → responde ou pergunta a você; fim → traz `coop/<slug>` com `git fetch` e mostra o diff; parada sem fim → mostra o motivo e oferece reenviar |
| `/carbon-coop status` | Proxy, túnel, servidor, workers ativos e branches ainda não integrados |
| `/carbon-coop disconnect` | Para o servidor Orca, fecha o túnel e o proxy: o servidor perde o acesso à conta na hora |

Integrar o resultado (`git merge`) é sempre decisão sua; a skill não faz push.

## Como funciona

```text
este computador                                   servidor (conta sem sudo)
Orca + sessão (coordenador) ── ssh -L ──────────▶ orca-ide serve 127.0.0.1:16768
proxy 127.0.0.1:8787 ◀──────── ssh -R ─────────── claude (ANTHROPIC_BASE_URL=127.0.0.1:8787)
  └─▶ api.anthropic.com (credencial injetada aqui)
git (só o commitado) ── ssh ──▶ ~/coop/<repo>.git ◀── worker faz push de coop/<slug>
```

- Nada escuta em interface pública: `orca-ide serve --bind 127.0.0.1` e `ssh -R` no loopback.
- O worker manda um token placeholder; o proxy descarta e injeta o login real, aqui.
- O link de pareamento vai do servidor direto para `orca environment add`, nunca é impresso e é apagado do log do servidor.
- Repositórios listados em `~/.carbon-coop/config.json` → `blockedRepos` não saem da máquina.

## Riscos e limites

| Ponto | O que significa |
| --- | --- |
| Root no servidor | Enquanto o túnel estiver aberto, consegue usar a sua conta do Claude (não consegue levar a credencial) e lê o código enviado |
| Mesma conta | Mais máquinas = mais paralelismo e CPU, não mais quota do plano |
| Código | Só o commitado viaja; mudanças locais não commitadas ficam aqui |
| Servidor com produção | Conta do worker sem sudo/docker; a spec do worker proíbe infraestrutura e manda perguntar |

## Status

| Item | Estado |
| --- | --- |
| Scripts (`init`, `preflight`, `proxy`, `tunnel`, `serve`, `pair`, `code-sync`) | Prontos, 9 testes automatizados |
| `preflight` contra servidor real (Ubuntu 20.04) | **Validado** (2026-11-07): detecta conta sem chave, sem sudo/docker, Orca faltando |
| Túnel + proxy: Claude Code do servidor usando o login deste computador | **Validado**: `claude -p` na conta do worker respondeu pelo proxy, sem credencial no servidor |
| Envio do código e retorno do branch (`code-sync`) | **Validado**: só o commitado viajou; `coop/<slug>` voltou com o commit do servidor |
| `orca-ide serve` no servidor (AppImage 1.4.253 + bibliotecas do Electron + `xvfb`) | **Validado**: sobe só em `127.0.0.1` |
| Pareamento (`pair.sh`) | **Validado**: environment `coop-vps` criado; o link não apareceu e saiu do log do servidor |
| Repo no servidor (`code-sync` + `orca repo add --environment`) | **Validado** |
| Agente lançado pelo Orca no servidor recebe `ANTHROPIC_BASE_URL` e o token falso | **Validado** (ambiente do `orca-ide serve` é herdado) |
| Worker Orca remoto concluir a tarefa | **Validado** (2026-11-07): worker no servidor criou `soma.test.mjs`, commitou, fez push de `coop/uat-soma-test`; o branch voltou com `code-sync fetch` e `node --test` passou 4/4 aqui. Pré-requisito: o passo 4 da preparação do servidor (1ª execução do Claude Code), feito pela pessoa |
| Permissões do worker remoto | O Orca abre o worker com `--dangerously-skip-permissions` (segue a configuração de novas abas de agente do Orca): **não há pedidos de permissão** para chegar ao coordenador. A proteção é a conta sem sudo/docker e a spec do worker |

Especificação e design: [`.specs/features/coop-skill/`](../../.specs/features/coop-skill/spec.md).
Relacionado: [túnel SSH + Claude Code compartilhado no Carbon](../distributed/ssh-tunnel-shared-claude.md), a mesma ideia usando o painel.
