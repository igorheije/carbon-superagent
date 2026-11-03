"use client";

import { useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, ChevronDown, Loader2, MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { Button } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { answerFromOption, optionsOf, pendingQuestionsOf } from "@/lib/domain/questions";
import type { AgentQuestion, QuestionOption, Ticket } from "@/lib/domain/types";

const MAX_ANSWER = 4_000;
const QUICK_APPROVE = "Aprovado. Pode seguir com o que você propôs.";

type Busy = { readonly kind: "option"; readonly index: number } | { readonly kind: "send" | "approve" } | null;

function OptionButton({ option, index, busy, onPick }: { option: QuestionOption; index: number; busy: Busy; onPick: () => void }) {
  const isBusy = busy?.kind === "option" && busy.index === index;
  return (
    <motion.button
      type="button"
      onClick={onPick}
      disabled={busy !== null}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, type: "spring", stiffness: 380, damping: 28 }}
      whileHover={busy === null ? { y: -2 } : undefined}
      whileTap={busy === null ? { scale: 0.98 } : undefined}
      className={`group relative flex min-h-[64px] flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:shadow-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 ${
        option.recommended ? "border-accent bg-accent-weak hover:border-accent" : "border-line bg-surface-sunken hover:border-line-strong"
      }`}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span className="text-[14px] font-medium leading-snug text-ink">{option.label}</span>
        {isBusy ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" />
        ) : option.recommended ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-accent/60 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent">
            <Sparkles className="size-3" /> recomendado
          </span>
        ) : null}
      </span>
      {option.detail && <span className="text-[12.5px] leading-snug text-muted">{option.detail}</span>}
    </motion.button>
  );
}

function QuestionCard({ ticket, question }: { ticket: Ticket; question: AgentQuestion }) {
  const options = optionsOf(question);
  const hasOptions = options.length > 0;
  const [answer, setAnswer] = useState("");
  const [isWriting, setIsWriting] = useState(!hasOptions);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (text: string, next: Exclude<Busy, null>) => {
    const trimmed = text.trim();
    if (!trimmed) return setError("escolha uma opção ou escreva uma resposta");
    setBusy(next);
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
      void send(answer, { kind: "send" });
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

      <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{question.text}</p>

      {hasOptions && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2" role="group" aria-label="Escolha uma resposta">
          {options.map((option, i) => (
            <OptionButton key={`${i}-${option.label}`} option={option} index={i} busy={busy} onPick={() => void send(answerFromOption(option), { kind: "option", index: i })} />
          ))}
        </div>
      )}

      {hasOptions && (
        <button
          type="button"
          onClick={() => setIsWriting((w) => !w)}
          aria-expanded={isWriting}
          aria-controls={fieldId}
          className="mt-3 flex items-center gap-1 font-mono text-[11px] text-muted hover:text-ink"
        >
          <ChevronDown className={`size-3.5 transition-transform ${isWriting ? "rotate-180" : ""}`} /> outra resposta
        </button>
      )}

      <AnimatePresence initial={false}>
        {isWriting && (
          <motion.div key="write" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <label htmlFor={fieldId} className="eyebrow mt-3 block">sua resposta</label>
            <textarea
              id={fieldId}
              value={answer}
              onChange={(e) => setAnswer(e.target.value.slice(0, MAX_ANSWER))}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder="ex.: leolegends/instagram, privado; e tire os vídeos do repo"
              disabled={busy !== null}
              className="scroll-thin mt-1.5 w-full rounded-xl border border-line bg-surface-sunken p-3 text-[13.5px] leading-relaxed outline-none focus:border-line-strong focus:shadow-[var(--ring)]"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="accent" onClick={() => void send(answer, { kind: "send" })} isLoading={busy?.kind === "send"} disabled={busy !== null}>
                <Send className="size-4" /> Responder e continuar
              </Button>
              {!hasOptions && (
                <Button variant="ghost" onClick={() => void send(QUICK_APPROVE, { kind: "approve" })} isLoading={busy?.kind === "approve"} disabled={busy !== null} title={`Envia: “${QUICK_APPROVE}”`}>
                  <CheckCheck className="size-4" /> Aprovar como proposto
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="mt-3 text-[12px] text-muted">
        {hasOptions ? "Um clique responde e a tarefa continua de onde parou, no mesmo worktree." : "A tarefa continua de onde parou, no mesmo worktree. ⌘/Ctrl + Enter envia."}
      </p>
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
