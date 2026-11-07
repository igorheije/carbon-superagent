"use client";

import { ArrowLeftRight, Cloud, Monitor, Server } from "lucide-react";
import type { TaskRuntime, Ticket } from "@/lib/domain/types";
import { isMixed, placementOf, runTrail, trailText } from "./placement";

const ICONS: Readonly<Record<TaskRuntime, typeof Monitor>> = { local: Monitor, pool: Server, agentcore: Cloud };

interface PlacementBadgeProps {
  readonly ticket: Pick<Ticket, "runtime" | "status" | "logs" | "placement" | "runs">;
  /** "compact": icon + short name (queue row); "full": "rodando em: worker x" + trail (task detail). */
  readonly variant?: "compact" | "full";
}

/**
 * Where the task runs right now (this machine, a pool worker or AgentCore), highlighted while it
 * runs. When it already ran on more than one machine, a ⇄ marks it and the tooltip shows the trail.
 */
export function PlacementBadge({ ticket, variant = "compact" }: PlacementBadgeProps) {
  const placement = placementOf(ticket);
  const trail = runTrail(ticket);
  const isRunningNow = ticket.status === "running" || ticket.status === "waiting";
  const mixed = isMixed(trail);
  const Icon = ICONS[placement.runtime];
  const tooltip = trail.length > 1 ? `${placement.label}\nexecuções: ${trailText(trail)}` : placement.label;
  const tone = isRunningNow ? "border-accent/60 bg-accent-weak text-ink" : "border-line text-subtle";
  const mixedMark = mixed && <ArrowLeftRight className="size-3 shrink-0 text-warn" aria-label="rodou em mais de uma máquina" />;

  if (variant === "compact") {
    // Never shrinks: the text next to it (repo · requester · model) is what truncates.
    return (
      <span title={tooltip} className={`inline-flex max-w-[150px] shrink-0 items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] ${tone}`}>
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate" aria-hidden>{placement.short}</span>
        <span className="sr-only">{tooltip}</span>
        {mixedMark}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 max-w-full flex-col items-start gap-0.5">
      <span title={tooltip} className={`inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] ${tone}`}>
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{placement.label}</span>
        {mixedMark}
      </span>
      {trail.length > 1 && <span className="max-w-full truncate font-mono text-[10px] text-subtle" title={trailText(trail)}>execuções: {trailText(trail)}</span>}
    </span>
  );
}
