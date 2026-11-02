"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import type { Lesson } from "@/lib/domain/types";

const LOOP = [
  { n: "01", title: "Sinal", text: "Teste que falhou, review pedindo mudança, diff humano no PR." },
  { n: "02", title: "Lição candidata", text: "learner escreve: quando X, fazer Y — com evidência e escopo." },
  { n: "03", title: "Promoção humana", text: "Você promove ou descarta. Nada se autopromove." },
  { n: "04", title: "Volta ao RAG", text: "Lição promovida pesa no ranking do próximo ticket." },
] as const;

function LessonRow({ lesson }: { lesson: Lesson }) {
  const { dispatch } = useEngine();
  const isCandidate = lesson.status === "candidate";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: lesson.status === "discarded" ? 0.45 : 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className={`rounded-xl border p-4 ${isCandidate ? "border-accent/50" : "border-line"}`}
    >
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="text-ink">{lesson.id}</span>
        <span className="text-subtle">de {lesson.ticketKey}</span>
        <span
          className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
            isCandidate ? "border-accent/60 text-accent" : "border-line text-muted"
          }`}
        >
          {lesson.status === "candidate" ? "candidata" : lesson.status === "promoted" ? "promovida" : "descartada"}
        </span>
      </div>
      <p className={`mt-2 text-[14px] leading-snug ${lesson.status === "discarded" ? "line-through" : ""}`}>{lesson.rule}</p>
      <p className="mt-1.5 font-mono text-[11px] text-muted">evidência: {lesson.evidence}</p>
      <p className="font-mono text-[11px] text-subtle">escopo: {lesson.scope}</p>
      <div className="mt-3 flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">confiança</span>
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-line">
          <motion.div
            className="h-full origin-left bg-ink"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: lesson.confidence }}
            transition={{ duration: 0.8, ease: [0.2, 0, 0.2, 1] }}
          />
        </div>
        <span className="font-mono text-[11px]">{Math.round(lesson.confidence * 100)}%</span>
      </div>
      {isCandidate && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "promote", lessonId: lesson.id })}
            className="inline-flex items-center gap-1.5 rounded-full bg-btn px-3.5 py-1.5 text-[12px] font-medium text-btn-text transition-transform active:scale-[0.975]"
          >
            <Check className="size-3.5" /> Promover
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "discard", lessonId: lesson.id })}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12px] text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <X className="size-3.5" /> Descartar
          </button>
        </div>
      )}
    </motion.li>
  );
}

export default function LearningPage() {
  const { state } = useEngine();
  const order: Readonly<Record<Lesson["status"], number>> = { candidate: 0, promoted: 1, discarded: 2 };
  const lessons = [...state.lessons].sort((a, b) => order[a.status] - order[b.status]);
  const candidates = lessons.filter((l) => l.status === "candidate").length;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <section className="flex flex-col gap-2">
        <p className="eyebrow">Autoaprendizado supervisionado</p>
        <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Aprendizado</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
          O agente propõe. Você promove. Lições viram contexto do próximo ticket — e só depois de passar por você.
        </p>
      </section>

      <ol className="grid grid-cols-1 overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 1 }}>
        {LOOP.map((step, i) => (
          <motion.li
            key={step.n}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08, duration: 0.3, ease: [0.2, 0, 0.2, 1] }}
            className="bg-surface p-4"
          >
            <p className="font-mono text-[11px] text-accent">{step.n}</p>
            <p className="mt-2 text-[15px] font-medium">{step.title}</p>
            <p className="mt-1 text-[13px] leading-snug text-muted">{step.text}</p>
          </motion.li>
        ))}
      </ol>

      <Panel
        eyebrow="Lições"
        title={`${lessons.length} no total`}
        aside={<span className={`font-mono text-[11px] ${candidates ? "text-accent" : "text-muted"}`}>{candidates} aguardando você</span>}
      >
        {lessons.length === 0 && <p className="text-[13px] text-muted">Nenhuma lição ainda.</p>}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <AnimatePresence>
            {lessons.map((lesson) => (
              <LessonRow key={lesson.id} lesson={lesson} />
            ))}
          </AnimatePresence>
        </ul>
      </Panel>
    </div>
  );
}
