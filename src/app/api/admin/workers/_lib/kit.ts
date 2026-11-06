import "server-only";
import { z } from "zod";
import { EXECUTORS } from "@/server/repo/settings";
import { renderKitArchive } from "@/server/setup-kit/archive";
import { renderCompose } from "@/server/setup-kit/compose";
import { renderK8s } from "@/server/setup-kit/k8s";
import { MAX_PARALLEL, MAX_REPLICAS, slugifyWorkerName, validateKitOptions, type KitFiles, type WorkerKitOptions } from "@/server/setup-kit/worker-kit";
import { version } from "../../../../../../package.json";

/** Configurações → Máquinas → "Adicionar máquina": request body and kit rendering (SET-04). */

export const KIT_TARGETS = ["compose", "k8s"] as const;
export type KitTarget = (typeof KIT_TARGETS)[number];
/** "direct": no kit — the other computer runs `carbon join <ip>:<porta>` (src/server/direct-join.ts). */
export const MACHINE_TARGETS = [...KIT_TARGETS, "direct"] as const;
export type MachineTarget = (typeof MACHINE_TARGETS)[number];

/** Image used when the admin does not name one: built locally from deploy/worker/Dockerfile. */
export const DEFAULT_WORKER_IMAGE = `carbon-worker:${version}`;
const DEFAULT_CPU = "2";
const DEFAULT_MEMORY = "4Gi";
/** Syntactically valid stand-in token, used only to validate options before a worker is created. */
const PROBE_TOKEN = `cwk_${"A".repeat(43)}`;

export const newMachineSchema = z.object({
  name: z.string().trim().min(1, "informe o nome da máquina").max(80),
  target: z.enum(MACHINE_TARGETS),
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

export function kitOptionsOf(input: NewMachine, panelUrl: string, token: string): WorkerKitOptions {
  return {
    workerName: slugifyWorkerName(input.name),
    panelUrl,
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
export function kitProblems(input: NewMachine, panelUrl: string): readonly string[] {
  return validateKitOptions(kitOptionsOf(input, panelUrl, PROBE_TOKEN));
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

export const MISSING_PANEL_URL = "defina a URL pública do painel em Configurações → Execução antes de adicionar máquinas";
