"use client";

import { AsciiReveal, AsciiSkeleton } from "ascii-reveal";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUp, RotateCcw, Square, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useEngine } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import { STAGES, type Ticket, type TicketStatus } from "@/lib/domain/types";
import { PlacementBadge } from "./PlacementBadge";

const STATUS_LABEL: Readonly<Record<TicketStatus, string>> = {
  queued: "na fila",
  running: "executando",
  waiting: "aguarda você",
  done: "entregue",
  failed: "falhou",
};

const PRIORITY_BARS: Readonly<Record<Ticket["priority"], number>> = { urgent: 4, high: 3, medium: 2, low: 1 };

function PriorityGlyph({ priority }: { priority: Ticket["priority"] }) {
  const level = PRIORITY_BARS[priority];
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-label={`prioridade ${priority}`}>
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-[1px] ${bar <= level ? (priority === "urgent" ? "bg-danger" : "bg-ink") : "bg-line-strong"}`}
          style={{ height: `${bar * 3}px` }}
        />
      ))}
    </span>
  );
}

function LiveActions({ ticket }: { ticket: Ticket }) {
  const [error, setError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const isRemote = (ticket.runtime ?? "local") !== "local";
  const act = (path: string, body?: unknown, method = "POST") =>
    api(path, { method, body }).then(
      () => setError(null),
      (e: unknown) => setError(e instanceof Error ? e.message : "falha"),
    );
  // Remote tasks stop on the worker's next heartbeat: show it until the status changes.
  const stop = () => {
    setIsStopping(true);
    void act(`/api/tasks/${ticket.id}`, { action: "cancel" }).finally(() => setIsStopping(false));
  };
  const canStop = ticket.status === "running" || (isRemote && ticket.status === "waiting");
  const button = "flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-muted hover:text-ink disabled:opacity-50";
  return (
    <span className="flex items-center gap-1">
      {error && <span role="alert" className="max-w-[180px] truncate font-mono text-[10px] text-danger" title={error}>{error}</span>}
      {canStop && (
        <button type="button" className={button} disabled={isStopping} onClick={stop}><Square className="size-3" /> {isStopping ? "parando…" : "parar"}</button>
      )}
      {(ticket.status === "failed" || ticket.status === "done" || ticket.status === "waiting") && (
        <button type="button" className={button} onClick={() => void act(`/api/tasks/${ticket.id}`, { action: "retry" })}><RotateCcw className="size-3" /> rodar de novo</button>
      )}
      {ticket.status !== "running" && (
        <button type="button" className={button} aria-label={`Remover ${ticket.key}`} onClick={() => void act(`/api/tasks/${ticket.id}`, undefined, "DELETE")}><Trash2 className="size-3" /></button>
      )}
    </span>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const { dispatch, mode } = useEngine();
  const stageProgress = ticket.stage ? (STAGES.indexOf(ticket.stage) + 1) / STAGES.length : 0;
  const progress = ticket.totalEvents === 0 ? stageProgress : ticket.cursor / ticket.totalEvents;
  const isRunning = ticket.status === "running";
  return (
    <motion.li
      layout
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className={`group relative overflow-hidden rounded-xl border px-3 py-2.5 ${isRunning ? "border-accent/50 bg-accent-weak" : "border-line bg-surface"}`}
    >
      <div className="flex items-center gap-2.5">
        <PriorityGlyph priority={ticket.priority} />
        <span className="font-mono text-[11px] text-muted">{ticket.key}</span>
        <span className="rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-subtle">
          {ticket.source}
        </span>
        <PlacementBadge ticket={ticket} />
        <span className={`ml-auto font-mono text-[10px] uppercase tracking-[0.08em] ${isRunning ? "text-accent" : "text-subtle"}`}>
          {STATUS_LABEL[ticket.status]}
        </span>
      </div>
      <p className="mt-1.5 truncate text-[13px]">{ticket.title}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[10px] text-subtle">
          {ticket.repo} · @{ticket.requester}{ticket.model ? ` · ${ticket.model}` : ""}
        </p>
        {mode === "live" && <LiveActions ticket={ticket} />}
        {ticket.status === "queued" && (
          <button
            type="button"
            onClick={() => dispatch({ type: "prioritize", ticketId: ticket.id })}
            className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <ArrowUp className="size-3" /> priorizar
          </button>
        )}
      </div>
      <div className="mt-2 h-[2px] overflow-hidden rounded-full bg-line">
        <motion.div
          className={`h-full origin-left ${ticket.status === "done" ? "bg-muted" : "bg-accent"}`}
          initial={false}
          animate={{ scaleX: ticket.status === "done" ? 1 : progress }}
          transition={{ duration: 0.4, ease: [0.2, 0, 0.2, 1] }}
        />
      </div>
    </motion.li>
  );
}

export function TicketQueue() {
  const { state, isReady } = useEngine();
  const queued = state.tickets.filter((t) => t.status === "queued").length;
  return (
    <Panel eyebrow="Fila · Linear + GitHub" title="Tickets" aside={<span className="font-mono text-[11px] text-muted">{queued} na fila</span>}>
      {!isReady && <AsciiSkeleton variant="scan" lines={6} widths={["90%", "70%", "85%", "60%", "80%", "50%"]} />}
      {isReady && state.tickets.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">Fila vazia. Clique em “Nova tarefa” para começar — algo pequeno primeiro.</p>
      )}
      <AsciiReveal loading={!isReady} revealOnMount={false}>
      <ul className="flex flex-col gap-2">
        {state.tickets.map((ticket) => (
          <TicketRow key={ticket.id} ticket={ticket} />
        ))}
      </ul>
      </AsciiReveal>
    </Panel>
  );
}
