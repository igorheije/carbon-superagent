"use client";

import { Cloud, Monitor, Server } from "lucide-react";
import type { TaskRuntime, Ticket } from "@/lib/domain/types";
import { placementOf } from "./placement";

const ICONS: Readonly<Record<TaskRuntime, typeof Monitor>> = { local: Monitor, pool: Server, agentcore: Cloud };

interface PlacementBadgeProps {
  readonly ticket: Pick<Ticket, "runtime" | "status" | "logs" | "placement">;
  /** "compact": icon + short name (queue row); "full": "rodou em: worker x" (task detail). */
  readonly variant?: "compact" | "full";
}

/** Where the task runs/ran: this machine, a pool worker or an AgentCore session. */
export function PlacementBadge({ ticket, variant = "compact" }: PlacementBadgeProps) {
  const placement = placementOf(ticket);
  const Icon = ICONS[placement.runtime];
  return (
    <span title={placement.label} className={`inline-flex ${variant === "full" ? "max-w-full" : "min-w-[64px] max-w-[140px]"} items-center gap-1 rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-subtle`}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {variant === "full" ? (
        <span className="truncate">{placement.label}</span>
      ) : (
        <>
          <span className="truncate" aria-hidden>{placement.short}</span>
          <span className="sr-only">{placement.label}</span>
        </>
      )}
    </span>
  );
}
