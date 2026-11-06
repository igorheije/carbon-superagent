import { assertKitOptions, CONTAINER_WORK_DIR, toYaml, type KitFiles, type WorkerKitOptions, type YamlValue } from "./worker-kit";

/**
 * Kubernetes kit (kustomize): namespace, secret (the only file with the worker token),
 * deployment, egress-only network policy, kustomization and a pt-BR README.
 * Pure: same options → same files. Throws SetupKitError on invalid options.
 */

export const K8S_TERMINATION_GRACE_SECONDS = 600;
/** Worker-side wait on SIGTERM; leaves 60s of the pod grace for cancel + final report. */
export const K8S_WORKER_GRACE_SECONDS = 540;
const RESOURCE_NAME = "carbon-worker";
/** Fixed UID/GID of the `carbon` user in deploy/worker/Dockerfile. */
const CARBON_UID = 10001;

const namespaceOf = (opts: WorkerKitOptions): string => `carbon-${opts.workerName}`;

function labelsOf(opts: WorkerKitOptions): Record<string, string> {
  return { "app.kubernetes.io/name": RESOURCE_NAME, "app.kubernetes.io/instance": opts.workerName };
}

function metadata(opts: WorkerKitOptions, name: string): YamlValue {
  return { name, namespace: namespaceOf(opts), labels: labelsOf(opts) };
}

function renderNamespace(opts: WorkerKitOptions): string {
  return toYaml({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespaceOf(opts), labels: labelsOf(opts) } });
}

function renderSecret(opts: WorkerKitOptions): string {
  const yaml = toYaml(
    { apiVersion: "v1", kind: "Secret", metadata: metadata(opts, RESOURCE_NAME), type: "Opaque", stringData: { CARBON_WORKER_TOKEN: opts.token } },
    ["Contém o token da máquina: NÃO versione. Prefira um gerenciador de segredos (Sealed Secrets, External Secrets)."],
  );
  return [
    yaml.trimEnd(),
    "  # Credenciais do modelo — descomente e preencha. Claude Code: UMA das duas",
    "  # (chave da API da Anthropic, ou token gerado com `claude setup-token`).",
    '  # ANTHROPIC_API_KEY: ""',
    '  # CLAUDE_CODE_OAUTH_TOKEN: ""',
    "  # Codex (só se a imagem foi gerada com WITH_CODEX=true):",
    '  # OPENAI_API_KEY: ""',
    "  # Git: token com permissão de clone e push (https).",
    '  # CARBON_GIT_TOKEN: ""',
    "  # Hosts que podem receber o token (vírgula). Sem esta linha o token nunca é enviado.",
    '  # CARBON_GIT_HOSTS: "github.com"',
    "",
  ].join("\n");
}

