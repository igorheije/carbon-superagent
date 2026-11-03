"use client";

import { useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, MessageCircleQuestion, Send } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { Button } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { pendingQuestionsOf } from "@/lib/domain/questions";
import type { AgentQuestion, Ticket } from "@/lib/domain/types";

const MAX_ANSWER = 4_000;
const QUICK_APPROVE = "Aprovado. Pode seguir com o que você propôs.";

function QuestionCard({ ticket, question }: { ticket: Ticket; question: AgentQuestion }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<"send" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (text: string, kind: "send" | "approve") => {
    const trimmed = text.trim();
    if (!trimmed) return setError("escreva uma resposta ou use “Aprovar”");
    setBusy(kind);
    setError(null);
    try {
      await api(`/api/tasks/${ticket.id}/questions`, { body: { questionId: question.id, answer: trimmed } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao enviar a resposta");
      setBusy(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send(answer, "send");
    }
  };

  const fieldId = `answer-${ticket.id}-${question.id}`;
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      role="alertdialog"
      aria-labelledby={`${fieldId}-title`}
      className="relative overflow-hidden rounded-2xl border border-accent/60 bg-surface p-5 shadow-[var(--shadow-md)]"
    >
      <motion.span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-accent/50 text-accent">
          <MessageCircleQuestion className="size-4.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p id={`${fieldId}-title`} className="eyebrow">
            {ticket.key} · o agente precisa de uma decisão · etapa {question.stage}
          </p>
          <p className="mt-1 text-[15px] font-medium">{ticket.title}</p>
        </div>
        {question.askedAt && <span className="font-mono text-[10px] text-subtle">{new Date(question.askedAt).toLocaleTimeString("pt-BR")}</span>}
      </div>
      <div className="scroll-thin mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-sunken p-3.5 text-[13.5px] leading-relaxed text-ink">
        {question.text}
      </div>
      <label htmlFor={fieldId} className="eyebrow mt-4 block">sua resposta</label>
      <textarea
        id={fieldId}
        value={answer}
        onChange={(e) => setAnswer(e.target.value.slice(0, MAX_ANSWER))}
        onKeyDown={onKeyDown}
        rows={3}
        placeholder="ex.: aprova, mas mantenha o README em inglês"
        disabled={busy !== null}
        className="scroll-thin mt-1.5 w-full rounded-xl border border-line bg-surface-sunken p-3 text-[13.5px] leading-relaxed outline-none focus:border-line-strong focus:shadow-[var(--ring)]"
      />
      <p className="mt-2 text-[12px] text-muted">
        A tarefa continua de onde parou, no mesmo worktree, com a sua resposta. Nada recomeça do zero. ⌘/Ctrl + Enter envia.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="accent" onClick={() => void send(answer, "send")} isLoading={busy === "send"} disabled={busy !== null}>
          <Send className="size-4" /> Responder e continuar
        </Button>
        <Button variant="ghost" onClick={() => void send(QUICK_APPROVE, "approve")} isLoading={busy === "approve"} disabled={busy !== null} title={`Envia: “${QUICK_APPROVE}”`}>
          <CheckCheck className="size-4" /> Aprovar como proposto
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 font-mono text-[12px] text-danger">{error}</p>}
    </motion.article>
  );
}

/** Every task stopped on a question, across the queue: answering resumes it. */
export function QuestionPanel() {
  const { mode, state } = useEngine();
  if (mode !== "live") return null;
  const waiting = state.tickets.flatMap((ticket) => pendingQuestionsOf(ticket).map((question) => ({ ticket, question })));
  if (waiting.length === 0) return null;
  return (
    <section aria-label="Perguntas do agente" className="flex flex-col gap-3">
      <AnimatePresence>
        {waiting.map(({ ticket, question }) => (
          <QuestionCard key={`${ticket.id}-${question.id}`} ticket={ticket} question={question} />
        ))}
      </AnimatePresence>
    </section>
  );
}
