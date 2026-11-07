# Expor o painel para workers

Workers e containers AgentCore só precisam alcançar **`/api/worker/*`**. A UI e o resto da API continuam em `127.0.0.1`. Para isso o Carbon tem um **listener separado** (`bin/worker-proxy.mjs`) que encaminha apenas essas rotas para o painel local.

```
worker ──HTTPS──▶ túnel / VPN / reverse proxy ──▶ 127.0.0.1:3418 (listener) ──▶ 127.0.0.1:3417 (painel)
                                                   só /api/worker/*            UI + API completa
```

## Ligar o listener

```sh
# .env.local do painel (ou variável de ambiente; o ambiente do processo vence o arquivo)
CARBON_WORKER_LISTEN=127.0.0.1:3418     # host:porta, [ipv6]:porta ou só a porta (= 0.0.0.0)
# TLS: auto (padrão) = certificado próprio quando o listener não é loopback; on = sempre; off = nunca
CARBON_WORKER_TLS=auto
# opcional: certificado seu (os dois juntos, ou nenhum); tem prioridade sobre o autoassinado
CARBON_WORKER_TLS_CERT=/caminho/cert.pem
CARBON_WORKER_TLS_KEY=/caminho/key.pem
# opcional: limites de conexão (padrões 256 e 32)
CARBON_WORKER_MAX_CONNECTIONS=256
CARBON_WORKER_MAX_CONNECTIONS_PER_IP=32
```

`npm start` (`carbon start`) sobe o listener junto com o painel e o encerra junto. Na saída:

```
Workers remotos: https://<este-host>:3418/api/worker/ (só /api/worker/*; a UI segue em 127.0.0.1)
```

Com `CARBON_WORKER_LISTEN=0.0.0.0:3418` (ou um IP da máquina), o listener gera um **certificado autoassinado** em `<pasta de dados>/worker-tls/` e `carbon start` mostra os IPs, o fingerprint e o comando `carbon join` pronto ([direct-join.md](direct-join.md)). Em `127.0.0.1` ele fica em HTTP (o túnel/VPN na frente termina o TLS) e `carbon start` avisa: `Listener sem TLS: use só atrás de um túnel HTTPS (Cloudflare Tunnel, Tailscale) apontando para essa porta.`

Só o listener, para depuração: `CARBON_WORKER_LISTEN=127.0.0.1:3418 CARBON_PORT=3417 node bin/worker-proxy.mjs`.

## O que o listener faz

- Encaminha **apenas** caminhos canônicos `/api/worker/<algo>`; qualquer outro caminho recebe `404` sem corpo.
- Recusa `.`/`..`, segmentos vazios, barra invertida e as versões codificadas (`%2e`, `%2f`, `%5c`, `%00`, `%25`), forma absoluta (`GET http://…`), `CONNECT` e upgrades (WebSocket/h2c).
- Exige `Authorization: Bearer cwk_…` ou `Bearer ctk_…` em formato válido; sem isso responde `401` sem encaminhar.
- Aceita só query strings simples (ex.: `?after=12`); o resto → `400`.
- Corpo ≤ 1 MB fora das rotas de bundle; nas de bundle, teto absoluto de 1 GB (o limite real é `workers.maxBundleMb` no painel, padrão 200 MB). Acima → `413`.
- Conexões: 256 no total (`CARBON_WORKER_MAX_CONNECTIONS`) e 32 por IP (`CARBON_WORKER_MAX_CONNECTIONS_PER_IP`); conexões acima do limite são fechadas.
- Remove cabeçalhos hop-by-hop e os `X-Forwarded-*` enviados pelo cliente; define `X-Forwarded-For`, `X-Forwarded-Proto` e `X-Forwarded-Host` ele mesmo.
- Timeouts: 30 s para receber os cabeçalhos, 120 s de inatividade, e tempo total de 60 s por requisição (30 min nas rotas de bundle) → `408`.
- Registra uma linha por requisição — IP, método, caminho, status, duração — sem `Authorization` e sem query string.

O painel ainda valida o token, aplica rate limit por token e por IP (pelo `X-Forwarded-For` que o listener define) e limita o corpo JSON em 1 MB em todas as rotas `/api/worker/*` ([security.md](security.md)). Por isso **nunca exponha a porta 3417** diretamente: o limite por IP só é confiável atrás do listener.

