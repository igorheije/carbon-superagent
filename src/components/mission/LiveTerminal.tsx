"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import { Cpu } from "lucide-react";
import type { LogLevel } from "@/lib/domain/types";

/** Always-visible "agent · model · effort" for the ticket in focus (planned while queued). */
function ExecutionBadge({ label, isPlanned, isDemo, hasTicket }: { label: string | null; isPlanned: boolean; isDemo: boolean; hasTicket: boolean }) {
  if (!hasTicket) return null;
  const parts = label ? label.split(" · ") : [];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Modelo e esforço desta execução">
      <Cpu className="size-3.5 text-accent" strokeWidth={1.8} />
      {parts.length > 0 ? (
        parts.map((part, i) => (
          <span
            key={`${part}-${i}`}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${i === 0 ? "border-line text-muted" : "border-accent/50 bg-accent-weak text-ink"}`}
          >
            {part}
          </span>
        ))
      ) : (
        <span className="font-mono text-[11px] text-subtle">{isDemo ? "simulação · sem modelo real" : "modelo não registrado (tarefa anterior a esta versão)"}</span>
      )}
      {isPlanned && parts.length > 0 && <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">planejado</span>}
    </div>
  );
}

const VISIBLE_LINES = 80;

const LEVEL_STYLE: Readonly<Record<LogLevel, { glyph: string; className: string }>> = {
  info: { glyph: "·", className: "text-muted" },
  tool: { glyph: "$", className: "text-ink" },
  think: { glyph: "∴", className: "italic text-subtle" },
  ok: { glyph: "✓", className: "text-ok" },
  warn: { glyph: "!", className: "text-warn" },
};

export function LiveTerminal() {
  const ticket = useFocusTicket();
  const { state, mode } = useEngine();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = ticket?.logs.slice(-VISIBLE_LINES) ?? [];
  const lastId = lines.at(-1)?.id;
  const isLive = ticket?.status === "running" && state.running;

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [lastId]);

  return (
    <Panel
      eyebrow="Sessão do agente"
      title={ticket ? `${ticket.key} — ${ticket.title}` : "Aguardando ticket"}
      aside={
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          <span className={`size-1.5 rounded-full ${isLive ? "bg-accent" : "bg-line-strong"}`} />
          {isLive ? "ao vivo" : "parado"}
        </span>
      }
    >
      <ExecutionBadge label={ticket?.model ?? null} isPlanned={ticket?.status === "queued"} isDemo={mode === "demo"} hasTicket={ticket !== null} />
      <div
        ref={scrollRef}
        className="scroll-thin h-[340px] overflow-y-auto rounded-xl border border-line bg-surface-sunken p-3 font-mono text-[12px] leading-[1.7]"
        aria-live="polite"
        aria-relevant="additions"
      >
        {lines.length === 0 && <p className="text-subtle">Nenhum evento ainda. O motor pega o próximo ticket da fila.</p>}
        <AnimatePresence initial={false}>
          {lines.map((line) => {
            const style = LEVEL_STYLE[line.level];
            return (
              <motion.p
                key={line.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0.2, 1] }}
                className="flex gap-2"
              >
                <span className="w-16 shrink-0 text-subtle">{line.stage}</span>
                <span className={`w-3 shrink-0 ${style.className}`}>{style.glyph}</span>
                <span className={`min-w-0 break-words ${style.className}`}>{line.text}</span>
              </motion.p>
            );
          })}
        </AnimatePresence>
        {isLive && (
          <motion.span
            className="ml-[92px] inline-block h-3.5 w-[7px] translate-y-0.5 bg-accent"
            animate={{ opacity: [1, 0, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          />
        )}
      </div>
    </Panel>
  );
}
