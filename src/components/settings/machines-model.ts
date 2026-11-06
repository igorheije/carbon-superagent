/** Client-side model of Admin → Máquinas (mirrors src/app/api/admin/workers/_lib/fleet.ts). */

export type MachineStatus = "busy" | "idle" | "offline" | "revoked";
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
  offline: "offline",
  revoked: "revogada",
};

export const STATUS_DOT: Readonly<Record<MachineStatus, string>> = {
  busy: "bg-accent",
  idle: "bg-ok",
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
