# Conectar direto por IP — `carbon join`

Para quando **não há servidor, domínio, túnel nem Docker**: o painel roda no seu computador e outro computador entra como worker apontando para **`<ip>:<porta>`**, seja na **rede local** (`192.168.x.x`, `10.x.x.x`) ou pelo **IP público** (com a porta liberada no roteador).

```
outro computador                                    computador do painel
carbon join 192.168.0.12:3418 ──HTTPS (cert fixado)──▶ 0.0.0.0:3418 listener ──▶ 127.0.0.1:3417 painel
                                                        só /api/worker/*         UI + API completa
```

O tráfego é **cifrado** (TLS) mesmo sem domínio: na primeira vez que o listener sobe, ele gera um **certificado próprio** (autoassinado). O worker não confia em CA nenhuma: ele **fixa o fingerprint SHA-256** desse certificado, como o SSH faz com a chave do servidor. Um endereço trocado, um roteador comprometido ou alguém no meio do caminho apresenta outro certificado, e o worker desliga **antes de enviar qualquer byte** (o token nunca sai).

## Passo a passo

### 1. No computador do painel

No `.env.local` do painel:

```sh
CARBON_WORKER_LISTEN=0.0.0.0:3418
```

Reinicie com `npm start` (`carbon start`). Na saída aparece algo assim:

```
●  Workers: https://192.168.0.12:3418 (só /api/worker/*; a UI segue em 127.0.0.1)
●  Certificado do listener (autoassinado, gerado agora): 5C:18:73:35:…:2A:01
◇  Conectar outro computador
│  Em Configurações → Máquinas → Adicionar máquina → Direto você gera o token.
│  Na outra máquina (rede local):
│    carbon join 192.168.0.12:3418 --fingerprint 5c187335…2a01
│  Pela internet: libere a porta 3418 no roteador (port forwarding) e use
│    carbon join <ip-público>:3418 --fingerprint 5c187335…2a01
```

O certificado fica em `<pasta de dados>/worker-tls/` (pasta `0700`, chave `0600`) e é **reaproveitado** nos próximos `carbon start`: o fingerprint só muda se você apagar essa pasta.

> O firewall do sistema (macOS: *Ajustes → Rede → Firewall*) pode perguntar se o Node pode aceitar conexões. Permita, senão a outra máquina recebe "sem resposta".

### 2. Gerar o token da máquina

*Configurações → Máquinas → Adicionar máquina → **Direto (IP:porta)***. Dê um nome, escolha executores e tarefas em paralelo e clique em **Gerar token**. A tela mostra:

- o **token** (`cwk_…`), uma única vez;
- o comando `carbon join` pronto para cada IP deste computador na rede, já com `--fingerprint`, `--parallel` e `--executors`;
- a versão para IP público.

Não precisa de *URL pública do painel* nesse modo.

### 3. No outro computador

Precisa do Carbon instalado (clone do repositório + `npm install`, mesma versão do painel) e do Claude Code e/ou Codex logados.

```sh
carbon join 192.168.0.12:3418 --fingerprint 5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01
# (ou: node bin/carbon.mjs join …)
```

O comando:

1. abre uma conexão TLS **sem enviar nada** e lê o certificado;
2. compara com `--fingerprint` (se não bater, para com "o certificado apresentado NÃO confere");
3. pede o token (entrada oculta; não fica no histórico do shell nem no `ps`);
4. sobe o worker (`carbon worker`) com `CARBON_PANEL_URL=https://192.168.0.12:3418` e `CARBON_PANEL_FINGERPRINT=…`.

A máquina aparece em *Configurações → Máquinas* como **ociosa**. Tarefas com **Onde rodar → Pool de workers** passam a rodar nela. `Ctrl+C` para; uma segunda vez sai na hora.

### Pela internet (IP público)

1. Descubra o IP público do computador do painel (ex.: no próprio roteador).
2. No roteador, crie um **port forwarding** TCP `3418 → <ip-local-do-painel>:3418`.
3. Na outra máquina: `carbon join <ip-público>:3418 --fingerprint …`.

Só `/api/worker/*` fica exposto, e só para quem tem token. Qualquer outra rota responde `404` vazio, e sem token a resposta é `401`. Mesmo assim, uma porta aberta na internet recebe varredura automática: revogue máquinas que não usa e prefira uma VPN (Tailscale) se puder ([exposing-the-panel.md](exposing-the-panel.md)).

IP público residencial costuma mudar (IP dinâmico). Quando mudar, rode o `carbon join` de novo com o IP novo: o fingerprint continua o mesmo. CGNAT (comum em operadoras móveis e algumas fibras) impede o port forwarding; nesse caso use Tailscale ou Cloudflare Tunnel.

## Opções do `carbon join`

```
carbon join <ip-ou-host>[:porta] [opções]
  --fingerprint <sha256>   fingerprint do certificado do painel
  --token <cwk_…>          token da máquina (melhor: deixe o comando perguntar ou use CARBON_WORKER_TOKEN)
  --parallel <N>           tarefas ao mesmo tempo (padrão 1)
  --executors <lista>      claude,codex (padrão: os instalados)
  --dir <pasta>            pasta de trabalho do worker
  --yes                    aceita o fingerprint apresentado sem perguntar (só em rede confiável)
```

