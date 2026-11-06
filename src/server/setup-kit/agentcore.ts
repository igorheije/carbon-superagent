/**
 * AgentCore setup kit (SET-03): pure renderer of the files a Carbon admin needs to deploy the
 * AgentCore Runtime container (dist/agentcore.mjs) in their own AWS account. Nothing here talks to
 * AWS: `deploy.sh` is a generated file the admin runs by hand (decision U5 — implemented and
 * documented, never deployed by Carbon). Output is deterministic (no dates, no randomness) and holds
 * placeholders only, never secrets.
 */

export interface AgentCoreKitOptions {
  /** AWS region. Default sa-east-1. */
  readonly region?: string;
  /** AgentCore runtime name (letters, digits, `_`; starts with a letter). Default carbon_worker. */
  readonly runtimeName?: string;
  /** ECR repository name. Default carbon-agentcore. */
  readonly repositoryName?: string;
  /** Exact @anthropic-ai/claude-code version baked into the image. */
  readonly claudeCodeVersion?: string;
  /** Public panel URL the container reports to (CARBON_PANEL_URL). Placeholder when omitted. */
  readonly panelUrl?: string;
  /** Idle session timeout (s). Default 900 (AgentCore default). */
  readonly idleTimeoutSeconds?: number;
  /** Max session lifetime (s). Default 28800 = 8h, the AgentCore cap. */
  readonly maxLifetimeSeconds?: number;
}

export type KitFiles = Readonly<Record<string, string>>;

export const AGENTCORE_KIT_DEFAULTS = {
  region: "sa-east-1",
  runtimeName: "carbon_worker",
  repositoryName: "carbon-agentcore",
  /** Pinned on purpose: the image must be reproducible. Bump deliberately. */
  claudeCodeVersion: "2.1.319",
  panelUrl: "https://SEU-PAINEL.exemplo.com",
  idleTimeoutSeconds: 900,
  maxLifetimeSeconds: 28_800,
} as const;

/** AgentCore hard cap for a runtime session [Certo]: 8 hours. */
export const AGENTCORE_MAX_LIFETIME_SECONDS = 28_800;
const MIN_TIMEOUT_SECONDS = 60;

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const RUNTIME_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
const REPOSITORY_RE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/** Characters that are safe inside a double-quoted shell default and a JSON/Markdown string. */
const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;

export class InvalidKitOptions extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKitOptions";
  }
}

interface ResolvedOptions {
  readonly region: string;
  readonly runtimeName: string;
  readonly repositoryName: string;
  readonly claudeCodeVersion: string;
  readonly panelUrl: string;
  readonly idleTimeoutSeconds: number;
  readonly maxLifetimeSeconds: number;
}

function check(value: string, re: RegExp, label: string): string {
  if (!re.test(value)) throw new InvalidKitOptions(`${label} inválido: ${JSON.stringify(value.slice(0, 80))}`);
  return value;
}

function seconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_SECONDS || value > AGENTCORE_MAX_LIFETIME_SECONDS) {
    throw new InvalidKitOptions(`${label} precisa ser um inteiro entre ${MIN_TIMEOUT_SECONDS} e ${AGENTCORE_MAX_LIFETIME_SECONDS}`);
  }
  return value;
}

/** Validates options. Everything interpolated into deploy.sh passes a strict allowlist regex. */
export function resolveKitOptions(opts: AgentCoreKitOptions = {}): ResolvedOptions {
  const d = AGENTCORE_KIT_DEFAULTS;
  const idleTimeoutSeconds = seconds(opts.idleTimeoutSeconds ?? d.idleTimeoutSeconds, "idleTimeoutSeconds");
  const maxLifetimeSeconds = seconds(opts.maxLifetimeSeconds ?? d.maxLifetimeSeconds, "maxLifetimeSeconds");
  if (idleTimeoutSeconds > maxLifetimeSeconds) throw new InvalidKitOptions("idleTimeoutSeconds não pode passar de maxLifetimeSeconds");
  return {
    region: check(opts.region ?? d.region, REGION_RE, "region"),
    runtimeName: check(opts.runtimeName ?? d.runtimeName, RUNTIME_NAME_RE, "runtimeName"),
    repositoryName: check(opts.repositoryName ?? d.repositoryName, REPOSITORY_RE, "repositoryName"),
    claudeCodeVersion: check(opts.claudeCodeVersion ?? d.claudeCodeVersion, SEMVER_RE, "claudeCodeVersion"),
    panelUrl: check((opts.panelUrl ?? d.panelUrl).replace(/\/+$/, ""), SAFE_URL_RE, "panelUrl"),
    idleTimeoutSeconds,
    maxLifetimeSeconds,
  };
}

