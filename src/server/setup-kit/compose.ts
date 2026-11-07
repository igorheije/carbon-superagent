import { assertKitOptions, CONTAINER_WORK_DIR, toYaml, type KitFiles, type WorkerKitOptions } from "./worker-kit";

/**
 * Docker Compose kit: `docker-compose.yml`, `.env` (the only file with the worker token) and a
 * pt-BR `README.md`. Pure: same options → same files. Throws SetupKitError on invalid options.
 */

/** Worker waits up to 120s (CARBON_WORKER_GRACE_SECONDS default) — Compose must wait longer before SIGKILL. */
export const COMPOSE_STOP_GRACE = "150s";

/** `500m` → `0.5`, `2` → `2` (Compose `cpus`). */
export function composeCpus(cpu: string): string {
  if (!cpu.endsWith("m")) return cpu;
  return String(Number(cpu.slice(0, -1)) / 1000);
}

/** `4Gi` → `4g`, `512Mi` → `512m` (Compose memory, binary units). */
export function composeMemory(memory: string): string {
  return memory.endsWith("Gi") ? `${memory.slice(0, -2)}g` : `${memory.slice(0, -2)}m`;
}

function renderComposeYaml(opts: WorkerKitOptions): string {
  const volume = `carbon-worker-${opts.workerName}`;
  return toYaml(
    {
      name: `carbon-${opts.workerName}`,
      services: {
        worker: {
          image: opts.image,
          env_file: ".env",
          restart: "unless-stopped",
          stop_grace_period: COMPOSE_STOP_GRACE,
          environment: { CARBON_WORKER_DIR: CONTAINER_WORK_DIR },
          volumes: [`${volume}:${CONTAINER_WORK_DIR}`],
          deploy: {
            replicas: opts.replicas,
            resources: { limits: { cpus: composeCpus(opts.cpu), memory: composeMemory(opts.memory) } },
          },
          logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
        },
      },
      volumes: { [volume]: {} },
    },
    [
      `Carbon worker "${opts.workerName}" — gerado pelo painel.`,
      "Sem portas expostas: o worker só faz conexões de saída para o painel, o modelo e o git.",
      "Escalar: docker compose up -d --scale worker=N",
    ],
  );
}

function renderEnv(opts: WorkerKitOptions): string {
  return [
    `# Carbon worker "${opts.workerName}". NÃO versione nem compartilhe este arquivo: ele contém o token da máquina.`,
    "# Se o token vazar, revogue a máquina no painel (Configurações → Máquinas) e gere um kit novo.",
    `CARBON_PANEL_URL=${opts.panelUrl}`,
    ...(opts.panelFingerprint ? ["# Certificado do painel fixado (conexão direta por IP): outro certificado é recusado antes do token sair.", `CARBON_PANEL_FINGERPRINT=${opts.panelFingerprint}`] : []),
    `CARBON_WORKER_TOKEN=${opts.token}`,
    `CARBON_WORKER_PARALLEL=${opts.parallel}`,
    `CARBON_WORKER_EXECUTORS=${opts.executors.join(",")}`,
    "",
    "# Credenciais do modelo — descomente e preencha. Claude Code: UMA das duas linhas abaixo",
    "# (chave da API da Anthropic, ou token gerado com `claude setup-token`).",
    "# ANTHROPIC_API_KEY=",
    "# CLAUDE_CODE_OAUTH_TOKEN=",
    "# Codex (só se a imagem foi gerada com WITH_CODEX=true):",
    "# OPENAI_API_KEY=",
    "",
    "# Git: token com permissão de clone e push nos repositórios (usado só via https).",
    "# CARBON_GIT_TOKEN=",
    "# Hosts que podem receber o token (vírgula). Sem esta linha o token nunca é enviado.",
    "# CARBON_GIT_HOSTS=github.com",
    "",
  ].join("\n");
}

/**
 * The worker image is not published anywhere: it is built from the Carbon repo (same version as
 * the panel). A bare name (`carbon-worker:<v>`) only exists on the machine that built it; with a
 * registry in the name, the step is build + push so every machine can pull it.
 */
export function composeImageStep(image: string): string {
  const build = `docker build -f deploy/worker/Dockerfile -t ${image} .`;
  if (image.includes("/")) {
    return `Publique a imagem \`${image}\` (ela não vem pronta). No repositório do Carbon, na mesma versão do painel:
   \`${build} && docker push ${image}\``;
  }
  return `Gere a imagem \`${image}\` (ela não é publicada em nenhum registry). No repositório do Carbon, na mesma versão do painel:
   \`${build}\`
   Mais de uma máquina? Envie para um registry — \`docker tag ${image} <registry>/${image} && docker push <registry>/${image}\` —
   e troque \`image:\` no \`docker-compose.yml\` (ou gere o kit já com a imagem: campo "Imagem" em Configurações → Máquinas
   ou \`carbon worker init --image <registry>/${image}\`).`;
}

function renderReadme(opts: WorkerKitOptions): string {
  return `# Carbon worker — ${opts.workerName} (Docker Compose)

Este kit sobe ${opts.replicas} worker(s) do Carbon que pegam tarefas do painel em \`${opts.panelUrl}\`.
Cada worker roda até ${opts.parallel} tarefa(s) ao mesmo tempo com: ${opts.executors.join(", ")}.

## Antes de subir

1. Abra o \`.env\` e preencha as credenciais do modelo e o \`CARBON_GIT_TOKEN\` (descomente as linhas).
2. ${composeImageStep(opts.image)}
3. O \`.env\` contém o token da máquina: não versione e não compartilhe.

## Subir

\`\`\`sh
docker compose up -d
\`\`\`

## Escalar

\`\`\`sh
docker compose up -d --scale worker=N
\`\`\`

## Logs

\`\`\`sh
docker compose logs -f worker
\`\`\`

## Parar

\`docker compose down\` envia SIGTERM: o worker para de pegar tarefas e espera as atuais terminarem
(até ${COMPOSE_STOP_GRACE}). Para apagar também o volume de trabalho: \`docker compose down -v\`.

## Revogar o token

1. No painel, Configurações → Máquinas → **Revogar** em "${opts.workerName}". O worker para de receber tarefas na hora.
2. Nesta máquina: \`docker compose down -v\` e apague o \`.env\`.
3. Para voltar a usar, gere um kit novo (token novo) no painel.
`;
}

export function renderCompose(input: WorkerKitOptions): KitFiles {
  const opts = assertKitOptions(input);
  return {
    "docker-compose.yml": renderComposeYaml(opts),
    ".env": renderEnv(opts),
    "README.md": renderReadme(opts),
  };
}
