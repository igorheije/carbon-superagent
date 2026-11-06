"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Network, X } from "lucide-react";
import { useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import type { SubagentRun, Ticket } from "@/lib/domain/types";

const TICK_MS = 1000;
const MAX_ORBIT_DOTS = 6;

export function runningCount(ticket: Ticket | null | undefined): number {
  return ticket?.subagents?.filter((a) => a.status === "running").length ?? 0;
}

/** Re-renders every second while something is running, for the elapsed timers. */
function useNow(isActive: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [isActive]);
  return now;
}

function elapsed(run: SubagentRun, now: number): string {
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Main agent in the center, one orbiting dot per running sub-agent. */
function Orchestrator({ running }: { running: number }) {
  const reduce = useReducedMotion();
  const dots = Math.min(running, MAX_ORBIT_DOTS);
  return (
    <div className="relative size-14 shrink-0" aria-hidden>
      <span className="absolute inset-0 rounded-full border border-line" />
      {running > 0 && !reduce && (
        <motion.span className="absolute inset-0 rounded-full border border-accent/60" animate={{ scale: [1, 1.35], opacity: [0.7, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }} />
      )}
      <span className={`absolute inset-[38%] rounded-full ${running > 0 ? "bg-accent" : "bg-line-strong"}`} />
      <motion.div className="absolute inset-0" animate={reduce || dots === 0 ? undefined : { rotate: 360 }} transition={{ duration: 6, repeat: Infinity, ease: "linear" }}>
        {Array.from({ length: dots }, (_, i) => {
          const angle = (i / dots) * Math.PI * 2;
          return (
            <span
              key={i}
              className="absolute size-2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
              style={{ left: `calc(50% + ${Math.cos(angle) * 22}px - 4px)`, top: `calc(50% + ${Math.sin(angle) * 22}px - 4px)` }}
            />
          );
        })}
      </motion.div>
    </div>
  );
}

function StatusGlyph({ status }: { status: SubagentRun["status"] }) {
  const reduce = useReducedMotion();
  if (status === "done") return <span className="flex size-5 items-center justify-center rounded-full bg-ok/15 text-ok"><Check className="size-3" strokeWidth={3} /></span>;
  if (status === "failed") return <span className="flex size-5 items-center justify-center rounded-full bg-danger/15 text-danger"><X className="size-3" strokeWidth={3} /></span>;
  return (
    <span className="relative flex size-5 items-center justify-center">
      {!reduce && <motion.span className="absolute inset-0 rounded-full bg-accent/40" animate={{ scale: [0.6, 1.4], opacity: [0.8, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }} />}
      <span className="size-2 rounded-full bg-accent" />
    </span>
  );
}

function SubagentCard({ run, now }: { run: SubagentRun; now: number }) {
  const reduce = useReducedMotion();
  const isRunning = run.status === "running";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      className={`relative overflow-hidden rounded-xl border px-3 py-2.5 ${isRunning ? "border-accent/50 bg-accent-weak" : "border-line bg-surface"}`}
    >
      {isRunning && !reduce && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent/10 to-transparent"
          animate={{ x: ["-100%", "300%"] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <div className="relative flex items-center gap-2">
        <StatusGlyph status={run.status} />
        <p className="min-w-0 flex-1 truncate text-[13px]" title={run.label}>{run.label}</p>
        <span className="font-mono text-[10px] tabular-nums text-subtle">{elapsed(run, now)}</span>
      </div>
      <div className="relative mt-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted">
        <span className="max-w-[45%] shrink-0 truncate whitespace-nowrap rounded-full border border-line px-1.5 py-px">{run.agentType}</span>
        <motion.span key={run.toolCalls} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="shrink-0 whitespace-nowrap tabular-nums">
          {run.toolCalls} {run.toolCalls === 1 ? "ação" : "ações"}
        </motion.span>
        {run.lastActivity && <span className="min-w-0 truncate text-subtle" title={run.lastActivity}>· {run.lastActivity}</span>}
      </div>
    </motion.li>
  );
}

function headline(ticket: Ticket, running: number): string {
  const total = ticket.subagents?.length ?? 0;
  if (running > 0) return `${running} sub-agente${running > 1 ? "s" : ""} trabalhando em paralelo`;
  if (total > 0) return `${total} sub-agente${total > 1 ? "s" : ""} usado${total > 1 ? "s" : ""} nesta tarefa`;
  if (ticket.status === "running") return "Liberado · o agente decide se vale dividir a tarefa";
  return "Liberado para esta tarefa";
}

/** Live view of the sub-agents of the task in focus. Hidden when the task never used or allowed them. */
export function SubagentPanel() {
  const ticket = useFocusTicket();
  const running = runningCount(ticket);
  const now = useNow(running > 0);
  if (!ticket || (!ticket.multiAgent && !ticket.subagents?.length)) return null;
  const runs = ticket.subagents ?? [];
  const done = runs.filter((a) => a.status === "done").length;
  const failed = runs.filter((a) => a.status === "failed").length;
  return (
    <Panel
      eyebrow={`Multi-agentes · ${ticket.key}`}
      title={headline(ticket, running)}
      aside={<span className="font-mono text-[11px] text-muted">{running} rodando · {done} ok{failed ? ` · ${failed} falha${failed > 1 ? "s" : ""}` : ""}</span>}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex items-center gap-3 md:w-56 md:flex-col md:items-start">
          <Orchestrator running={running} />
          <p className="text-[12px] text-muted">
            O agente principal coordena: divide o trabalho, integra o que os sub-agentes entregam e roda os testes no final.
          </p>
        </div>
        {runs.length === 0 ? (
          <p className="flex flex-1 items-center gap-2 rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">
            <Network className="size-4 shrink-0" /> Nenhum sub-agente ainda. Tarefas pequenas ou muito acopladas costumam rodar com um agente só.
          </p>
        ) : (
          <ul className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-live="polite">
            <AnimatePresence initial={false}>
              {[...runs].reverse().map((run) => <SubagentCard key={run.id} run={run} now={now} />)}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </Panel>
  );
}
