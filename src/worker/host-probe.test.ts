import type os from "node:os";
import { describe, expect, it } from "vitest";
import { deviceKind, hostTelemetrySchema, parseStoredTelemetry } from "../shared/host-telemetry";
import { busyPercent, createHostProbe, detectForm, osLabel } from "./host-probe";

const cpu = (user: number, idle: number): os.CpuInfo => ({ model: "x", speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } });
const none = () => false;

describe("detectForm", () => {
  it("treats a headless Linux box as a server", () => {
    expect(detectForm("linux", { env: {}, exists: none, readText: () => "0::/init.scope" })).toBe("server");
  });

  it("detects containers by marker file, cgroup or Kubernetes env", () => {
    expect(detectForm("linux", { env: {}, exists: (f) => f === "/.dockerenv", readText: () => "" })).toBe("container");
    expect(detectForm("linux", { env: {}, exists: none, readText: () => "12:cpu:/kubepods/pod1" })).toBe("container");
    expect(detectForm("linux", { env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" }, exists: none, readText: () => "" })).toBe("container");
  });

  it("treats Linux with a graphical session as a desktop", () => {
    expect(detectForm("linux", { env: { DISPLAY: ":0" }, exists: none, readText: () => "" })).toBe("desktop");
    expect(detectForm("linux", { env: {}, exists: (f) => f === "/usr/share/xsessions", readText: () => "" })).toBe("desktop");
  });

  it("splits Windows Server from Windows desktop, and macOS is a desktop", () => {
    expect(detectForm("win32", { version: () => "Windows Server 2022 Datacenter" })).toBe("server");
    expect(detectForm("win32", { version: () => "Windows 11 Pro" })).toBe("desktop");
    expect(detectForm("darwin", {})).toBe("desktop");
  });
});

describe("osLabel", () => {
  it("reads PRETTY_NAME on Linux and falls back to the kernel", () => {
    expect(osLabel("linux", { readText: () => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 20.04.6 LTS"\n', release: () => "5.4.0" })).toBe("Ubuntu 20.04.6 LTS");
    expect(osLabel("linux", { readText: () => null, release: () => "5.4.0" })).toBe("Linux 5.4.0");
  });

  it("maps Darwin to macOS versions", () => {
    expect(osLabel("darwin", { release: () => "24.4.0" })).toBe("macOS 15");
    expect(osLabel("darwin", { release: () => "27.2.0" })).toBe("macOS 28");
  });
});

describe("busyPercent", () => {
  it("measures the busy share between two samples", () => {
    expect(busyPercent({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(busyPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBe(0);
  });
});

describe("createHostProbe", () => {
  it("returns a schema-valid snapshot with CPU % since the previous call", () => {
    let samples = [[cpu(500, 500), cpu(500, 500)], [cpu(500, 501), cpu(500, 501)], [cpu(1500, 700), cpu(1500, 700)]];
    const probe = createHostProbe({
      platform: "linux",
      env: {},
      exists: none,
      readText: (f) => (f === "/etc/os-release" ? 'PRETTY_NAME="Ubuntu 20.04.6 LTS"' : ""),
      cpus: () => {
        const [head, ...rest] = samples;
        samples = rest.length ? rest : samples;
        return head;
      },
      loadavg: () => [1.234, 1, 1],
      totalmem: () => 16_000,
      freemem: () => 4_000,
      uptime: () => 99.6,
      arch: () => "x64",
    });

    const first = probe();
    const tooSoon = probe();
    const second = probe();

    expect(hostTelemetrySchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ platform: "linux", form: "server", osLabel: "Ubuntu 20.04.6 LTS", cpus: 2, cpuPercent: 50, load1: 1.23, memUsedBytes: 12_000, uptimeSec: 100 });
    expect(tooSoon.cpuPercent).toBe(50); // 1 ms later: repeats the last reading instead of ~0%
    expect(second.cpuPercent).toBe(83.3);
  });
});

describe("deviceKind", () => {
  it("maps telemetry to the illustration", () => {
    expect(deviceKind({ platform: "linux", form: "server" })).toBe("server");
    expect(deviceKind({ platform: "linux", form: "desktop" })).toBe("linux");
    expect(deviceKind({ platform: "darwin", form: "desktop" })).toBe("mac");
    expect(deviceKind({ platform: "darwin", form: "container" })).toBe("container");
    expect(deviceKind({ platform: "win32", form: "desktop" })).toBe("windows");
    expect(deviceKind({ platform: "win32", form: "server" })).toBe("server");
    expect(deviceKind(null)).toBe("unknown");
    expect(deviceKind(null, "agentcore")).toBe("cloud");
  });
});

describe("parseStoredTelemetry", () => {
  it("accepts a valid stored snapshot and rejects garbage", () => {
    const snapshot = createHostProbe({ platform: "darwin", cpus: () => [cpu(1, 1)], release: () => "24.0.0" })();
    expect(parseStoredTelemetry(JSON.stringify({ ...snapshot, receivedAt: 5 }))).toEqual({ ...snapshot, receivedAt: 5 });
    expect(parseStoredTelemetry(JSON.stringify(snapshot))).toBeNull();
    expect(parseStoredTelemetry("{not json")).toBeNull();
    expect(parseStoredTelemetry(null)).toBeNull();
  });
});
