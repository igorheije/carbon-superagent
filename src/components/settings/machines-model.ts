/** Client-side model of Configurações → Máquinas (mirrors src/app/api/admin/workers/_lib/fleet.ts). */

export type MachineStatus = "busy" | "idle" | "paused" | "pending" | "offline" | "revoked";
export type MachineAvailability = "active" | "paused" | "pending";
export type MachineTarget = "compose" | "k8s";
export type MachineExecutor = "claude" | "codex";

export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly kind: "pool" | "agentcore";
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
  readonly version: string | null;
  readonly capabilities: { readonly maxParallel?: number; readonly executors?: readonly string[] };
  readonly availability: MachineAvailability;
  readonly joinedVia: "manual" | "join";
  readonly hostname: string | null;
  readonly status: MachineStatus;
  readonly currentTasks: readonly { readonly id: string; readonly key: string }[];
}

export interface CreatedMachine {
  readonly worker: Machine;
  readonly token: string;
  readonly kitBase64: string;
  readonly filename: string;
  readonly folder: string;
  readonly target: MachineTarget;
}

export const STATUS_LABEL: Readonly<Record<MachineStatus, string>> = {
  busy: "ocupada",
  idle: "ociosa",
  paused: "pausada",
  pending: "aguardando aprovação",
  offline: "offline",
  revoked: "removida",
};

export const STATUS_DOT: Readonly<Record<MachineStatus, string>> = {
  busy: "bg-warn animate-pulse",
  idle: "bg-ok",
  paused: "bg-subtle ring-2 ring-warn/50",
  pending: "bg-accent animate-pulse",
  offline: "bg-subtle",
  revoked: "bg-danger",
};

export const TARGET_LABEL: Readonly<Record<MachineTarget, string>> = {
  compose: "Docker Compose",
  k8s: "Kubernetes",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "agora", "há 5 min", "há 3 h", "há 2 dias"; "nunca" when the machine never connected. */
export function relativeTime(at: number | null, now: number): string {
  if (at === null) return "nunca";
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return "agora";
  if (diff < HOUR) return `há ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`;
  const days = Math.floor(diff / DAY);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

/** Exact commands shown after the kit is generated. */
export function nextCommands(created: Pick<CreatedMachine, "filename" | "folder" | "target">): readonly string[] {
  const start = created.target === "compose" ? "docker compose up -d" : "kubectl apply -k .";
  return [`tar xzf ${created.filename}`, `cd ${created.folder}`, start];
}

/** Saves a base64 payload as a file through a temporary object URL. */
export function downloadBase64(base64: string, filename: string, type = "application/gzip"): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** "1/2" slots in use, or just the task count when the node never reported its parallelism. */
export function slotsLabel(machine: Pick<Machine, "currentTasks" | "capabilities">): string {
  const max = machine.capabilities.maxParallel;
  return max ? `${machine.currentTasks.length}/${max}` : String(machine.currentTasks.length);
}

export interface JoinTokenInfo {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly maxUses: number | null;
  readonly uses: number;
}

export interface JoinStatus {
  readonly token: JoinTokenInfo | null;
  readonly panelUrl: string;
  readonly requireApproval: boolean;
}

export interface GeneratedJoinToken {
  readonly token: string;
  readonly info: JoinTokenInfo;
  readonly panelUrl: string;
  readonly commands: JoinCommandPair;
  /** Listener reachable by IP with its own certificate: `carbon join <ip>:<porta> --fingerprint …`. */
  readonly direct: { readonly lan: readonly JoinCommandPair[]; readonly internet: JoinCommandPair; readonly fingerprint: string | null } | null;
}

export interface JoinCommandPair {
  readonly cli: string;
  readonly docker: string;
}

/** Validity choices offered in the UI (hours; null = no expiry, the Docker Swarm default). */
export const JOIN_TTL_OPTIONS: readonly { readonly label: string; readonly hours: number | null }[] = [
  { label: "sem validade", hours: null },
  { label: "1 hora", hours: 1 },
  { label: "24 horas", hours: 24 },
  { label: "7 dias", hours: 24 * 7 },
];

/** "3 de 5 usos · expira em 06/11 18:00" style summary of the active join token. */
export function joinTokenSummary(info: JoinTokenInfo): string {
  const uses = info.maxUses ? `${info.uses} de ${info.maxUses} usos` : `${info.uses} ${info.uses === 1 ? "servidor entrou" : "servidores entraram"}`;
  const expiry = info.expiresAt ? `expira ${new Date(info.expiresAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "sem validade";
  return `${uses} · ${expiry}`;
}
