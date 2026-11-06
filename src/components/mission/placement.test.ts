import { describe, expect, it } from "vitest";
import type { LogLine, Ticket } from "@/lib/domain/types";
import { placementOf } from "./placement";

const log = (id: number, text: string): LogLine => ({ id, stage: "intake", level: "info", text });
type Source = Pick<Ticket, "runtime" | "status" | "logs" | "placement">;
const ticket = (patch: Partial<Source>): Source => ({ status: "done", logs: [], ...patch });

describe("placementOf", () => {
  it("defaults to this machine for old snapshots without runtime", () => {
    expect(placementOf(ticket({}))).toEqual({ runtime: "local", short: "esta máquina", label: "rodou em: esta máquina" });
  });

  it("names the pool worker from the latest claim log line", () => {
    const logs = [log(1, "worker antiga assumiu a tarefa"), log(2, "modelo x"), log(3, "worker sp-01 assumiu a tarefa")];
    expect(placementOf(ticket({ runtime: "pool", status: "running", logs }))).toEqual({ runtime: "pool", short: "sp-01", label: "rodando em: worker sp-01" });
  });

  it("falls back to the pool when the claim line is missing, and ignores old logs while queued", () => {
    expect(placementOf(ticket({ runtime: "pool" })).label).toBe("rodou em: pool de workers");
    const queued = placementOf(ticket({ runtime: "pool", status: "queued", logs: [log(1, "worker sp-01 assumiu a tarefa")] }));
    expect(queued.label).toBe("vai rodar em: pool de workers");
  });

  it("shows the AgentCore session, shortened", () => {
    const logs = [log(1, "worker AgentCore carbon-task-0f6c1e2a-1234-4abc-9def-000000000000 assumiu a tarefa")];
    const placement = placementOf(ticket({ runtime: "agentcore", status: "failed", logs }));
    expect(placement.short).toBe("AgentCore");
    expect(placement.label).toBe("rodou em: AgentCore (sessão carbon-task-0f6c1e2a-123…)");
    expect(placementOf(ticket({ runtime: "agentcore", status: "waiting" })).label).toBe("rodando em: AgentCore");
  });

  it("prefers the placement persisted on claim, even after the log was truncated", () => {
    const placement = { runtime: "pool" as const, workerId: "w1", workerName: "sp-02", agentcoreSessionId: null };
    expect(placementOf(ticket({ runtime: "pool", status: "running", placement, logs: [log(1, "worker antiga assumiu a tarefa")] })).label).toBe("rodando em: worker sp-02");
    expect(placementOf(ticket({ runtime: "pool", placement })).short).toBe("sp-02");
    const session = "carbon-task-0f6c1e2a-1234-4abc-9def-000000000000";
    const agentcore = { runtime: "agentcore" as const, workerId: `agentcore:${session}`, workerName: null, agentcoreSessionId: session };
    expect(placementOf(ticket({ runtime: "agentcore", placement: agentcore })).label).toBe("rodou em: AgentCore (sessão carbon-task-0f6c1e2a-123…)");
  });

  it("ignores a stale placement from another runtime and hides the worker while queued", () => {
    const placement = { runtime: "pool" as const, workerId: "w1", workerName: "sp-02", agentcoreSessionId: null };
    expect(placementOf(ticket({ runtime: "local", placement })).label).toBe("rodou em: esta máquina");
    expect(placementOf(ticket({ runtime: "pool", status: "queued", placement })).label).toBe("vai rodar em: pool de workers");
  });
});
