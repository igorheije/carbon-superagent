# FAQ — execução distribuída

**Preciso de workers para usar o Carbon?**
Não. O padrão continua sendo `local`: uma tarefa por vez, na máquina do painel, sem rede.

**O painel continua só em `127.0.0.1`?**
A UI e a API administrativa, sim. Com `CARBON_WORKER_LISTEN`, uma segunda porta passa a aceitar **apenas** `/api/worker/*`, com token. Você decide como expor essa porta (VPN, túnel, reverse proxy com TLS).

**A máquina worker precisa de porta aberta?**
Não. O worker só faz conexões de saída: painel, API do modelo e git.

**Quantas tarefas rodam ao mesmo tempo?**
Locais: 1. Remotas: soma de réplicas × `CARBON_WORKER_PARALLEL` de todas as máquinas, mais até `agentcore.maxConcurrent` sessões AgentCore. Local e remotas rodam em paralelo.

**O worker precisa de acesso ao meu repositório git?**
Só se o projeto tem `origin` e o branch base existe no remoto (transporte `git`). Sem remoto, sem commits ou com base só local, o código vai por bundle a partir do painel. Para push, o worker precisa de `CARBON_GIT_TOKEN` com o host em `CARBON_GIT_HOSTS`; sem isso ele entrega por bundle.

**O worker usa o login do Claude Code do meu computador?**
Não. Cada máquina worker usa as credenciais configuradas nela (`ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`; `OPENAI_API_KEY` para Codex). O painel nunca envia credenciais de modelo.

**Posso usar Codex nos workers?**
Sim, com a imagem construída com `--build-arg WITH_CODEX=true` e `OPENAI_API_KEY`. No AgentCore, só Claude Code.

**Onde a imagem do worker está publicada?**
Em lugar nenhum. Construa com `deploy/worker/Dockerfile` a partir do repositório, na mesma versão do painel, e publique no seu registry se tiver mais de uma máquina.

**Worker e painel precisam estar na mesma versão?**
Precisam falar o mesmo protocolo (hoje, `1`). Worker mais antigo que o painel recebe `426` e sai. Na prática, mantenha a mesma versão do Carbon nos dois.

**O que acontece se o worker cair no meio de uma tarefa?**
Depois de `leaseMs` sem heartbeat (60 s padrão), a tarefa falha com `worker <nome> parou de responder` — ou volta para a fila, com `workers.requeueOnLeaseLoss`. Nada é entregue pela execução interrompida.

**E se o painel reiniciar?**
Tarefas remotas com lease válido continuam; os workers reenviam os eventos sem ack. Ver [operations.md](operations.md#reinício-do-painel).

**Como funcionam permissões e perguntas em tarefas remotas?**
Permissões: como local, com o worker esperando a resposta do painel. Perguntas: a execução termina, você responde, e a tarefa volta para a fila do mesmo runtime recomeçando da base com as decisões no prompt. Ver [operations.md](operations.md#permissões-em-execução-remota).

**Posso escolher em qual máquina uma tarefa roda?**
Não. Qualquer worker do pool com o executor da tarefa pode pegá-la.

**Tem autoscaling?**
Não. Escala manual (`docker compose up -d --scale worker=N`, `kubectl scale`).

**O AgentCore está pronto para produção?**
Não. É **experimental**. Veja os pontos de atenção em [agentcore.md](agentcore.md#pontos-de-atenção).

**O Carbon cria recursos na minha conta AWS?**
Não. O `deploy.sh` do kit é executado por você. O painel só chama `InvokeAgentRuntime` e `StopRuntimeSession` num runtime que você já criou, com as credenciais AWS da máquina do painel.

**Quanto custa o AgentCore?**
Depende da sua conta: tempo de sessão do AgentCore Runtime + chamadas ao modelo (Bedrock ou API da Anthropic). O Carbon limita sessões simultâneas (padrão 3) e encerra a sessão ao fim de cada tarefa; não estima custo.

**Revoguei uma máquina por engano. Dá para desfazer?**
Não. Gere um kit novo (token novo) e atualize o `.env`/Secret da máquina.

**Posso escrever um worker em outra linguagem?**
Sim: o protocolo é HTTP+JSON. Veja [protocol.md](protocol.md).

**Os logs do agente remoto ficam onde?**
No painel (SQLite local), como nas tarefas locais. Na máquina worker ficam só os logs do processo worker (sem tokens). No AgentCore, também no CloudWatch.
