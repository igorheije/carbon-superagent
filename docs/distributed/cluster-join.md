# Cluster join (estilo Docker Swarm)

Coloque servidores para ajudar o painel com **um comando por servidor**. O painel é o "manager"; cada
servidor que entra vira um nó do pool e pega tarefas com **Onde rodar: Pool de workers**.

| Docker Swarm | Carbon |
|---|---|
| `docker swarm join-token worker` | Configurações → Máquinas → **Entrar no cluster** · ou `carbon join-token --rotate` |
| `docker swarm join --token …` | `carbon join https://painel --token cjt_…` · ou o `docker run` mostrado no painel |
| `docker node ls` | lista em Configurações → Máquinas |
| `docker node update --availability drain` | **pausar** (termina o que está rodando, não pega tarefa nova) |
| `docker node rm` | **remover** |
| `docker swarm leave` | `carbon leave` |

## Pré-requisitos

- O painel acessível pelos servidores: `CARBON_WORKER_LISTEN` + URL pública https (ver [exposing-the-panel.md](exposing-the-panel.md)).
  Configure a URL em Configurações → Execução para o comando sair pronto.
- Em cada servidor: Node 22.13+, git e Claude Code (ou Codex) logado — ou Docker com a imagem de `deploy/worker/Dockerfile`.

## Passo a passo

1. No painel: **Gerar token de join**. Opcional: validade, máximo de servidores, "Exigir aprovação".
2. Copie o comando (o token só aparece nessa hora).
3. Em cada servidor:

   ```sh
   npx carbon join 'https://painel.exemplo.com' --token 'cjt_…' [--name gpu-1]
   ```

   ou

   ```sh
   docker run -d --name carbon-worker --restart unless-stopped \
     -e CARBON_PANEL_URL='https://painel.exemplo.com' \
     -e CARBON_JOIN_TOKEN='cjt_…' \
     -e ANTHROPIC_API_KEY='…' \
     -v carbon-worker-state:/home/carbon/state \
     carbon-worker:<versão>
   ```

4. O servidor aparece na lista (selo `join`) e começa a pegar tarefas do pool.

## Como funciona

- O token de join (`cjt_`) só serve para **entrar**. Ao entrar, o servidor recebe uma credencial própria (`cwk_`),
  salva em `~/.carbon-worker/nodes/<hostname>.json` (ou `CARBON_WORKER_STATE_DIR`) com permissão `600`.
- Reiniciar o worker (ou o container, com o volume) reaproveita o mesmo nó: não duplica.
- Girar o token impede joins novos com o antigo; quem já entrou continua.
- Remover um nó revoga só a credencial dele. O worker para com código de saída **3** e não volta sozinho,
  mesmo com `--restart` (para voltar: `carbon join` de novo).
- Container recriado sem o volume entra como nó novo; o antigo fica offline → botão **Limpar offline**.

## Segurança

Quem tem o token de join coloca servidores no cluster e passa a receber tarefas (código e prompt). Trate como senha:
gire depois de usar, prefira validade curta ou máximo de usos, e ligue "Exigir aprovação" se o token circular entre pessoas.
O endpoint de join tem limite de tentativas por IP (429).

## Variáveis

| Variável | Uso |
|---|---|
| `CARBON_JOIN_TOKEN` | token de join (modo Docker/K8s: entra sozinho na primeira subida) |
| `CARBON_WORKER_STATE_DIR` | onde fica a credencial do nó (padrão `~/.carbon-worker`; imagem: `/home/carbon/state`) |
| `CARBON_WORKER_NAME` | nome exibido no painel (padrão: hostname) |

## Limites conhecidos

- Os kits Compose/Kubernetes ainda usam token por máquina; para cluster join use `docker run` (um container = um nó).
- Labels/placement (ex.: "só em nó com GPU") não existem ainda.
- Windows: o worker é Node puro, mas não foi testado em Windows nesta entrega.
