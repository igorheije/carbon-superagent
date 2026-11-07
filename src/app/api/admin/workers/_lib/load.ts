import "server-only";
import os from "node:os";
import { runsSince, statsFor, summarizeRuns, type NodeRunStats } from "@/server/repo/task-runs";
import { createHostProbe } from "@/worker/host-probe";
import { deviceKind, type DeviceKind, type StoredTelemetry } from "@/shared/host-telemetry";
import type { FleetWorker } from "./fleet";

/**
 * Configurações → Máquinas → Carga: one entry for this computer (the local runner) plus every
 * non-revoked worker, with the last host snapshot and run stats for the window.
 */
export const LOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The local runner runs one task at a time (runner.ts keeps a single activeTaskId). */
const LOCAL_SLOTS = 1;

export interface LoadNode {
  readonly id: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly device: DeviceKind;
  readonly status: FleetWorker["status"] | "local";
  readonly slots: number;
  readonly telemetry: StoredTelemetry | null;
  readonly stats: NodeRunStats;
  /** busyMs / (window × slots), 0–1. */
  readonly utilization: number;
  /** This node's share of all `done` runs in the window, 0–1 (null when nothing finished). */
  readonly shareOfDone: number | null;
}

export interface LoadView {
  readonly windowMs: number;
  readonly generatedAt: number;
  readonly nodes: readonly LoadNode[];
}

// The panel's own probe lives for the whole process so CPU % is measured between requests.
const globalProbe = globalThis as unknown as { carbonLocalProbe?: ReturnType<typeof createHostProbe> };
const localProbe = () => (globalProbe.carbonLocalProbe ??= createHostProbe());

function utilization(stats: NodeRunStats, slots: number, windowMs: number): number {
  return Math.min(1, stats.busyMs / (windowMs * Math.max(1, slots)));
}

export function buildLoadView(fleet: readonly FleetWorker[], telemetryOf: (id: string) => StoredTelemetry | null, now = Date.now()): LoadView {
  const stats = summarizeRuns(runsSince(now - LOAD_WINDOW_MS), LOAD_WINDOW_MS, now);
  const totalDone = [...stats.values()].reduce((sum, s) => sum + s.done, 0);
  const share = (s: NodeRunStats) => (totalDone > 0 ? s.done / totalDone : null);

  const localStats = statsFor(stats, null);
  const local: LoadNode = {
    id: "local",
    name: `${os.hostname().split(".")[0]} (painel)`,
    isLocal: true,
    device: deviceKind(localProbe()(), "local"),
    status: "local",
    slots: LOCAL_SLOTS,
    telemetry: { ...localProbe()(), receivedAt: now },
    stats: localStats,
    utilization: utilization(localStats, LOCAL_SLOTS, LOAD_WINDOW_MS),
    shareOfDone: share(localStats),
  };

  const remote = fleet
    .filter((w) => w.status !== "revoked")
    .map((w): LoadNode => {
      const s = statsFor(stats, w.id);
      const slots = w.capabilities.maxParallel ?? 1;
      const telemetry = telemetryOf(w.id);
      return {
        id: w.id,
        name: w.name,
        isLocal: false,
        device: deviceKind(telemetry, w.kind),
        status: w.status,
        slots,
        telemetry,
        stats: s,
        utilization: utilization(s, slots, LOAD_WINDOW_MS),
        shareOfDone: share(s),
      };
    });

  return { windowMs: LOAD_WINDOW_MS, generatedAt: now, nodes: [local, ...remote] };
}