// ---------------------------------------------------------------- Dockerfile

function renderDockerfile(o: ResolvedOptions): string {
  return `# syntax=docker/dockerfile:1
# Carbon — container do AgentCore Runtime (gerado pelo Carbon; revise antes de usar).
# Contrato do AgentCore: linux/arm64, HTTP na porta 8080, POST /invocations, GET /ping.
# Build (na raiz do repositório do Carbon, depois de \`npm run build:worker\`):
#   docker buildx build --platform linux/arm64 -f <esta pasta>/Dockerfile .
FROM --platform=linux/arm64 node:22-bookworm-slim

RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

# Versão fixa do Claude Code: a imagem precisa ser reproduzível.
ARG CLAUDE_CODE_VERSION=${o.claudeCodeVersion}
RUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}" \\
  && npm cache clean --force

# Entrypoint do Carbon (um único arquivo, sem node_modules). Fica com dono root: só leitura para o app.
COPY dist/agentcore.mjs /opt/carbon/agentcore.mjs

ENV NODE_ENV=production \\
    PORT=8080 \\
    CARBON_WORKER_DIR=/home/node/work \\
    CARBON_WORKER_GRACE_SECONDS=60

# Usuário não-root (o usuário "node" já existe na imagem oficial).
RUN mkdir -p /home/node/work && chown node:node /home/node/work
USER node
WORKDIR /home/node

EXPOSE 8080
CMD ["node", "/opt/carbon/agentcore.mjs"]
`;
}

// ---------------------------------------------------------------- IAM

function renderIamPolicy(o: ResolvedOptions): string {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EcrPullCarbonImage",
        Effect: "Allow",
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: `arn:aws:ecr:${o.region}:<ACCOUNT_ID>:repository/${o.repositoryName}`,
      },
      {
        Sid: "EcrAuthToken",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: "*",
      },
      {
        Sid: "RuntimeLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        Resource: `arn:aws:logs:${o.region}:<ACCOUNT_ID>:log-group:/aws/bedrock-agentcore/runtimes/*`,
      },
      {
        Sid: "RuntimeLogGroupsList",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: `arn:aws:logs:${o.region}:<ACCOUNT_ID>:log-group:*`,
      },
    ],
  };
  return `${JSON.stringify(policy, null, 2)}\n`;
}

// ---------------------------------------------------------------- deploy.sh

