import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import type { HostForm, HostPlatform, HostTelemetry } from "../shared/host-telemetry";

/**
 * Collects the host snapshot (shared/host-telemetry.ts). CPU % is the busy share of all cores
 * between two calls, so the first call of a probe reports the average since boot. Pure node:os
 * plus a few files read once; no child processes, so it is cheap to call on every heartbeat.
 */
export interface ProbeDeps {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (file: string) => boolean;
  readonly readText?: (file: string) => string | null;
  readonly cpus?: () => readonly os.CpuInfo[];
  readonly loadavg?: () => readonly number[];
  readonly totalmem?: () => number;
  readonly freemem?: () => number;
  readonly uptime?: () => number;
  readonly release?: () => string;
  readonly version?: () => string;
  readonly arch?: () => string;
}

const readTextSafe = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export function normalizePlatform(platform: NodeJS.Platform): HostPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
}

/** Container > desktop session > server. Linux desktops ship session files even when run as a service. */
export function detectForm(platform: HostPlatform, deps: Pick<ProbeDeps, "env" | "exists" | "readText" | "version">): HostForm {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? readTextSafe;
  if (platform === "linux") {
    if (exists("/.dockerenv") || exists("/run/.containerenv") || env.KUBERNETES_SERVICE_HOST) return "container";
    if (/(docker|kubepods|containerd|lxc)/.test(readText("/proc/1/cgroup") ?? "")) return "container";
    const hasSession = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) || exists("/usr/share/xsessions") || exists("/usr/share/wayland-sessions");
    return hasSession ? "desktop" : "server";
  }
  if (platform === "win32") return /server/i.test((deps.version ?? os.version)()) ? "server" : "desktop";
  return platform === "darwin" ? "desktop" : "server";
}

/** "Ubuntu 20.04.6 LTS" from /etc/os-release, "macOS 15.4", "Windows 11 Pro"; falls back to the kernel. */
export function osLabel(platform: HostPlatform, deps: Pick<ProbeDeps, "readText" | "release" | "version">): string {
  const readText = deps.readText ?? readTextSafe;
  const release = (deps.release ?? os.release)();
  if (platform === "linux") {
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readText("/etc/os-release") ?? "")?.[1];
    return (pretty ?? `Linux ${release}`).slice(0, 120);
  }
  if (platform === "darwin") {
    const major = Number(release.split(".")[0]);
    // Darwin 20 = macOS 11 … Darwin 24 = macOS 15; Darwin 25+ = macOS 26+ (year-based names).
    const mac = major >= 25 ? major + 1 : major >= 20 ? major - 9 : null;
    return mac ? `macOS ${mac}` : `macOS (Darwin ${release})`;
  }
  if (platform === "win32") return (deps.version ?? os.version)().slice(0, 120) || `Windows ${release}`;
  return `${platform} ${release}`.slice(0, 120);
}

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

function cpuTotals(cpus: readonly os.CpuInfo[]): CpuTotals {
  return cpus.reduce(
    (acc, cpu) => {
      const t = cpu.times;
      return { idle: acc.idle + t.idle, total: acc.total + t.user + t.nice + t.sys + t.idle + t.irq };
    },
    { idle: 0, total: 0 },
  );
}

export function busyPercent(previous: CpuTotals | null, current: CpuTotals): number {
  const idle = current.idle - (previous?.idle ?? 0);
  const total = current.total - (previous?.total ?? 0);
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 1000) / 10));
}

/** Minimum CPU time (ms per core) between two samples for a meaningful busy %. */
export const MIN_SAMPLE_MS = 1_000;

/** Returns a probe; each call yields a fresh snapshot with CPU % measured since the previous call. */
export function createHostProbe(deps: ProbeDeps = {}): () => HostTelemetry {
  const platform = normalizePlatform(deps.platform ?? process.platform);
  const form = detectForm(platform, deps);
  const label = osLabel(platform, deps);
  const arch = (deps.arch ?? os.arch)().slice(0, 20);
  const cpus = deps.cpus ?? os.cpus;
  const loadavg = deps.loadavg ?? os.loadavg;
  const totalmem = deps.totalmem ?? os.totalmem;
  const freemem = deps.freemem ?? os.freemem;
  const uptime = deps.uptime ?? os.uptime;
  let previous: CpuTotals | null = null;
  let lastPercent = 0;

  return () => {
    const list = cpus();
    const totals = cpuTotals(list);
    // Samples closer than MIN_SAMPLE_MS per core (hello → claim) would read ~0%: repeat the last value.
    const isTooSoon = previous !== null && totals.total - previous.total < MIN_SAMPLE_MS * Math.max(1, list.length);
    if (!isTooSoon) {
      lastPercent = busyPercent(previous, totals);
      previous = totals;
    }
    const cpuPercent = lastPercent;
    const memTotalBytes = Math.max(0, Math.round(totalmem()));
    return {
      platform,
      form,
      osLabel: label,
      arch,
      cpus: Math.max(1, list.length),
      cpuPercent,
      load1: Math.max(0, Math.round((loadavg()[0] ?? 0) * 100) / 100),
      memTotalBytes,
      memUsedBytes: Math.min(memTotalBytes, Math.max(0, memTotalBytes - Math.round(freemem()))),
      uptimeSec: Math.max(0, Math.round(uptime())),
    };
  };
}
