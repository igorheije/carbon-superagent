import "server-only";
import { z } from "zod";
import type { DirectJoinInfo } from "@/server/direct-join";
import { EXECUTORS } from "@/server/repo/settings";
import { renderKitArchive } from "@/server/setup-kit/archive";
import { renderCompose } from "@/server/setup-kit/compose";
import { renderK8s } from "@/server/setup-kit/k8s";
import { MAX_PARALLEL, MAX_REPLICAS, slugifyWorkerName, validateKitOptions, type KitFiles, type WorkerKitOptions } from "@/server/setup-kit/worker-kit";
import { version } from "../../../../../../package.json";

/** Configurações → Máquinas → "Adicionar máquina": request body and kit rendering (SET-04). */

export const KIT_TARGETS = ["compose", "k8s"] as const;
export type KitTarget = (typeof KIT_TARGETS)[number];

/** Image used when the admin does not name one: built locally from deploy/worker/Dockerfile. */
export const DEFAULT_WORKER_IMAGE = `carbon-worker:${version}`;
const DEFAULT_CPU = "2";
const DEFAULT_MEMORY = "4Gi";
/** Syntactically valid stand-in token, used only to validate options before a worker is created. */
const PROBE_TOKEN = `cwk_${"A".repeat(43)}`;

/** How the new machine reaches this panel: its IP (LAN or public, pinned certificate) or a public URL. */
export const CONNECTIONS = ["direct", "public"] as const;
export type Connection = (typeof CONNECTIONS)[number];

/** IPv4 or a DNS name, no port/scheme/path (the port comes from the worker listener). */
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** All-numeric dotted input must be a real IPv4 (1.2.3.999 is not a host name). */
const isHost = (v: string): boolean => (/^[\d.]+$/.test(v) ? IPV4.test(v) : DNS_NAME.test(v));

export const newMachineSchema = z.object({
  name: z.string().trim().min(1, "informe o nome da máquina").max(80),
  connection: z.enum(CONNECTIONS).default("public"),
  /** connection "direct": the address of THIS computer the machine will use (LAN IP or public IP). */
  address: z
    .string()
    .trim()
    .max(253)
    .optional()
    .refine((v) => v === undefined || v === "" || isHost(v), "endereço inválido: use só o IP (ex.: 192.168.0.12) ou um nome, sem porta"),
  target: z.enum(KIT_TARGETS),
  replicas: z.number().int().min(1).max(MAX_REPLICAS).default(1),
  parallel: z.number().int().min(1).max(MAX_PARALLEL).default(1),
  executors: z.array(z.enum(EXECUTORS)).min(1, "escolha ao menos um executor").default(["claude"]),
  image: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((value) => value || undefined),
});

export type NewMachine = z.infer<typeof newMachineSchema>;

/** Folder inside the archive (and the archive name without extension). */
export const kitFolderOf = (slug: string): string => `carbon-worker-${slug}`;

export function kitOptionsOf(input: NewMachine, endpoint: PanelEndpoint, token: string): WorkerKitOptions {
  return {
    workerName: slugifyWorkerName(input.name),
    panelUrl: endpoint.panelUrl,
    panelFingerprint: endpoint.fingerprint,
    token,
    image: input.image ?? DEFAULT_WORKER_IMAGE,
    replicas: input.replicas,
    parallel: input.parallel,
    executors: input.executors,
    cpu: DEFAULT_CPU,
    memory: DEFAULT_MEMORY,
  };
}

/** Problems with the options, checked before the worker (and its token) exists. */
export function kitProblems(input: NewMachine, endpoint: PanelEndpoint): readonly string[] {
  return validateKitOptions(kitOptionsOf(input, endpoint, PROBE_TOKEN));
}

export interface RenderedKit {
  readonly filename: string;
  readonly folder: string;
  readonly archive: Buffer;
}

function inFolder(files: KitFiles, folder: string): KitFiles {
  return Object.fromEntries(Object.entries(files).map(([file, body]) => [`${folder}/${file}`, body]));
}

export function renderWorkerKit(target: KitTarget, options: WorkerKitOptions): RenderedKit {
  const files = target === "compose" ? renderCompose(options) : renderK8s(options);
  const folder = kitFolderOf(options.workerName);
  return { filename: `${folder}.tar.gz`, folder, archive: renderKitArchive(inFolder(files, folder)) };
}

export const NEEDS_ADDRESS = "escolha o endereço deste computador que a máquina vai usar";

export interface PanelEndpoint {
  readonly panelUrl: string;
  readonly fingerprint: string | null;
}

/**
 * Where the kit points the worker. "direct": https://<address>:<listener port> with the listener's
 * certificate pinned (no domain, tunnel or public URL). "public": the configured panel URL.
 * Returns the problem as a string when the chosen connection is not possible right now.
 */
export function panelEndpointOf(input: Pick<NewMachine, "connection" | "address">, panelPublicUrl: string, direct: DirectJoinInfo): PanelEndpoint | string {
  if (input.connection === "public") return panelPublicUrl ? { panelUrl: panelPublicUrl, fingerprint: null } : MISSING_PANEL_URL;
  if (!direct.available) return direct.reason;
  if (!input.address) return NEEDS_ADDRESS;
  return { panelUrl: `https://${input.address}:${direct.port}`, fingerprint: direct.fingerprint };
}

export const MISSING_PANEL_URL = "sem URL pública do painel configurada: escolha \"IP deste computador\" ou defina a URL em Configurações → Execução";
