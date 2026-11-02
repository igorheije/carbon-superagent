"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Command, CornerDownLeft } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";

interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

function usePaletteItems(close: () => void): readonly PaletteItem[] {
  const { state, dispatch } = useEngine();
  const router = useRouter();
  return useMemo(() => {
    const go = (href: string) => () => {
      router.push(href);
      close();
    };
    const queued = state.tickets
      .filter((t) => t.status === "queued")
      .map((t) => ({
        id: `run-${t.id}`,
        label: `Priorizar ${t.key} — ${t.title}`,
        hint: "fila",
        run: () => {
          dispatch({ type: "prioritize", ticketId: t.id });
          close();
        },
      }));
    return [
      ...queued,
      { id: "toggle", label: state.running ? "Pausar motor" : "Retomar motor", hint: "motor", run: () => { dispatch({ type: "toggle" }); close(); } },
      {
        id: "mode",
        label: state.acceptMode === "observe" ? "Mudar para modo act" : "Voltar para modo observe",
        hint: "policy",
        run: () => { dispatch({ type: "setAcceptMode", mode: state.acceptMode === "observe" ? "act" : "observe" }); close(); },
      },
      { id: "nav-home", label: "Ir para Mission Control", hint: "navegar", run: go("/") },
      { id: "nav-kb", label: "Ir para Conhecimento (RAG)", hint: "navegar", run: go("/knowledge") },
      { id: "nav-learn", label: "Ir para Aprendizado", hint: "navegar", run: go("/learning") },
      { id: "nav-int", label: "Ir para Integrações", hint: "navegar", run: go("/integrations") },
    ];
  }, [state.tickets, state.running, state.acceptMode, dispatch, router, close]);
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useMemo(() => () => { setIsOpen(false); setQuery(""); setIndex(0); }, []);
  const items = usePaletteItems(close);
  const filtered = items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((open) => !open);
      }
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") filtered[index]?.run();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-ink sm:inline-flex"
      >
        <Command className="size-3" /> K · comandos
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[14vh] backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.div
              role="dialog"
              aria-label="Paleta de comandos"
              data-ascii="surface" className="card w-full max-w-xl overflow-hidden shadow-[var(--shadow-md)]"
              initial={{ y: -12, scale: 0.98, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -8, scale: 0.98, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
                onKeyDown={onInputKey}
                placeholder="Rodar tarefa, mudar modo, navegar…"
                className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-subtle"
              />
              <ul className="scroll-thin max-h-80 overflow-y-auto p-1.5" role="listbox">
                {filtered.map((item, i) => (
                  <li key={item.id} role="option" aria-selected={i === index}>
                    <button
                      type="button"
                      onMouseEnter={() => setIndex(i)}
                      onClick={item.run}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] ${i === index ? "bg-surface-muted text-ink" : "text-muted"}`}
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
                        {item.hint}
                        {i === index && <CornerDownLeft className="size-3" />}
                      </span>
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">Nada encontrado.</li>}
              </ul>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
