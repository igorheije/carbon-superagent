"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, Crosshair, X } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { pipelineProgress, stageInsight } from "@/lib/domain/pipeline-insight";
import { STAGE_META } from "@/lib/domain/stages";
import { STAGES, type AgentStatus, type LogLevel, type StageId } from "@/lib/domain/types";

const LOG_TONE: Readonly<Record<LogLevel, string>> = {
  info: "text-muted",
  tool: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  think: "text-subtle italic",
};
const LOG_GLYPH: Readonly<Record<LogLevel, string>> = { info: "·", tool: "$", ok: "✓", warn: "!", think: "∴" };
const STATUS_LABEL: Readonly<Record<AgentStatus, string>> = { idle: "aguardando", working: "trabalhando agora", done: "concluído" };
const VISIBLE_LOGS = 40;
/** Closing should feel instant; the entrance can take its time. */
const EXIT_S = 0.16;

const activeStageOf = (agents: Readonly<Record<StageId, AgentStatus>>): StageId =>
  STAGES.find((s) => agents[s] === "working") ?? [...STAGES].reverse().find((s) => agents[s] === "done") ?? "intake";

function TrackNode({ stage, index, status, isSelected, onSelect }: { stage: StageId; index: number; status: AgentStatus; isSelected: boolean; onSelect: () => void }) {
  const shouldReduce = useReducedMotion();
  const meta = STAGE_META[stage];
  const isWorking = status === "working";
  const isDone = status === "done";
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      aria-label={`${meta.label}: ${STATUS_LABEL[status]}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: isWorking && !shouldReduce ? [0, -4, 0] : 0 }}
      transition={isWorking && !shouldReduce ? { y: { duration: 1.8, repeat: Infinity, ease: "easeInOut" }, opacity: { delay: index * 0.05 } } : { delay: index * 0.05, type: "spring", stiffness: 300, damping: 24 }}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.97 }}
      className={`relative flex min-w-[104px] flex-1 flex-col items-start rounded-2xl border px-3 py-3 text-left outline-none transition-colors focus-visible:shadow-[var(--ring)] ${
        isWorking ? "border-accent bg-accent-weak" : isDone ? "border-line-strong bg-surface" : "border-line bg-surface"
      }`}
    >
      {isSelected && (
        <motion.span
          layoutId="pipeline-selected"
          className="absolute -inset-1 rounded-[20px] border-2 border-accent"
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        />
      )}
      {isWorking && !shouldReduce && (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-2xl bg-accent/20 blur-md"
          animate={{ opacity: [0.2, 0.7, 0.2] }}
          transition={{ duration: 1.6, repeat: Infinity }}
        />
      )}
      <span className="relative font-mono text-[9.5px] uppercase tracking-[0.08em] text-subtle">
        {String(index + 1).padStart(2, "0")} {meta.agent}
      </span>
      <span className="relative mt-1 flex w-full items-center justify-between gap-2 text-[15px] font-medium">
        {meta.label}
        {isDone ? (
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 520, damping: 16 }} className="text-accent">
            <Check className="size-4" strokeWidth={2.4} />
          </motion.span>
        ) : (
          <span className={`size-2 rounded-full ${isWorking ? "animate-pulse bg-accent shadow-[0_0_10px_var(--accent)]" : "bg-line-strong"}`} />
        )}
      </span>
    </motion.button>
  );
}

function Connector({ isFlowing, isDone }: { isFlowing: boolean; isDone: boolean }) {
  const shouldReduce = useReducedMotion();
  return (
    <span aria-hidden className="relative hidden h-px w-6 shrink-0 self-center overflow-visible bg-line-strong md:block">
      <motion.span className="absolute inset-0 origin-left bg-accent" initial={false} animate={{ scaleX: isDone || isFlowing ? 1 : 0, opacity: isDone ? 0.5 : 1 }} />
      {isFlowing && !shouldReduce && (
        <motion.span
          className="absolute -top-[3px] size-[7px] rounded-full bg-accent shadow-[0_0_10px_var(--accent)]"
          animate={{ x: [-4, 24], opacity: [0, 1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
    </span>
  );
}

function Detail({ stage, status }: { stage: StageId; status: AgentStatus }) {
  const ticket = useFocusTicket();
  const meta = STAGE_META[stage];
  const insight = stageInsight(ticket, stage);
  const logs = insight.logs.slice(-VISIBLE_LOGS);
  const metrics = [
    { label: "eventos", value: insight.events },
    { label: "comandos", value: insight.tools },
    { label: "avisos", value: insight.warnings },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="flex flex-col gap-4">
        <div>
          <p className="eyebrow">{meta.agent} · {STATUS_LABEL[status]}</p>
          <h3 className="mt-1 text-[26px] font-semibold tracking-[-0.02em]">{meta.label}</h3>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">{meta.description}</p>
        </div>
        <dl className="grid grid-cols-3 gap-2">
          {metrics.map((m, i) => (
            <motion.div
              key={m.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="rounded-xl border border-line bg-surface-sunken px-3 py-2"
            >
              <dt className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-subtle">{m.label}</dt>
              <dd className={`text-[22px] font-semibold tabular-nums ${m.label === "avisos" && m.value > 0 ? "text-warn" : ""}`}>{m.value}</dd>
            </motion.div>
          ))}
        </dl>
        {insight.highlights.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {insight.highlights.map((h, i) => (
              <motion.li
                key={`${i}-${h}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.04 * i }}
                className="truncate rounded-lg border border-line px-2.5 py-1.5 font-mono text-[11.5px] text-ink"
                title={h}
              >
                {h}
              </motion.li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex min-h-[220px] flex-col rounded-2xl border border-line bg-surface-sunken">
        <p className="eyebrow border-b border-line px-3 py-2">log desta etapa{ticket ? ` · ${ticket.key}` : ""}</p>
        <ol className="scroll-thin flex max-h-[320px] flex-1 flex-col gap-0.5 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
          {logs.length === 0 && <li className="text-subtle">{ticket ? "nada registrado nesta etapa ainda" : "nenhuma tarefa em foco"}</li>}
          {logs.map((line) => (
            <motion.li key={line.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className={`grid grid-cols-[14px_minmax(0,1fr)] gap-2 ${LOG_TONE[line.level]}`}>
              <span aria-hidden>{LOG_GLYPH[line.level]}</span>
              <span className="break-words">{line.text}</span>
            </motion.li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function PipelineModal({ initialStage, onClose }: { readonly initialStage: StageId | null; readonly onClose: () => void }) {
  const { state } = useEngine();
  const ticket = useFocusTicket();
  const { agents } = state;
  const [selected, setSelected] = useState<StageId>(initialStage ?? activeStageOf(agents));
  const [isFollowing, setIsFollowing] = useState(initialStage === null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const active = activeStageOf(agents);
  const shown = isFollowing ? active : selected;
  const index = STAGES.indexOf(shown);
  const progress = pipelineProgress(STAGES.map((s) => agents[s]));

  const pick = (stage: StageId) => {
    setSelected(stage);
    setIsFollowing(false);
  };
  const step = (delta: number) => pick(STAGES[(index + delta + STAGES.length) % STAGES.length] as StageId);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <motion.div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-3 md:items-center md:p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: EXIT_S } }}>
      <button type="button" aria-label="Fechar" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-modal-title"
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98, transition: { duration: EXIT_S, ease: [0.4, 0, 1, 1] } }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        className="relative w-full max-w-6xl overflow-hidden rounded-3xl border border-line-strong bg-bg p-5 shadow-[var(--shadow-md)] md:p-7"
      >
        <motion.span aria-hidden className="absolute inset-x-0 top-0 h-[2px] origin-left bg-accent" initial={{ scaleX: 0 }} animate={{ scaleX: progress }} transition={{ type: "spring", stiffness: 120, damping: 24 }} />
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent" aria-hidden /> pipeline de agentes · {Math.round(progress * 100)}%</p>
            <h2 id="pipeline-modal-title" className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em]">
              {ticket ? `${ticket.key} — ${ticket.title}` : "Nenhuma tarefa em foco"}
            </h2>
            {ticket?.model && <p className="mt-0.5 font-mono text-[11px] text-subtle">{ticket.model} · {ticket.status}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsFollowing((f) => !f)}
              aria-pressed={isFollowing}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors ${isFollowing ? "border-accent bg-accent-weak text-ink" : "border-line text-muted hover:text-ink"}`}
            >
              <Crosshair className="size-3.5" /> seguir etapa ativa
            </button>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Fechar pipeline expandido" className="rounded-full border border-line p-2 text-muted outline-none hover:text-ink focus-visible:shadow-[var(--ring)]">
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="scroll-thin -mx-1 mt-6 flex items-stretch gap-2 overflow-x-auto px-1 pb-2 pt-1 md:gap-0">
          {STAGES.map((stage, i) => (
            <div key={stage} className="flex flex-1 items-stretch">
              {i > 0 && <Connector isFlowing={agents[stage] === "working" && state.running} isDone={agents[stage] === "done"} />}
              <TrackNode stage={stage} index={i} status={agents[stage]} isSelected={stage === shown} onSelect={() => pick(stage)} />
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button type="button" onClick={() => step(-1)} className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 font-mono text-[11px] text-muted hover:text-ink">
            <ChevronLeft className="size-3.5" /> anterior
          </button>
          <p className="font-mono text-[10.5px] text-subtle">← → navegam · esc fecha</p>
          <button type="button" onClick={() => step(1)} className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 font-mono text-[11px] text-muted hover:text-ink">
            próxima <ChevronRight className="size-3.5" />
          </button>
        </div>

        <div className="relative mt-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={shown} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22, ease: [0.2, 0, 0.2, 1] }}>
              <Detail stage={shown} status={agents[shown]} />
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.section>
    </motion.div>,
    document.body,
  );
}
