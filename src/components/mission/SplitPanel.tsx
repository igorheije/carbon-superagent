"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, GitMerge, Laptop, Server, TriangleAlert, X } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import type { MergeResult, SplitChild, Ticket } from "@/lib/domain/types";

const PHASE_TEXT: Record<NonNullable<Ticket["split"]>["phase"], string> = {
  running: "partes rodando nos computadores",
  integrating: "integrando as partes",
  done: "partes integradas",
};

const MERGE_TEXT: Record<MergeResult, string> = {
  merged: "integrada",
  empty: "sem mudanças",
  conflict: "conflito · agente aplica à mão",
  failed: "falhou · agente faz",
};

function where(child: Ticket | undefined): { label: string; isRemote: boolean } {
  const name = child?.placement?.workerName;
  if (name) return { label: name, isRemote: true };
  if (child?.runtime === "pool") return { label: "aguardando um computador", isRemote: true };
  return { label: "este computador", isRemote: false };
}

function StatusDot({ status }: { status: Ticket["status"] | undefined }) {
  const reduce = useReducedMotion();
  if (status === "done") return <span className="flex size-5 items-center justify-center rounded-full bg-ok/15 text-ok"><Check className="size-3" strokeWidth={3} /></span>;
  if (status === "failed") return <span className="flex size-5 items-center justify-center rounded-full bg-danger/15 text-danger"><X className="size-3" strokeWidth={3} /></span>;
  const isRunning = status === "running";
  return (
    <span className="relative flex size-5 items-center justify-center">
      {isRunning && !reduce && <motion.span className="absolute inset-0 rounded-full bg-accent/40" animate={{ scale: [0.6, 1.4], opacity: [0.8, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }} />}
      <span className={`size-2 rounded-full ${isRunning ? "bg-accent" : status === "waiting" ? "bg-warn" : "bg-line-strong"}`} />
    </span>
  );
}

function PartCard({ part, child }: { part: SplitChild; child: Ticket | undefined }) {
  const place = where(child);
  const isRunning = child?.status === "running";
  const Icon = place.isRemote ? Server : Laptop;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className={`relative overflow-hidden rounded-xl border px-3 py-2.5 ${isRunning ? "border-accent/50 bg-accent-weak" : "border-line bg-surface"}`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={child?.status} />
        <span className="shrink-0 font-mono text-[11px] text-muted">{part.key}</span>
        <p className="min-w-0 flex-1 truncate text-[13px]" title={part.title}>{part.title}</p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap"><Icon className="size-3" /> {place.label}</span>
        <span className="shrink-0 whitespace-nowrap" title={part.files.join(", ")}>{part.files.length} arquivo{part.files.length === 1 ? "" : "s"}</span>
        {part.merge && (
          <span className={`flex shrink-0 items-center gap-1 whitespace-nowrap ${part.merge === "conflict" || part.merge === "failed" ? "text-warn" : "text-ok"}`}>
            {part.merge === "conflict" || part.merge === "failed" ? <TriangleAlert className="size-3" /> : <GitMerge className="size-3" />}
            {MERGE_TEXT[part.merge]}
          </span>
        )}
      </div>
    </motion.li>
  );
}

/** Parts of the distributed task in focus (or of the parent of the subtask in focus). Hidden otherwise. */
export function SplitPanel() {
  const focus = useFocusTicket();
  const { state } = useEngine();
  const parent = focus?.split ? focus : focus?.parent ? state.tickets.find((t) => t.id === focus.parent?.id) : null;
  if (!parent) {
    if (!focus?.distributed || focus.split) return null;
    return (
      <Panel eyebrow={`Tarefa distribuída · ${focus.key}`} title="Liberada para dividir entre os computadores">
        <p className="text-[12px] text-muted">O agente decide no plano se vale dividir. Se dividir, as partes aparecem aqui com o computador onde cada uma roda.</p>
      </Panel>
    );
  }
  const split = parent.split;
  if (!split) return null;
  const children = split.children.map((part) => ({ part, child: state.tickets.find((t) => t.id === part.id) }));
  const finished = children.filter(({ child }) => child?.status === "done" || child?.status === "failed").length;
  const machines = new Set(children.map(({ child }) => child?.placement?.workerName).filter(Boolean)).size;
  return (
    <Panel
      eyebrow={`Tarefa distribuída · ${parent.key}`}
      title={PHASE_TEXT[split.phase]}
      aside={<span className="font-mono text-[11px] text-muted">{finished}/{children.length} partes · {machines === 0 ? "neste computador" : `${machines} computador${machines === 1 ? "" : "es"}`}</span>}
    >
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {children.map(({ part, child }) => <PartCard key={part.id} part={part} child={child} />)}
        </AnimatePresence>
      </ul>
    </Panel>
  );
}
