"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2 } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { pipelineProgress } from "@/lib/domain/pipeline-insight";
import { STAGES, type StageId } from "@/lib/domain/types";
import { PipelineGraph } from "./PipelineGraph";
import { PipelineModal } from "./PipelineModal";

/** Pipeline card: live graph, overall progress and the expanded, interactive view. */
export function PipelineSection() {
  const { state } = useEngine();
  const [open, setOpen] = useState<{ stage: StageId | null } | null>(null);
  const progress = pipelineProgress(STAGES.map((s) => state.agents[s]));
  return (
    <section data-ascii="surface" className="card p-4 md:p-5" aria-labelledby="pipeline-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p id="pipeline-heading" className="eyebrow flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden /> Pipeline de agentes
        </p>
        <div className="flex items-center gap-3">
          <p className="hidden font-mono text-[10px] uppercase tracking-[0.08em] text-subtle sm:block">intake → reflect · {Math.round(progress * 100)}%</p>
          <button
            type="button"
            onClick={() => setOpen({ stage: null })}
            className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 font-mono text-[10.5px] text-muted outline-none transition-colors hover:border-accent hover:text-ink focus-visible:shadow-[var(--ring)]"
          >
            <Maximize2 className="size-3" /> expandir
          </button>
        </div>
      </div>
      <div className="mb-1 h-[2px] overflow-hidden rounded-full bg-line" aria-hidden>
        <motion.div className="h-full origin-left bg-accent" initial={false} animate={{ scaleX: progress }} transition={{ type: "spring", stiffness: 120, damping: 24 }} />
      </div>
      <PipelineGraph onSelect={(stage) => setOpen({ stage })} />
      <AnimatePresence>{open && <PipelineModal key="pipeline-modal" initialStage={open.stage} onClose={() => setOpen(null)} />}</AnimatePresence>
    </section>
  );
}
