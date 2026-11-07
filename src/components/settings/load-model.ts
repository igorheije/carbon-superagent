/** Client-side model of Configurações → Máquinas → Carga (mirrors src/app/api/admin/workers/_lib/load.ts). */
import type { DeviceKind, StoredTelemetry } from "@/shared/host-telemetry";

export interface NodeStats {
  readonly finished: number;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly successRate: number | null;
  readonly avgDoneMs: number | null;
  readonly busyMs: number;
}

export interface LoadNode {
  readonly id: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly device: DeviceKind;
  readonly status: "busy" | "idle" | "paused" | "pending" | "offline" | "revoked" | "local";
  readonly slots: number;
  readonly telemetry: StoredTelemetry | null;
  readonly stats: NodeStats;
  readonly utilization: number;
  readonly shareOfDone: number | null;
}

export interface LoadView {
  readonly windowMs: number;
  readonly generatedAt: number;
  readonly nodes: readonly LoadNode[];
}

export const DEVICE_LABEL: Readonly<Record<DeviceKind, string>> = {
  server: "Servidor",
  mac: "Mac",
  linux: "Linux",
  windows: "Windows",
  container: "Container",
  cloud: "Nuvem (AgentCore)",
  unknown: "Máquina",
};

/** Telemetry older than this is shown as stale (the worker reports at least every claim/heartbeat). */
export const STALE_TELEMETRY_MS = 2 * 60_000;

export function pct(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function bytes(value: number): string {
  const gb = value / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}

export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/** 0–1 activity that drives the animation: live CPU when fresh, otherwise slot usage. */
export function activityOf(node: Pick<LoadNode, "telemetry" | "stats" | "slots" | "status">, now: number): number {
  if (node.status === "offline" || node.status === "revoked") return 0;
  const slotUse = Math.min(1, node.stats.running / Math.max(1, node.slots));
  const t = node.telemetry;
  if (!t || now - t.receivedAt > STALE_TELEMETRY_MS) return slotUse;
  return Math.max(slotUse * 0.6, Math.min(1, t.cpuPercent / 100));
}

/** Seconds per animation cycle: slow when idle (2.6 s), fast under load (0.5 s). */
export function cycleSeconds(activity: number): number {
  const a = Math.min(1, Math.max(0, activity));
  return Math.round((2.6 - 2.1 * a) * 100) / 100;
}

/**
 * Short verdict on how much a remote machine is helping, compared with this computer.
 * `speedup` > 1 means its tasks finish faster on average than local ones.
 */
export function efficiencyVerdict(node: LoadNode, local: LoadNode | undefined): { readonly label: string; readonly tone: "ok" | "warn" | "muted" } {
  if (node.isLocal) return { label: "este computador", tone: "muted" };
  if (node.status === "offline") return { label: "offline", tone: "warn" };
  if (node.stats.finished === 0) return { label: node.stats.running > 0 ? "primeira tarefa em andamento" : "sem tarefas ainda", tone: "muted" };
  const share = node.shareOfDone ?? 0;
  const speedup = local?.stats.avgDoneMs && node.stats.avgDoneMs ? local.stats.avgDoneMs / node.stats.avgDoneMs : null;
  const speed = speedup === null ? "" : speedup >= 1 ? ` · ${speedup.toFixed(1)}× mais rápido` : ` · ${(1 / speedup).toFixed(1)}× mais lento`;
  const tone = (node.stats.successRate ?? 0) >= 0.7 && share > 0 ? "ok" : "warn";
  return { label: `assumiu ${pct(share)} das entregas${speed}`, tone };
}
