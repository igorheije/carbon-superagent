import "server-only";
import { agentsAt, idleAgents } from "@/lib/domain/agents";
import type { EngineState } from "@/lib/domain/types";
import { getSettings } from "../repo/settings";
import { runsByTask } from "../repo/task-runs";
import { listLessons, listTasks } from "../repo/tasks";
import { runnerStatus } from "./runner";

/** Live state in the same shape as the simulator, so every panel works in both modes. */
/** Live state of one project, in the same shape as the simulator. */
export function liveSnapshot(projectId: string | null): EngineState {
  const tasks = projectId ? listTasks(projectId) : [];
  const runs = runsByTask(tasks.map((t) => t.id));
  const tickets = tasks.map((t) => {
    const trail = runs.get(t.id);
    return trail ? { ...t.snapshot, runs: trail } : t.snapshot;
  });
  const status = runnerStatus();
  const active = tickets.find((t) => t.id === status.activeTaskId) ?? null;
  const done = tickets.filter((t) => t.status === "done");
  // The pipeline follows the local run, else a task running on a worker (never "active" locally).
  const remoteRunning = tickets.find((t) => (t.runtime ?? "local") !== "local" && t.status === "running");
  const pipelineStage = active?.stage ?? remoteRunning?.stage ?? null;
  return {
    tick: 0,
    running: status.enabled,
    speedMs: 0,
    acceptMode: getSettings().acceptMode,
    activeTicketId: active?.id ?? null,
    tickets,
    agents: pipelineStage ? agentsAt(pipelineStage) : idleAgents(),
    lessons: projectId ? listLessons(projectId) : [],
    metrics: {
      completed: done.length,
      prsOpened: tickets.filter((t) => t.pr !== null).length,
      tokens: tickets.reduce((sum, t) => sum + t.tokens, 0),
      ticksPerTicket: done.map((t) => t.logs.length),
    },
    nextLogId: 0,
  };
}
