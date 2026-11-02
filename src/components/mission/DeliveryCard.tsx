"use client";

import { AnimatePresence, motion } from "motion/react";
import { GitPullRequest } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";

export function DeliveryCard() {
  const ticket = useFocusTicket();
  const { state } = useEngine();
  const pr = ticket?.pr ?? null;
  const pendingLessons = state.lessons.filter((l) => l.status === "candidate").length;

  return (
    <Panel eyebrow="Entrega · outbox" title="Pull request">
      <AnimatePresence mode="wait">
        {pr && ticket ? (
          <motion.div
            key={pr.number}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            className="relative overflow-hidden rounded-xl border border-line-strong p-4"
          >
            <motion.span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-[var(--accent-weak)] to-transparent"
              initial={{ x: "-100%" }}
              animate={{ x: "250%" }}
              transition={{ duration: 1.1, ease: [0.2, 0, 0.2, 1] }}
            />
            <div className="relative flex items-center gap-2">
              <GitPullRequest className="size-4 text-accent" strokeWidth={1.8} />
              <span className="text-[20px] font-semibold tracking-[-0.02em]">#{pr.number}</span>
              <span className="ml-auto rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                {pr.draft ? "draft · observe" : "pronto p/ review"}
              </span>
            </div>
            <p className="relative mt-2 text-[13px]">{ticket.title}</p>
            <p className="relative mt-1 font-mono text-[11px] text-muted">
              {ticket.repo} · {pr.branch} → main
            </p>
            <p className="relative mt-3 text-[12px] leading-snug text-muted">
              Merge é humano. O agente comentou no {ticket.source === "linear" ? "Linear" : "GitHub"} e moveu para In Review.
            </p>
          </motion.div>
        ) : (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[13px] text-muted">
            O PR aparece aqui quando review termina sem CRITICAL/HIGH abertos.
          </motion.p>
        )}
      </AnimatePresence>
      <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-line px-3 py-2.5">
        <span className="text-[12px] text-muted">Lições aguardando você</span>
        <span className={`font-mono text-[13px] ${pendingLessons ? "text-accent" : "text-subtle"}`}>{pendingLessons}</span>
      </div>
    </Panel>
  );
}
