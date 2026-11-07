# Join por IP, sem servidor — `carbon join <ip>:<porta>`

É o mesmo [`carbon join` do cluster](cluster-join.md) (token de join `cjt_…`, credencial própria do nó, `carbon leave`, pausar/remover no painel), apontando para um **IP e porta** em vez de uma URL. Para quando **não há servidor, domínio, túnel nem Docker**: o painel roda no seu computador e outro computador entra como worker apontando para **`<ip>:<porta>`**, seja na **rede local** (`192.168.x.x`, `10.x.x.x`) ou pelo **IP público** (com a porta liberada no roteador).

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
│  Gere o token de join em Configurações → Máquinas → Entrar no cluster (ou `carbon join-token --rotate`).
│  Na outra máquina (rede local):
│    carbon join 192.168.0.12:3418 --token cjt_… --fingerprint 5c187335…2a01
│  Pela internet: libere a porta 3418 no roteador (port forwarding) e use
│    carbon join <ip-público>:3418 --token cjt_… --fingerprint 5c187335…2a01
```

O certificado fica em `<pasta de dados>/worker-tls/` (pasta `0700`, chave `0600`) e é **reaproveitado** nos próximos `carbon start`: o fingerprint só muda se você apagar essa pasta.

> O firewall do sistema (macOS: *Ajustes → Rede → Firewall*) pode perguntar se o Node pode aceitar conexões. Permita, senão a outra máquina recebe "sem resposta".

### 2. Gerar o token de join

*Configurações → Máquinas → **Entrar no cluster** → Gerar token de join* (ou `carbon join-token --rotate` no computador do painel). Opcional: validade, máximo de servidores, "Exigir aprovação". A tela mostra, uma única vez:

- o comando `carbon join` com o **IP deste computador** e o `--fingerprint` (quando não há *URL pública do painel* configurada);
- o mesmo para os outros IPs deste computador (Wi‑Fi, cabo, VPN) e para o **IP público**;
- o `docker run` equivalente, com `CARBON_PANEL_FINGERPRINT`.

Não precisa de *URL pública do painel* nesse modo. Se ela estiver configurada com o próprio `https://<ip>:3418` do listener, o comando principal também sai com o fingerprint.

### 3. No outro computador

Precisa do Carbon instalado (clone do repositório + `npm install`, mesma versão do painel) e do Claude Code e/ou Codex logados.

```sh
carbon join 192.168.0.12:3418 --token cjt_… --fingerprint 5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01
# (ou: npx carbon join … / node bin/carbon.mjs join …)
```

O comando:

1. abre uma conexão TLS **sem enviar nada** e lê o certificado;
2. compara com `--fingerprint` (se não bater, para com "o certificado apresentado NÃO confere");
3. troca o token de join pela credencial própria do nó (`cwk_…`), salva em `~/.carbon-worker/nodes/<hostname>.json` (`0600`) **junto com o fingerprint**;
4. sobe o worker com o certificado fixado. Reiniciar (`carbon worker` com `CARBON_PANEL_URL=https://192.168.0.12:3418`, ou `carbon join` de novo) reaproveita o mesmo nó e o mesmo pin.

O nó aparece em *Configurações → Máquinas* (selo `join`). Tarefas com **Onde rodar → Pool de workers** passam a rodar nela. `Ctrl+C` para; uma segunda vez sai na hora.

### Pela internet (IP público)

1. Descubra o IP público do computador do painel (ex.: no próprio roteador).
2. No roteador, crie um **port forwarding** TCP `3418 → <ip-local-do-painel>:3418`.
3. Na outra máquina: `carbon join <ip-público>:3418 --token cjt_… --fingerprint …`.

Só `/api/worker/*` fica exposto, e só para quem tem token. Qualquer outra rota responde `404` vazio, e sem token a resposta é `401`. Mesmo assim, uma porta aberta na internet recebe varredura automática: revogue máquinas que não usa e prefira uma VPN (Tailscale) se puder ([exposing-the-panel.md](exposing-the-panel.md)).

IP público residencial costuma mudar (IP dinâmico). Quando mudar, rode o `carbon join` de novo com o IP novo e o token de join: o fingerprint continua o mesmo (o nó novo entra; remova o antigo no painel). CGNAT (comum em operadoras móveis e algumas fibras) impede o port forwarding; nesse caso use Tailscale ou Cloudflare Tunnel.

## Opções do `carbon join`

```
carbon join <url-do-painel | ip[:porta]> --token cjt_… [opções]
  --token <cjt_…>          token de join (ou CARBON_JOIN_TOKEN)
  --fingerprint <sha256>   fingerprint do certificado do painel
  --name <nome>            nome do nó no painel (padrão: hostname)
  --yes                    aceita o fingerprint apresentado sem perguntar (só em rede confiável)
```

Paralelismo, executores e pasta vêm das variáveis de sempre (`CARBON_WORKER_PARALLEL`, `CARBON_WORKER_EXECUTORS`, `CARBON_WORKER_DIR`).

