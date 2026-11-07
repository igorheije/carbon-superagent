import { describe, expect, it } from "vitest";
import { activityOf, bytes, cycleSeconds, duration, efficiencyVerdict, pct, type LoadNode } from "./load-model";

const NOW = 1_000_000;
const stats = { finished: 0, done: 0, failed: 0, running: 0, successRate: null, avgDoneMs: null, busyMs: 0 };
const telemetry = { platform: "linux", form: "server", osLabel: "Ubuntu", arch: "x64", cpus: 6, cpuPercent: 80, load1: 2, memTotalBytes: 1, memUsedBytes: 1, uptimeSec: 1, receivedAt: NOW } as const;
const node = (over: Partial<LoadNode> = {}): LoadNode => ({
  id: "w", name: "vps", isLocal: false, device: "server", status: "idle", slots: 3, telemetry, stats, utilization: 0, shareOfDone: null, ...over,
});

describe("formatters", () => {
  it("formats percent, bytes and duration", () => {
    expect(pct(0.456)).toBe("46%");
    expect(pct(null)).toBe("—");
    expect(bytes(16 * 1024 ** 3)).toBe("16 GB");
    expect(bytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(bytes(300 * 1024 ** 2)).toBe("300 MB");
    expect(duration(null)).toBe("—");
    expect(duration(30_000)).toBe("30 s");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(90 * 60_000)).toBe("1.5 h");
  });
});

describe("activityOf / cycleSeconds", () => {
  it("uses fresh CPU, falls back to slot use when telemetry is stale, and is 0 offline", () => {
    expect(activityOf(node(), NOW)).toBe(0.8);
    expect(activityOf(node({ stats: { ...stats, running: 3 }, telemetry: { ...telemetry, receivedAt: 0 } }), NOW)).toBe(1);
    expect(activityOf(node({ status: "offline" }), NOW)).toBe(0);
  });

  it("speeds the animation up with load", () => {
    expect(cycleSeconds(0)).toBe(2.6);
    expect(cycleSeconds(1)).toBe(0.5);
    expect(cycleSeconds(5)).toBe(0.5);
  });
});

describe("efficiencyVerdict", () => {
  const local = node({ isLocal: true, stats: { ...stats, finished: 2, done: 2, avgDoneMs: 20 * 60_000 } });

  it("compares share and speed against this computer", () => {
    const remote = node({ stats: { ...stats, finished: 4, done: 4, successRate: 1, avgDoneMs: 10 * 60_000 }, shareOfDone: 4 / 6 });
    expect(efficiencyVerdict(remote, local)).toEqual({ label: "assumiu 67% das entregas · 2.0× mais rápido", tone: "ok" });
  });

  it("warns on poor success and explains empty or offline machines", () => {
    const flaky = node({ stats: { ...stats, finished: 2, done: 1, failed: 1, successRate: 0.5, avgDoneMs: 40 * 60_000 }, shareOfDone: 1 / 3 });
    expect(efficiencyVerdict(flaky, local)).toEqual({ label: "assumiu 33% das entregas · 2.0× mais lento", tone: "warn" });
    expect(efficiencyVerdict(node(), local).label).toBe("sem tarefas ainda");
    expect(efficiencyVerdict(node({ stats: { ...stats, running: 1 } }), local).label).toBe("primeira tarefa em andamento");
    expect(efficiencyVerdict(node({ status: "offline" }), local)).toEqual({ label: "offline", tone: "warn" });
    expect(efficiencyVerdict(local, local).tone).toBe("muted");
  });
});
