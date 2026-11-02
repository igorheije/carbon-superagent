"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, CornerDownRight, HelpCircle } from "lucide-react";
import { useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import type { PlanStep } from "@/lib/domain/types";

function StepIcon({ step }: { readonly step: PlanStep }) {
  if (step.state === "skipped") {
    return (
      <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line-strong" title="Pulado de propósito">
        <CornerDownRight className="size-3 text-muted" strokeWidth={2.5} />
      </span>
    );
  }
  if (step.state === "unconfirmed") {
    return (
      <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border border-warn/70" title="O agente não confirmou">
        <HelpCircle className="size-3 text-warn" strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span className="relative mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line-strong">
      <motion.span className="absolute inset-0 rounded-full bg-ink" initial={false} animate={{ scale: step.done ? 1 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 28 }} />
      {step.done && <Check className="relative size-3 text-bg" strokeWidth={3} />}
    </span>
  );
}

export function PlanPanel() {
  const ticket = useFocusTicket();
  const steps = ticket?.plan ?? [];
  const doneCount = steps.filter((s) => s.done).length;
  const skipped = steps.filter((s) => s.state === "skipped").length;
  const unconfirmed = steps.filter((s) => s.state === "unconfirmed").length;
  return (
    <Panel
      eyebrow="Plano · critérios de aceite"
      title="Passos"
      aside={
        <span className="font-mono text-[11px] text-muted" title="feitos / total">
          {steps.length ? `${doneCount}/${steps.length}` : "—"}
          {skipped > 0 && <span className="text-subtle"> · {skipped} pulado{skipped > 1 ? "s" : ""}</span>}
          {unconfirmed > 0 && <span className="text-warn"> · {unconfirmed} sem confirmação</span>}
        </span>
      }
    >
      {steps.length === 0 && <p className="text-[13px] text-muted">O planner escreve os passos depois do intake.</p>}
      <ol className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {steps.map((step, i) => (
            <motion.li
              key={step.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.28, ease: [0.2, 0, 0.2, 1] }}
              className="flex items-start gap-2.5 rounded-lg px-1 py-1.5"
            >
              <StepIcon step={step} />
              <span className="min-w-0">
                <span className={`block text-[13px] leading-snug transition-colors duration-300 ${step.done || step.state === "skipped" ? "text-muted" : "text-ink"} ${step.state === "skipped" ? "line-through decoration-line-strong" : ""}`}>
                  {step.text}
                </span>
                {step.note && <span className={`mt-0.5 block font-mono text-[10.5px] leading-snug ${step.state === "unconfirmed" ? "text-warn" : "text-subtle"}`}>{step.note}</span>}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </Panel>
  );
}