## Como expor (ordem de preferência)

### 0. Direto por IP, sem servidor (`carbon join`)

Painel no seu computador, outro computador na mesma rede (ou pela internet, com a porta liberada no roteador). Sem domínio, túnel nem Docker:

```sh
# painel (.env.local)
CARBON_WORKER_LISTEN=0.0.0.0:3418
# outro computador
carbon join 192.168.0.12:3418 --token cjt_… --fingerprint <sha256 mostrado pelo painel>
```

TLS com certificado próprio, fixado pelo fingerprint no worker. Guia completo: [direct-join.md](direct-join.md).

### 1. Tailscale (ou outra VPN)

Tráfego cifrado pela VPN, sem porta aberta na internet.

```sh
CARBON_WORKER_LISTEN=127.0.0.1:3418
tailscale serve --https=443 http://127.0.0.1:3418
```

URL nos workers: `https://<host>.<tailnet>.ts.net`. Os workers precisam estar na mesma tailnet. Para AgentCore (fora da tailnet) use **Tailscale Funnel** ou a opção 2.

O worker exige `https://` para qualquer painel que não seja loopback; `http://<ip-da-vpn>:3418` é recusado. Para usar o IP da VPN direto, deixe o listener nesse IP (TLS automático) e use `carbon join <ip-da-vpn>:3418` ([direct-join.md](direct-join.md)).

### 2. Cloudflare Tunnel

Aponte o túnel **só para a porta do listener**, nunca para a do painel (3417):

```sh
cloudflared tunnel --url http://127.0.0.1:3418
```

Num túnel nomeado, o `ingress` deve ter um único serviço `http://127.0.0.1:3418` e terminar em `http_status:404`:

```yaml
ingress:
  - hostname: workers.exemplo.com
    service: http://127.0.0.1:3418
  - service: http_status:404
```

### 3. Reverse proxy próprio com TLS

Caddy, nginx etc. terminando TLS e encaminhando para `127.0.0.1:3418`. Configure timeout de leitura ≥ 60 s (long-poll de 25 s) e corpo máximo ≥ `maxBundleMb` nas rotas de bundle.

```
workers.exemplo.com {
  reverse_proxy 127.0.0.1:3418
}
```

### TLS direto no listener

Com `CARBON_WORKER_TLS_CERT`/`CARBON_WORKER_TLS_KEY`, o listener fala HTTPS com o seu certificado. Útil em LAN com certificado interno. Sem certificado próprio, o autoassinado + `CARBON_PANEL_FINGERPRINT` resolve o mesmo caso ([direct-join.md](direct-join.md)). Os workers precisam confiar no certificado (CA da empresa, ou `NODE_EXTRA_CA_CERTS` no ambiente do worker para um certificado próprio).

**Nunca** exponha o listener por HTTP puro fora de loopback: o token do worker vai no cabeçalho `Authorization`.

## URL pública (`panelPublicUrl`)

Não é obrigatória no join por IP (`carbon join <ip>:<porta>`): sem ela, *Entrar no cluster* monta o comando com o IP deste computador e o fingerprint. Nos outros casos, depois de expor, configure *Configurações → Execução → Workers e AgentCore → URL pública do painel* com a URL `https://…` que chega no listener (sem barra final; só `https://` é aceito). Ela:

- entra no `.env`/Deployment dos kits gerados pela UI (`CARBON_PANEL_URL`);
- vai no payload de cada invocação do AgentCore;
- é pré-requisito para "Adicionar máquina" e para o runtime AgentCore aparecer disponível.

Trocar a URL não atualiza kits já gerados: edite `CARBON_PANEL_URL` nas máquinas.

## Checklist

- [ ] `CARBON_WORKER_LISTEN` em `127.0.0.1` com o túnel/proxy apontando para essa porta (não para 3417), **ou** em `0.0.0.0`/IP da rede com o certificado autoassinado e `carbon join --fingerprint`.
- [ ] HTTPS de ponta a ponta para tudo que não é loopback.
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://workers.exemplo.com/` → `404`; `curl -s -o /dev/null -w '%{http_code}' -X POST https://workers.exemplo.com/api/worker/hello` (sem token) → `401`.
- [ ] `panelPublicUrl` configurada.
- [ ] Máquinas sem uso revogadas.