function containerOf(opts: WorkerKitOptions): YamlValue {
  const env: Record<string, string> = {
    CARBON_PANEL_URL: opts.panelUrl,
    CARBON_WORKER_PARALLEL: String(opts.parallel),
    CARBON_WORKER_EXECUTORS: opts.executors.join(","),
    CARBON_WORKER_DIR: CONTAINER_WORK_DIR,
    CARBON_WORKER_GRACE_SECONDS: String(K8S_WORKER_GRACE_SECONDS),
    HOME: "/home/carbon",
  };
  return {
    name: "worker",
    image: opts.image,
    imagePullPolicy: "IfNotPresent",
    envFrom: [{ secretRef: { name: RESOURCE_NAME } }],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
    resources: {
      requests: { cpu: opts.cpu, memory: opts.memory },
      limits: { cpu: opts.cpu, memory: opts.memory },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      // Writable paths (/home/carbon, /tmp) are emptyDir volumes, so the image itself stays read-only.
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
    volumeMounts: [
      { name: "home", mountPath: "/home/carbon" },
      { name: "tmp", mountPath: "/tmp" },
    ],
  };
}

function renderDeployment(opts: WorkerKitOptions): string {
  return toYaml({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata(opts, RESOURCE_NAME),
    spec: {
      replicas: opts.replicas,
      selector: { matchLabels: labelsOf(opts) },
      template: {
        metadata: { labels: labelsOf(opts) },
        spec: {
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: K8S_TERMINATION_GRACE_SECONDS,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: CARBON_UID,
            runAsGroup: CARBON_UID,
            fsGroup: CARBON_UID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [containerOf(opts)],
          volumes: [
            { name: "home", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
          ],
        },
      },
    },
  });
}

function renderNetworkPolicy(opts: WorkerKitOptions): string {
  return toYaml(
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata(opts, RESOURCE_NAME),
      spec: {
        podSelector: { matchLabels: labelsOf(opts) },
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [{}],
      },
    },
    [
      "Nenhuma entrada; saída liberada (painel, API do modelo, git, DNS).",
      "Para restringir a saída, troque `egress` por regras com ipBlock/porta do seu ambiente.",
    ],
  );
}

function renderKustomization(opts: WorkerKitOptions): string {
  return toYaml({
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: namespaceOf(opts),
    resources: ["namespace.yaml", "secret.yaml", "deployment.yaml", "networkpolicy.yaml"],
  });
}

/**
 * The worker image is not published anywhere: it is built from the Carbon repo (same version as
 * the panel) and pushed to a registry the cluster can pull from.
 */
export function k8sImageStep(image: string): string {
  const buildx = (tag: string) => `docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 -t ${tag} --push .`;
  if (image.includes("/")) {
    return `Publique a imagem \`${image}\` (ela não vem pronta). No repositório do Carbon, na mesma versão do painel:
   \`${buildx(image)}\``;
  }
  return `A imagem \`${image}\` não é publicada em nenhum registry, e o cluster precisa baixá-la. No repositório
   do Carbon, na mesma versão do painel, publique num registry seu:
   \`${buildx(`<registry>/${image}`)}\`
   e troque \`image:\` no \`deployment.yaml\` (ou gere o kit já com a imagem: campo "Imagem" em Configurações → Máquinas
   ou \`carbon worker init --image <registry>/${image}\`).`;
}

function renderReadme(opts: WorkerKitOptions): string {
  const ns = namespaceOf(opts);
  return `# Carbon worker — ${opts.workerName} (Kubernetes)

Este kit cria o namespace \`${ns}\` com ${opts.replicas} réplica(s) do worker do Carbon, que pegam
tarefas do painel em \`${opts.panelUrl}\`. Cada réplica roda até ${opts.parallel} tarefa(s) ao mesmo
tempo com: ${opts.executors.join(", ")}. Recursos por réplica: ${opts.cpu} CPU, ${opts.memory} de memória.

## Antes de aplicar

1. Abra o \`secret.yaml\` e preencha as credenciais do modelo e o \`CARBON_GIT_TOKEN\` (descomente as linhas).
2. ${k8sImageStep(opts.image)}
3. O \`secret.yaml\` contém o token da máquina: não versione. Em produção, prefira Sealed Secrets ou External Secrets.

## Aplicar

\`\`\`sh
kubectl apply -k .
\`\`\`

## Escalar

\`\`\`sh
kubectl -n ${ns} scale deployment/${RESOURCE_NAME} --replicas=N
\`\`\`

## Logs

\`\`\`sh
kubectl -n ${ns} logs -f -l app.kubernetes.io/name=${RESOURCE_NAME} --max-log-requests=20
\`\`\`

## Parar e atualizar

Ao remover um pod, o worker para de pegar tarefas e espera as atuais terminarem por até
${K8S_WORKER_GRACE_SECONDS}s (\`terminationGracePeriodSeconds: ${K8S_TERMINATION_GRACE_SECONDS}\`).

## Revogar o token

1. No painel, Configurações → Máquinas → **Revogar** em "${opts.workerName}". O worker para de receber tarefas na hora.
2. No cluster: \`kubectl delete -k .\` (apaga o namespace \`${ns}\` e o secret).
3. Para voltar a usar, gere um kit novo (token novo) no painel.
`;
}

export function renderK8s(input: WorkerKitOptions): KitFiles {
  const opts = assertKitOptions(input);
  return {
    "namespace.yaml": renderNamespace(opts),
    "secret.yaml": renderSecret(opts),
    "deployment.yaml": renderDeployment(opts),
    "networkpolicy.yaml": renderNetworkPolicy(opts),
    "kustomization.yaml": renderKustomization(opts),
    "README.md": renderReadme(opts),
  };
}
