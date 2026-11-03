import type { LogLine, StageId, Ticket } from "./types";

export interface StageInsight {
  readonly logs: readonly LogLine[];
  readonly events: number;
  readonly tools: number;
  readonly warnings: number;
  /** Short, stage-specific facts (plan steps, files read, test result, findings, PR...). */
  readonly highlights: readonly string[];
}

const MAX_HIGHLIGHTS = 6;

function highlightsFor(ticket: Ticket, stage: StageId): readonly string[] {
  switch (stage) {
    case "intake":
      return [ticket.model ? `modelo ${ticket.model}` : null, ticket.repo ? `projeto ${ticket.repo}` : null].filter((h): h is string => h !== null);
    case "plan":
      return ticket.plan.map((s) => `${s.done ? "✓" : s.state === "skipped" ? "↷" : "○"} ${s.text}`);
    case "research":
      return ticket.hits.map((h) => `${h.ref} · ${h.score.toFixed(2)}`);
    case "test":
      return ticket.tests ? [`${ticket.tests.passing}/${ticket.tests.total} testes passando`] : [];
    case "review":
      return ticket.findings.map((f) => `${f.resolved ? "✓" : "!"} ${f.severity} · ${f.text}`);
    case "deliver":
      return [
        ...(ticket.workspace ? [`worktree ${ticket.workspace.branch} ← ${ticket.workspace.base}${ticket.workspace.commit ? ` · ${ticket.workspace.commit}` : ""}`] : []),
        ...(ticket.pr ? [`PR #${ticket.pr.number}${ticket.pr.draft ? " (draft)" : ""} · ${ticket.pr.branch} → ${ticket.pr.base ?? "base"}`] : []),
        ...ticket.diff.map((d) => `${d.path} +${d.additions} −${d.deletions}`),
      ];
    default:
      return [];
  }
}

/** Everything the expanded pipeline shows for one stage of a ticket. */
export function stageInsight(ticket: Ticket | null, stage: StageId): StageInsight {
  if (!ticket) return { logs: [], events: 0, tools: 0, warnings: 0, highlights: [] };
  const logs = ticket.logs.filter((l) => l.stage === stage);
  return {
    logs,
    events: logs.length,
    tools: logs.filter((l) => l.level === "tool").length,
    warnings: logs.filter((l) => l.level === "warn").length,
    highlights: highlightsFor(ticket, stage).slice(0, MAX_HIGHLIGHTS),
  };
}

/** 0..1 progress through the pipeline, counting the active stage as half done. */
export function pipelineProgress(statuses: readonly ("idle" | "working" | "done")[]): number {
  if (statuses.length === 0) return 0;
  const score = statuses.reduce((sum, s) => sum + (s === "done" ? 1 : s === "working" ? 0.5 : 0), 0);
  return score / statuses.length;
}
