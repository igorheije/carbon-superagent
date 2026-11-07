# Segurança do trabalho cooperativo

## O que fica onde

| Item | Onde fica | Nunca |
| --- | --- | --- |
| Login do Claude Code | Keychain deste Mac (ou arquivo 0600 de `claude setup-token`) | no servidor, no chat, em log |
| Link/código de pareamento do Orca | só em trânsito dentro de `pair.sh`; apagado do log do servidor | no chat, em arquivo local |
| Acesso ao runtime Orca do servidor | grant por cliente, revogável no servidor | porta pública |
| Código | commit enviado para `~/coop/<repo>.git` no servidor | mudanças não commitadas, repos em `blockedRepos` |

## Rede

- `orca-ide serve --bind 127.0.0.1`: nada escuta em interface pública no servidor.
- `ssh -R 127.0.0.1:8787`: o proxy só é alcançável no loopback do servidor (`GatewayPorts no`, padrão).
- O proxy só fala com `api.anthropic.com` (upstream fixo) e descarta qualquer credencial recebida.

## Riscos que continuam

- **Root no servidor** usa a sua conta do Claude enquanto o túnel estiver aberto e lê o código enviado.
  Use servidores que você controla; `disconnect` quando não estiver usando.
- **Mesma conta, mesma quota.**
- **Servidor com produção**: a conta do worker sem sudo e fora do `docker` impede o agente de mexer nos
  serviços; a spec do worker proíbe infraestrutura e manda perguntar.

## Repos que não saem da máquina

`~/.carbon-coop/config.json`:

```json
{ "blockedRepos": ["payments-ms", "github.com/minha-org/dados-clientes"] }
```

Nome do diretório ou trecho da URL do `origin`. `code-sync.sh push` recusa.

## Fora do macOS (coordenador Linux)

Em outro terminal (não pela sessão, para o token não entrar no transcript): `claude setup-token`,
salve o token num arquivo `chmod 600` e exporte `COOP_PROXY_TOKEN_FILE=<arquivo>` antes do `proxy.sh start`.

## Se algo vazou

- Senha colada no chat: trate como vazada, troque e desative login por senha no SSH.
- Link de pareamento exposto: revogue o grant em *Shared Server Access* no servidor (ou pare o
  `orca-ide serve`) e pareie de novo.
- Token do Claude exposto: `claude logout` + login de novo no coordenador.
