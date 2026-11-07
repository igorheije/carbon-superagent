import { z } from "zod";

/**
 * Host snapshot a pool worker reports with hello/claim/heartbeat (and the panel computes for its
 * own machine). Shared by panel, worker and UI: no server-only, DB or Next.js imports here.
 * Every field is bounded so a misbehaving worker cannot store arbitrary data.
 */
export const HOST_PLATFORMS = ["darwin", "linux", "win32", "other"] as const;
export type HostPlatform = (typeof HOST_PLATFORMS)[number];

/** server = headless machine (VPS, rack); desktop = workstation/laptop; container = Docker/K8s. */
export const HOST_FORMS = ["server", "desktop", "container"] as const;
export type HostForm = (typeof HOST_FORMS)[number];

export const hostTelemetrySchema = z.object({
  platform: z.enum(HOST_PLATFORMS),
  form: z.enum(HOST_FORMS),
  /** Human label, e.g. "Ubuntu 20.04.6 LTS", "macOS 15.4", "Windows 11 Pro". */
  osLabel: z.string().max(120),
  arch: z.string().max(20),
  cpus: z.number().int().min(1).max(4096),
  /** CPU busy % since the previous sample (0–100), all cores together. */
  cpuPercent: z.number().min(0).max(100),
  /** 1-minute load average (0 on Windows, where the OS does not provide it). */
  load1: z.number().min(0).max(100_000),
  memTotalBytes: z.number().int().min(0),
  memUsedBytes: z.number().int().min(0),
  uptimeSec: z.number().int().min(0),
});
export type HostTelemetry = z.infer<typeof hostTelemetrySchema>;

/** Telemetry as stored by the panel: the snapshot plus when it arrived. */
export interface StoredTelemetry extends HostTelemetry {
  readonly receivedAt: number;
}

/** Which illustration the UI draws for a machine. */
export type DeviceKind = "server" | "mac" | "linux" | "windows" | "container" | "cloud" | "unknown";

/**
 * Picks the device illustration. AgentCore nodes are always "cloud"; containers win over the OS
 * (a Docker worker on a Mac is still a container); a headless Linux/Windows box is a "server".
 */
export function deviceKind(telemetry: Pick<HostTelemetry, "platform" | "form"> | null, workerKind: "pool" | "agentcore" | "local" = "pool"): DeviceKind {
  if (workerKind === "agentcore") return "cloud";
  if (!telemetry) return "unknown";
  if (telemetry.form === "container") return "container";
  if (telemetry.platform === "darwin") return "mac";
  if (telemetry.form === "server") return "server";
  if (telemetry.platform === "win32") return "windows";
  if (telemetry.platform === "linux") return "linux";
  return "unknown";
}

/** Parses a stored JSON snapshot; null when absent or not a valid snapshot (never throws). */
export function parseStoredTelemetry(raw: string | null): StoredTelemetry | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const parsed = hostTelemetrySchema.safeParse(value);
    const receivedAt = typeof value.receivedAt === "number" ? value.receivedAt : null;
    return parsed.success && receivedAt !== null ? { ...parsed.data, receivedAt } : null;
  } catch {
    return null;
  }
}
