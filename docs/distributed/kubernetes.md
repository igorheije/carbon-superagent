# Workers no Kubernetes

O kit Kubernetes cria um namespace com um `Deployment` de workers. Igual ao Compose, o worker não recebe tráfego: só faz conexões de saída para o painel, o modelo e o git.

## Gerar o kit

Mesmos pré-requisitos e campos do [Compose](docker-compose.md#gerar-o-kit), escolhendo **Kubernetes**. Por CLI:

```sh
node bin/carbon.mjs worker init --target k8s --name cluster-a \
  --panel-url https://workers.exemplo.com \
  --replicas 3 --parallel 1 --executors claude \
  --image ghcr.io/sua-org/carbon-worker:0.2.0 \
  --out ./carbon-worker-cluster-a
```

No Kubernetes, use sempre uma imagem de registry acessível pelo cluster (a imagem padrão `carbon-worker:<versão>` só existe na máquina que a construiu). Como construir: [docker-compose.md#imagem](docker-compose.md#imagem).

## Arquivos

Com `<nome>` = slug da máquina e namespace `carbon-<nome>`:

| Arquivo | Conteúdo |
| --- | --- |
| `namespace.yaml` | Namespace `carbon-<nome>` |
| `secret.yaml` | `Secret` `carbon-worker` com `CARBON_WORKER_TOKEN` e linhas comentadas para `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CARBON_GIT_TOKEN`. **Único arquivo com o token.** |
| `deployment.yaml` | `Deployment` `carbon-worker` (detalhes abaixo) |
| `networkpolicy.yaml` | Bloqueia todo ingress; egress liberado (`egress: [{}]`) — restrinja com `ipBlock`/porta do seu ambiente |
| `kustomization.yaml` | Junta os quatro arquivos |
| `README.md` | Passo a passo |

`deployment.yaml`:

- `replicas` do kit; `terminationGracePeriodSeconds: 600` e `CARBON_WORKER_GRACE_SECONDS=540` (o worker termina antes do SIGKILL);
- `envFrom` do Secret + `CARBON_PANEL_URL`, `CARBON_WORKER_PARALLEL`, `CARBON_WORKER_EXECUTORS`, `CARBON_WORKER_DIR=/home/carbon/work`;
- `requests` = `limits` = 2 CPU e `4Gi`;
- `runAsNonRoot`, UID/GID/fsGroup `10001`, `readOnlyRootFilesystem: true`; `/home/carbon` e `/tmp` são `emptyDir` (o clone de cada tarefa vive ali e some com o pod).

## Aplicar

```sh
# 1. preencha secret.yaml (descomente as credenciais do modelo; CARBON_GIT_TOKEN se usar push)
#    e, se usar token git, adicione CARBON_GIT_HOSTS (ex.: github.com) no Secret ou no env do Deployment
# 2. aplique
kubectl apply -k .
```

Em produção, não versione `secret.yaml`: use Sealed Secrets, External Secrets ou o gerenciador de segredos do seu cluster.

## Operar

```sh
kubectl -n carbon-<nome> scale deployment/carbon-worker --replicas=N
kubectl -n carbon-<nome> logs -f -l app.kubernetes.io/name=carbon-worker --max-log-requests=20
kubectl -n carbon-<nome> rollout restart deployment/carbon-worker
kubectl -n carbon-<nome> set image deployment/carbon-worker worker=ghcr.io/sua-org/carbon-worker:<nova>
```

**Parada e rollout.** Ao remover um pod, o worker para de pegar tarefas e espera as atuais por até 540 s. Passado isso, cancela e reporta `canceled`. Em tarefas longas, prefira escalar para zero quando a fila estiver vazia antes de atualizar.

**Capacidade.** Réplicas × `CARBON_WORKER_PARALLEL` tarefas simultâneas. Para isolar tarefas entre si, mantenha `CARBON_WORKER_PARALLEL=1` e escale por réplicas (o `HOME` é compartilhado entre tarefas do mesmo pod). Todas as réplicas usam o mesmo token e aparecem como **uma** máquina na frota; a coluna "Tarefa atual" lista as tarefas de todas.

**Autoscaling.** Não há métrica de fila exposta (fora do escopo); HPA por CPU não reflete a fila. Escale manualmente.

## Revogar

1. Painel: *Configurações → Máquinas → Revogar*.
2. Cluster: `kubectl delete -k .` (apaga o namespace e o Secret).
3. Para voltar: gere um kit novo.