function renderDeployScript(o: ResolvedOptions): string {
  return `#!/usr/bin/env bash
# Carbon — deploy do container no AWS Bedrock AgentCore Runtime (gerado pelo Carbon).
#
# EXPERIMENTAL — não validado em conta AWS real. Leia o README.md desta pasta antes de rodar.
# Este script NÃO roda sozinho: execute à mão, na raiz do repositório do Carbon, depois de
# \`npm run build:worker\` (gera dist/agentcore.mjs).
#
# Pré-requisitos: aws CLI v2 com bedrock-agentcore-control, docker buildx, jq.
#
# Variáveis (ambiente):
#   ACCOUNT_ID      obrigatório  conta AWS (12 dígitos)
#   ROLE_ARN        obrigatório  role de execução com iam-policy.json (veja README)
#   REGION          opcional     padrão ${o.region}
#   RUNTIME_NAME    opcional     padrão ${o.runtimeName}
#   REPOSITORY      opcional     padrão ${o.repositoryName} (repositório ECR)
#   IMAGE_TAG       opcional     padrão: hash curto do git HEAD
#   CARBON_PANEL_URL opcional    padrão ${o.panelUrl}
#   IDLE_TIMEOUT_SECONDS opcional padrão ${o.idleTimeoutSeconds}
#   MAX_LIFETIME_SECONDS opcional padrão ${o.maxLifetimeSeconds} (teto do AgentCore: 28800 = 8h)
#   CLAUDE_CODE_USE_BEDROCK opcional "1" para o Claude Code usar modelos do Bedrock (sem chave)
#   ANTHROPIC_API_KEY opcional   chave da API (fica visível na configuração do runtime — prefira Bedrock)
#   CARBON_GIT_TOKEN  opcional   token git para clone/push (mesma ressalva acima)
set -euo pipefail

REGION="\${REGION:-${o.region}}"
ACCOUNT_ID="\${ACCOUNT_ID:?defina ACCOUNT_ID (conta AWS de 12 dígitos)}"
ROLE_ARN="\${ROLE_ARN:?defina ROLE_ARN (role de execução com iam-policy.json)}"
RUNTIME_NAME="\${RUNTIME_NAME:-${o.runtimeName}}"
REPOSITORY="\${REPOSITORY:-${o.repositoryName}}"
CARBON_PANEL_URL="\${CARBON_PANEL_URL:-${o.panelUrl}}"
IDLE_TIMEOUT_SECONDS="\${IDLE_TIMEOUT_SECONDS:-${o.idleTimeoutSeconds}}"
MAX_LIFETIME_SECONDS="\${MAX_LIFETIME_SECONDS:-${o.maxLifetimeSeconds}}"
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CONTEXT_DIR="\${CONTEXT_DIR:-$PWD}"

fail() { echo "deploy.sh: $*" >&2; exit 1; }

[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail "ACCOUNT_ID precisa ter 12 dígitos"
[[ "$RUNTIME_NAME" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ ]] || fail "RUNTIME_NAME inválido (letras, dígitos e _)"
if ! [[ "$MAX_LIFETIME_SECONDS" =~ ^[0-9]+$ ]] || (( MAX_LIFETIME_SECONDS > 28800 )); then
  fail "MAX_LIFETIME_SECONDS precisa ser um inteiro <= 28800"
fi
[[ "$IDLE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "IDLE_TIMEOUT_SECONDS precisa ser um inteiro"
[[ -f "$CONTEXT_DIR/dist/agentcore.mjs" ]] || fail "dist/agentcore.mjs não encontrado em $CONTEXT_DIR — rode \\\`npm run build:worker\\\` na raiz do Carbon"
for bin in aws docker jq; do
  command -v "$bin" >/dev/null 2>&1 || fail "$bin não encontrado no PATH"
done

IMAGE_TAG="\${IMAGE_TAG:-$(git -C "$CONTEXT_DIR" rev-parse --short HEAD 2>/dev/null || echo manual)}"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
IMAGE_URI="$REGISTRY/$REPOSITORY:$IMAGE_TAG"

echo "==> ECR: $REPOSITORY ($REGION)"
if ! aws ecr describe-repositories --region "$REGION" --repository-names "$REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository --region "$REGION" --repository-name "$REPOSITORY" \\
    --image-scanning-configuration scanOnPush=true >/dev/null
fi
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo "==> build linux/arm64 e push: $IMAGE_URI"
docker buildx build --platform linux/arm64 \\
  -f "$SCRIPT_DIR/Dockerfile" \\
  -t "$IMAGE_URI" \\
  --push "$CONTEXT_DIR"

# Variáveis de ambiente do runtime. Valores vazios ficam de fora.
ENV_JSON="$(jq -n \\
  --arg panel "$CARBON_PANEL_URL" \\
  --arg bedrock "\${CLAUDE_CODE_USE_BEDROCK:-}" \\
  --arg region "$REGION" \\
  --arg apiKey "\${ANTHROPIC_API_KEY:-}" \\
  --arg gitToken "\${CARBON_GIT_TOKEN:-}" \\
  '{CARBON_PANEL_URL: $panel, AWS_REGION: $region}
   + (if $bedrock != "" then {CLAUDE_CODE_USE_BEDROCK: $bedrock} else {} end)
   + (if $apiKey != "" then {ANTHROPIC_API_KEY: $apiKey} else {} end)
   + (if $gitToken != "" then {CARBON_GIT_TOKEN: $gitToken} else {} end)')"
ARTIFACT_JSON="$(jq -n --arg uri "$IMAGE_URI" '{containerConfiguration: {containerUri: $uri}}')"
LIFECYCLE_JSON="$(jq -n --argjson idle "$IDLE_TIMEOUT_SECONDS" --argjson max "$MAX_LIFETIME_SECONDS" \\
  '{idleRuntimeSessionTimeout: $idle, maxLifetime: $max}')"
NETWORK_JSON='{"networkMode":"PUBLIC"}'

RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \\
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text)"

if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == "None" ]]; then
  echo "==> criando runtime $RUNTIME_NAME"
  RESULT="$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \\
    --agent-runtime-name "$RUNTIME_NAME" \\
    --agent-runtime-artifact "$ARTIFACT_JSON" \\
    --role-arn "$ROLE_ARN" \\
    --network-configuration "$NETWORK_JSON" \\
    --lifecycle-configuration "$LIFECYCLE_JSON" \\
    --environment-variables "$ENV_JSON" \\
    --output json)"
else
  echo "==> atualizando runtime $RUNTIME_NAME ($RUNTIME_ID)"
  RESULT="$(aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \\
    --agent-runtime-id "$RUNTIME_ID" \\
    --agent-runtime-artifact "$ARTIFACT_JSON" \\
    --role-arn "$ROLE_ARN" \\
    --network-configuration "$NETWORK_JSON" \\
    --lifecycle-configuration "$LIFECYCLE_JSON" \\
    --environment-variables "$ENV_JSON" \\
    --output json)"
fi

RUNTIME_ARN="$(jq -r '.agentRuntimeArn // empty' <<<"$RESULT")"
[[ -n "$RUNTIME_ARN" ]] || fail "a AWS não devolveu agentRuntimeArn; resposta: $(jq -c 'del(.environmentVariables)' <<<"$RESULT")"

echo
echo "Pronto. Cole este ARN em Carbon → Configurações → AgentCore (região $REGION):"
echo "  $RUNTIME_ARN"
`;
}