- **Endereço sem esquema** (`192.168.0.12:3418`) vira `https://192.168.0.12:3418`; sem porta, 3418 (`carbon join 192.168.0.12` = `:3418`). Com esquema (`https://painel.exemplo.com`), é o join de sempre.
- **Formato do fingerprint**: 64 hex, com ou sem `:`, maiúsculas ou minúsculas, com ou sem prefixo `sha256:`.
- **Sem `--fingerprint`** num terminal: o comando mostra o fingerprint e pergunta se confere com o do painel (primeiro contato, como no SSH). Fora de terminal (serviço, script), `--fingerprint` é obrigatório.
- **Certificado de CA pública** (ex.: listener com `CARBON_WORKER_TLS_CERT` de Let's Encrypt): o `carbon join` detecta e não fixa nada.
- **`http://` só em loopback**: fora disso o worker recusa, e o token nunca trafega sem TLS.

### Rodar como serviço (sem terminal)

```sh
CARBON_JOIN_TOKEN=cjt_… CARBON_WORKER_PARALLEL=2 carbon join 192.168.0.12:3418 --fingerprint 5c18…
```

Depois do primeiro join, o serviço pode rodar só o worker; a credencial e o pin salvos são reaproveitados:

```sh
CARBON_PANEL_URL=https://192.168.0.12:3418 carbon worker
```

Num `systemd`/`launchd`, ponha tokens num arquivo de ambiente com permissão `0600`, não na linha de comando.

### Docker

O `docker run` mostrado em *Entrar no cluster* já leva `-e CARBON_PANEL_FINGERPRINT=…`. Nos kits Compose/Kubernetes por máquina, acrescente `CARBON_PANEL_FINGERPRINT=<fingerprint>` ao `.env` ou ao `env` do Deployment: é público, não precisa ir no Secret.

## Variáveis

| Onde | Variável | Padrão | Efeito |
| --- | --- | --- | --- |
| Painel | `CARBON_WORKER_LISTEN` | — | `0.0.0.0:3418` ou um IP da máquina: aceita outros computadores |
| Painel | `CARBON_WORKER_TLS` | `auto` | `auto`: certificado próprio quando o listener não é loopback. `on`: certificado próprio sempre (ex.: porta de container publicada em `127.0.0.1`). `off`: HTTP puro (só atrás de túnel/VPN que já termina TLS) |
| Painel | `CARBON_WORKER_TLS_CERT` / `_KEY` | — | Certificado seu (de CA). Tem prioridade sobre o autoassinado |
| Worker | `CARBON_PANEL_FINGERPRINT` | — (ou o salvo pelo join) | SHA-256 do certificado do painel. Com ele, `https://<ip>:<porta>` com certificado autoassinado é aceito e qualquer outro certificado é recusado |

`carbon start` também repassa ao painel `CARBON_WORKER_JOIN_PORT/_HOST/_TLS/_FINGERPRINT` (uso interno: é de onde *Entrar no cluster* tira porta, IPs e fingerprint). Com `npm run dev` o listener não sobe e os comandos saem com a URL pública (ou o placeholder).

## Segurança

- **O que protege**: TLS com o certificado fixado. Sem o fingerprint certo não há conexão; o token (de join ou do nó) só é escrito depois da verificação (sessão TLS não é reaproveitada, então todo socket passa pela verificação).
- **Primeiro contato sem `--fingerprint`**: você está confiando no que a rede entregou naquele momento. Compare o fingerprint com o que aparece no painel antes de aceitar; em rede que você não controla (Wi‑Fi público), use sempre `--fingerprint`.
- **Trocou o certificado** (apagou `worker-tls/`): todos os workers passam a recusar o painel. Rode o `carbon join` de novo com o fingerprint novo.
- **O token de join é uma senha**: quem tiver coloca computadores no cluster e recebe tarefas. Use validade/máximo de usos ou "Exigir aprovação", e gire o token depois de usar.
- **O código sai do computador do painel** para os nós que entraram, como em qualquer worker ([security.md](security.md)). Remover o nó em *Configurações → Máquinas* corta o acesso na hora.
- **Porta 3417 (UI) nunca é exposta**: só o listener (3418) aceita conexões de fora.

## Problemas comuns

| Mensagem | Causa | O que fazer |
| --- | --- | --- |
| `sem resposta de <ip>:3418 em 10s` | Painel desligado, IP errado, firewall do sistema ou porta não encaminhada | Teste `nc -vz <ip> 3418` da outra máquina; libere o Node no firewall; confira o port forwarding |
| `conexão recusada` | Nada ouvindo na porta | `CARBON_WORKER_LISTEN=0.0.0.0:3418` no `.env.local` e `carbon start` (não `npm run dev`) |
| `o listener não está usando TLS` | `CARBON_WORKER_TLS=off` no painel | Remova e reinicie |
| `o certificado apresentado NÃO confere com --fingerprint` | Fingerprint copiado errado, `worker-tls/` recriado ou outro servidor no endereço | Copie de novo de *Configurações → Máquinas → Entrar no cluster* ou do terminal do `carbon start`. Se nada mudou no painel, **não conecte** |
| Worker: `o certificado do painel não confere com CARBON_PANEL_FINGERPRINT` | Mesmo caso, com o worker já rodando | Idem; o worker tenta de novo com backoff até você corrigir |
| `CARBON_PANEL_FINGERPRINT exige CARBON_PANEL_URL com https://` | URL com `http://` | Use `https://<ip>:<porta>` |
| *Entrar no cluster* mostra o placeholder `https://<url-pública-do-painel>` | Listener desligado, só em `127.0.0.1` ou painel com `npm run dev` | `CARBON_WORKER_LISTEN=0.0.0.0:3418` e `npm start` (ou `CARBON_WORKER_TLS=on` se a porta for publicada por outro meio) |
| `o painel recusou o token de join` | Token girado, expirado ou no máximo de usos | Gere outro em *Entrar no cluster* |
| `não consegui gerar o certificado do listener (openssl não encontrado)` | Sem `openssl` no computador do painel | Instale o openssl ou use `CARBON_WORKER_TLS_CERT`/`_KEY` |
