"use client";

import { AsciiReveal, AsciiSkeleton } from "ascii-reveal";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUp, RotateCcw, Square, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import { STAGES, type Ticket, type TicketStatus } from "@/lib/domain/types";
import { PlacementBadge } from "./PlacementBadge";
import { runningCount } from "./SubagentPanel";

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
  const button = "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-muted hover:text-ink disabled:opacity-50";
  return (
    <span className="flex shrink-0 items-center gap-1">
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

/** "⟁ 3" while sub-agents run; a quiet "multi" chip when the task only allows them. */
function SubagentBadge({ ticket }: { ticket: Ticket }) {
  const running = runningCount(ticket);
  if (running > 0) {
    return (
      <motion.span
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex items-center gap-1 rounded-full border border-accent/50 bg-accent-weak px-1.5 py-px font-mono text-[9.5px] text-accent"
        aria-label={`${running} sub-agentes rodando`}
        title={`${running} sub-agente(s) rodando`}
      >
        <span className="relative flex size-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
          <span className="relative size-1.5 rounded-full bg-accent" />
        </span>
        ⟁ {running}
      </motion.span>
    );
  }
  if (!ticket.multiAgent) return null;
  return <span className="rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-subtle" title="multi-agentes liberado">multi</span>;
}

/** Distributed task: "⇉ N" on the parent, "↳ KEY" on each part. */
function SplitBadge({ ticket }: { ticket: Ticket }) {
  const chip = "shrink-0 whitespace-nowrap rounded-full border px-1.5 py-px font-mono text-[9.5px]";
  if (ticket.parent) return <span className={`${chip} border-line text-subtle`} title={`parte de ${ticket.parent.key}: ${ticket.parent.title}`}>↳ {ticket.parent.key}</span>;
  if (ticket.split) return <span className={`${chip} border-accent/50 bg-accent-weak text-accent`} title={`${ticket.split.children.length} partes em outros computadores`}>⇉ {ticket.split.children.length}</span>;
  if (ticket.distributed) return <span className={`${chip} border-line uppercase tracking-[0.08em] text-subtle`} title="pode dividir entre os computadores do cluster">cluster</span>;
  return null;
}

function TicketRow({ ticket, isFocused }: { ticket: Ticket; isFocused: boolean }) {
  const { dispatch, mode, focusedTicketId, setFocusedTicketId } = useEngine();
  // isFocused = shown in the grid (picked or automatic); isPicked = the user chose it.
  const isPicked = focusedTicketId === ticket.id;
  const stageProgress = ticket.stage ? (STAGES.indexOf(ticket.stage) + 1) / STAGES.length : 0;
  const progress = ticket.totalEvents === 0 ? stageProgress : ticket.cursor / ticket.totalEvents;
  const isRunning = ticket.status === "running";
  return (
    <motion.li
      layout
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className={`group relative overflow-hidden rounded-xl border px-3 py-2.5 ${isRunning ? "border-accent/50 bg-accent-weak" : "border-line bg-surface"} ${isFocused ? "ring-2 ring-accent" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <PriorityGlyph priority={ticket.priority} />
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted">{ticket.key}</span>
        <span className="rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-subtle">
          {ticket.source}
        </span>
        <SubagentBadge ticket={ticket} />
        <SplitBadge ticket={ticket} />
        <span className={`ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] ${isRunning ? "text-accent" : "text-subtle"}`}>
          {STATUS_LABEL[ticket.status]}
        </span>
      </div>
      <button
        type="button"
        aria-pressed={isPicked}
        title={isPicked ? "Fixada no painel abaixo · clique para voltar ao automático" : isFocused ? "Mostrando no painel abaixo (automático) · clique para fixar" : "Ver esta tarefa no terminal, plano e entrega abaixo"}
        onClick={() => setFocusedTicketId(isPicked ? null : ticket.id)}
        className="mt-1.5 block w-full truncate rounded text-left text-[13px] outline-none hover:underline focus-visible:shadow-[var(--ring)]"
      >
        {ticket.title}
      </button>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <PlacementBadge ticket={ticket} />
          <p className="min-w-0 truncate font-mono text-[10px] text-subtle">
            {ticket.repo} · @{ticket.requester}{ticket.model ? ` · ${ticket.model}` : ""}
          </p>
        </div>
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
  const focused = useFocusTicket();
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
          <TicketRow key={ticket.id} ticket={ticket} isFocused={focused?.id === ticket.id} />
        ))}
      </ul>
      </AsciiReveal>
    </Panel>
  );
}