// ---------------------------------------------------------------- README

function renderReadme(o: ResolvedOptions): string {
  return `# Carbon no AWS Bedrock AgentCore Runtime

> [!WARNING]
> **Experimental — não validado em conta AWS real.**
> Este kit foi gerado e testado só localmente (entrypoint rodando na máquina, SDK da AWS mockado).
> Nada foi implantado na AWS pelo Carbon. Antes de usar em produção, valide com um runtime de teste:
>
> 1. **Egress de internet** no modo de rede \`PUBLIC\`: o container precisa alcançar o painel
>    (\`CARBON_PANEL_URL\`), o remoto git (clone/push) e a API do modelo. Confirme saída HTTPS.
> 2. **Login do Claude Code dentro do container** (não há navegador): use \`CLAUDE_CODE_USE_BEDROCK=1\`
>    (modelos do Bedrock pela role, sem chave) **ou** \`ANTHROPIC_API_KEY\`. Custo e termos de uso
>    de cada opção precisam ser validados pela sua empresa.
> 3. **Limites do stream do Invoke**: a resposta de streaming fecha em 60 min e o Invoke síncrono em
>    15 min. O Carbon não depende dela — o container responde 202 e conversa com o painel por HTTPS
>    de saída (mesmo protocolo dos workers de pool).
> 4. **Teto de 8h por sessão** do AgentCore (\`maxLifetime\` ≤ 28800 s). Tarefas mais longas são
>    encerradas pela AWS; ajuste o limite de minutos da tarefa no Carbon abaixo disso.
> 5. **Parâmetros da CLI** \`bedrock-agentcore-control\` (\`create-agent-runtime\`/\`update-agent-runtime\`)
>    seguem a documentação pública e podem mudar; confira com \`aws bedrock-agentcore-control help\`.

## O que tem nesta pasta

| Arquivo | Para quê |
|---|---|
| \`Dockerfile\` | Imagem \`linux/arm64\` (exigência do AgentCore): Node 22, git, Claude Code ${o.claudeCodeVersion} fixo, usuário não-root, porta 8080 |
| \`iam-policy.json\` | Política **mínima** da role de execução: pull da imagem no ECR e logs no CloudWatch. **Revise antes de aplicar** |
| \`deploy.sh\` | Build arm64 → push no ECR → cria ou atualiza o runtime → imprime o ARN |

## Como funciona

1. Ao criar uma tarefa com "Onde rodar: AgentCore", o painel chama \`InvokeAgentRuntime\` com
   \`{taskId, panelUrl, taskToken}\` (token de **uso único** por tarefa).
2. O container responde \`202\` em menos de 1 s e, em segundo plano, pega a tarefa no painel
   (\`POST /api/worker/agentcore/claim\` com o token), roda o Claude Code e envia eventos, heartbeat e
   resultado pelo mesmo protocolo dos workers.
3. \`GET /ping\` devolve \`HealthyBusy\` enquanto a tarefa roda, para a sessão não ser encerrada por
   ociosidade, e \`Healthy\` quando termina.
4. Um container atende **uma tarefa por vez**: outra tarefa recebe \`409\`; a mesma tarefa de novo
   recebe \`202\` (idempotente).

## Passo a passo

1. **Role de execução** (IAM → Roles → Create role → Custom trust policy):

   \`\`\`json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
       "Action": "sts:AssumeRole",
       "Condition": { "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" } }
     }]
   }
   \`\`\`

   Anexe \`iam-policy.json\` trocando \`<ACCOUNT_ID>\` pela sua conta. Se usar
   \`CLAUDE_CODE_USE_BEDROCK=1\`, acrescente \`bedrock:InvokeModel\` e
   \`bedrock:InvokeModelWithResponseStream\` **só** nos modelos que vai usar.

2. **Build do entrypoint** na raiz do Carbon: \`npm run build:worker\` (gera \`dist/agentcore.mjs\`).

3. **Deploy** (na raiz do Carbon):

   \`\`\`bash
   ACCOUNT_ID=<ACCOUNT_ID> \\
   ROLE_ARN=arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME> \\
   CARBON_PANEL_URL=${o.panelUrl} \\
   CLAUDE_CODE_USE_BEDROCK=1 \\
   bash <esta pasta>/deploy.sh
   \`\`\`

   Região padrão: \`${o.region}\` (\`REGION=...\` para mudar). Sessão: ociosidade
   ${o.idleTimeoutSeconds} s, vida máxima ${o.maxLifetimeSeconds} s.

4. **Cole o ARN** impresso no fim em Carbon → Configurações → AgentCore.

## Segurança

- O painel precisa estar acessível pela internet **só** em \`/api/worker/*\` e com TLS
  (Cloudflare Tunnel, Tailscale Funnel ou proxy reverso com HTTPS). Nunca HTTP puro.
- \`CARBON_PANEL_URL\` no runtime faz o container recusar invocações para qualquer outro painel.
- Credenciais AWS ficam na cadeia padrão do SDK no host do painel; nada de chave AWS no Carbon.
- \`ANTHROPIC_API_KEY\` e \`CARBON_GIT_TOKEN\` passados como variáveis de ambiente ficam visíveis
  para quem tem \`GetAgentRuntime\` na conta. Prefira Bedrock para o modelo e restrinja quem lê a
  configuração do runtime. Nunca comite esses valores.
- Logs do agente podem conter trechos de código e segredos do repositório: trate os logs do
  CloudWatch com a mesma política de acesso do repositório.
`;
}

/** Renders the AgentCore kit. Pure: same options → same files. Throws InvalidKitOptions. */
export function renderAgentCore(opts: AgentCoreKitOptions = {}): KitFiles {
  const o = resolveKitOptions(opts);
  return {
    Dockerfile: renderDockerfile(o),
    "iam-policy.json": renderIamPolicy(o),
    "deploy.sh": renderDeployScript(o),
    "README.md": renderReadme(o),
  };
}