- **Porta padrão**: 3418 (`carbon join 192.168.0.12` = `:3418`).
- **Formato do fingerprint**: 64 hex, com ou sem `:`, maiúsculas ou minúsculas, com ou sem prefixo `sha256:`.
- **Sem `--fingerprint`** num terminal: o comando mostra o fingerprint e pergunta se confere com o do painel (primeiro contato, como no SSH). Fora de terminal (serviço, script), `--fingerprint` é obrigatório.
- **Certificado de CA pública** (ex.: listener com `CARBON_WORKER_TLS_CERT` de Let's Encrypt): o `carbon join` detecta e não fixa nada.
- **`http://` é recusado**: o token nunca trafega sem TLS fora de loopback.

### Rodar como serviço (sem terminal)

```sh
CARBON_WORKER_TOKEN=cwk_… carbon join 192.168.0.12:3418 --fingerprint 5c18… --parallel 2
```

Ou direto o worker, com as mesmas variáveis que o `join` define:

```sh
CARBON_PANEL_URL=https://192.168.0.12:3418 \
CARBON_PANEL_FINGERPRINT=5c187335… \
CARBON_WORKER_TOKEN=cwk_… \
carbon worker
```

Num `systemd`/`launchd`, ponha o token num arquivo de ambiente com permissão `0600`, não na linha de comando.

### Docker Compose / Kubernetes apontando para um IP

Os kits funcionam com `https://<ip>:3418`. Acrescente `CARBON_PANEL_FINGERPRINT=<fingerprint>` ao `.env` (Compose) ou ao `env` do Deployment (Kubernetes): é público, não precisa ir no Secret.

## Variáveis

| Onde | Variável | Padrão | Efeito |
| --- | --- | --- | --- |
| Painel | `CARBON_WORKER_LISTEN` | — | `0.0.0.0:3418` ou um IP da máquina: aceita outros computadores |
| Painel | `CARBON_WORKER_TLS` | `auto` | `auto`: certificado próprio quando o listener não é loopback. `on`: certificado próprio sempre (ex.: porta de container publicada em `127.0.0.1`). `off`: HTTP puro (só atrás de túnel/VPN que já termina TLS) |
| Painel | `CARBON_WORKER_TLS_CERT` / `_KEY` | — | Certificado seu (de CA). Tem prioridade sobre o autoassinado |
| Worker | `CARBON_PANEL_FINGERPRINT` | — | SHA-256 do certificado do painel. Com ele, `https://<ip>:<porta>` com certificado autoassinado é aceito e qualquer outro certificado é recusado |

`carbon start` também repassa ao painel `CARBON_WORKER_JOIN_PORT/_HOST/_TLS/_FINGERPRINT` (uso interno: é de onde a tela *Direto* tira porta, IPs e fingerprint). Com `npm run dev` o listener não sobe e a opção *Direto* explica como ligar.

## Segurança

- **O que protege**: TLS com o certificado fixado. Sem o fingerprint certo não há conexão; o token só é escrito depois da verificação (sessão TLS não é reaproveitada, então todo socket passa pela verificação).
- **Primeiro contato sem `--fingerprint`**: você está confiando no que a rede entregou naquele momento. Compare o fingerprint com o que aparece no painel antes de aceitar; em rede que você não controla (Wi‑Fi público), use sempre `--fingerprint`.
- **Trocou o certificado** (apagou `worker-tls/`): todos os workers passam a recusar o painel. Rode o `carbon join` de novo com o fingerprint novo.
- **O código sai do computador do painel** para quem você deu token, como em qualquer worker ([security.md](security.md)). Revogar a máquina em *Configurações → Máquinas* corta o acesso na hora.
- **Porta 3417 (UI) nunca é exposta**: só o listener (3418) aceita conexões de fora.

## Problemas comuns

| Mensagem | Causa | O que fazer |
| --- | --- | --- |
| `sem resposta de <ip>:3418 em 10s` | Painel desligado, IP errado, firewall do sistema ou porta não encaminhada | Teste `nc -vz <ip> 3418` da outra máquina; libere o Node no firewall; confira o port forwarding |
| `conexão recusada` | Nada ouvindo na porta | `CARBON_WORKER_LISTEN=0.0.0.0:3418` no `.env.local` e `carbon start` (não `npm run dev`) |
| `o listener não está usando TLS` | `CARBON_WORKER_TLS=off` no painel | Remova e reinicie |
| `o certificado apresentado NÃO confere com --fingerprint` | Fingerprint copiado errado, `worker-tls/` recriado ou outro servidor no endereço | Copie de novo de *Configurações → Máquinas → Direto* ou do terminal do `carbon start`. Se nada mudou no painel, **não conecte** |
| Worker: `o certificado do painel não confere com CARBON_PANEL_FINGERPRINT` | Mesmo caso, com o worker já rodando | Idem; o worker tenta de novo com backoff até você corrigir |
| `CARBON_PANEL_FINGERPRINT exige CARBON_PANEL_URL com https://` | URL com `http://` | Use `https://<ip>:<porta>` |
| Tela *Direto*: "o listener de workers está desligado" | Painel iniciado sem `CARBON_WORKER_LISTEN` ou com `npm run dev` | Defina a variável e use `npm start` |
| Tela *Direto*: "só aceita conexões deste computador" | `CARBON_WORKER_LISTEN=127.0.0.1:…` | Use `0.0.0.0:3418` (ou `CARBON_WORKER_TLS=on` se a porta for publicada por outro meio) |
| `não consegui gerar o certificado do listener (openssl não encontrado)` | Sem `openssl` no computador do painel | Instale o openssl ou use `CARBON_WORKER_TLS_CERT`/`_KEY` |
