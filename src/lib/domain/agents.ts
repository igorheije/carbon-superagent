import { STAGES, type AgentStatus, type StageId } from "./types";

export function idleAgents(): Record<StageId, AgentStatus> {
  return Object.fromEntries(STAGES.map((stage) => [stage, "idle"])) as Record<StageId, AgentStatus>;
}

export function agentsAt(stage: StageId): Record<StageId, AgentStatus> {
  const current = STAGES.indexOf(stage);
  return Object.fromEntries(
    STAGES.map((s, i) => [s, i < current ? "done" : i === current ? "working" : "idle"]),
  ) as Record<StageId, AgentStatus>;
}

export function allDone(): Record<StageId, AgentStatus> {
  return Object.fromEntries(STAGES.map((stage) => [stage, "done"])) as Record<StageId, AgentStatus>;
}
