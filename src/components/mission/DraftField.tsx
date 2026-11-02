"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Sparkles, Square, Undo2 } from "lucide-react";

type DraftEvent =
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "status"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

interface DraftFieldProps {
  readonly title: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly executor: "claude" | "codex";
}

/** Reads the NDJSON stream from /api/tasks/draft line by line. */
async function* readEvents(response: Response): AsyncGenerator<DraftEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          yield JSON.parse(line) as DraftEvent;
        } catch {
          // ignore a malformed line; the final event carries the full text anyway
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
}

/**
 * Description textarea with "Gerar com IA": writes context + acceptance criteria from the
 * task title, the project index and the team's promoted lessons, streaming as it writes.
 */
export function DraftField({ title, value, onChange, executor }: DraftFieldProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const canGenerate = title.trim().length >= 3 && !isGenerating;
  const hasText = value.trim().length > 0;

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const before = value;
    setPrevious(before);
    setIsGenerating(true);
    setError(null);
    setStatus("preparando contexto…");
    let text = "";
    try {
      const response = await fetch("/api/tasks/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes: before, executor }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `erro ${response.status}`);
      }
      for await (const event of readEvents(response)) {
        if (event.type === "reset") text = "";
        else if (event.type === "delta") {
          text += event.text;
          onChange(text);
        } else if (event.type === "status") setStatus(event.text);
        else if (event.type === "final" && event.text) onChange(event.text);
        else if (event.type === "error") setError(event.message);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "falha ao gerar");
    } finally {
      setIsGenerating(false);
      setStatus(null);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();
  const undo = () => {
    if (previous === null) return;
    onChange(previous);
    setPrevious(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="task-desc" className="eyebrow">Contexto e critérios de aceite</label>
        <div className="flex items-center gap-2">
          {previous !== null && !isGenerating && (
            <button type="button" onClick={undo} className="flex items-center gap-1 font-mono text-[11px] text-muted hover:text-ink">
              <Undo2 className="size-3" /> desfazer
            </button>
          )}
          {isGenerating ? (
            <button type="button" onClick={stop} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted hover:text-ink">
              <Square className="size-3" /> parar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={!canGenerate}
              title={canGenerate ? "Usa o que fazer + base de conhecimento + lições promovidas" : "Escreva o que fazer primeiro"}
              className="flex items-center gap-1.5 rounded-full border border-accent/60 bg-accent-weak px-3 py-1 font-mono text-[11px] text-ink transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="size-3 text-accent" /> {hasText ? "refinar com IA" : "gerar com IA"}
            </button>
          )}
        </div>
      </div>
      <div className="relative">
        <textarea
          id="task-desc"
          rows={9}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={isGenerating}
          aria-busy={isGenerating}
          placeholder="Onde fica, como deve se comportar, como validar… ou clique em “gerar com IA”."
          className={`scroll-thin w-full rounded-xl border bg-surface-sunken p-3.5 text-[13.5px] leading-relaxed outline-none transition-colors focus:border-line-strong focus:shadow-[var(--ring)] ${isGenerating ? "border-accent/60" : "border-line"}`}
        />
        {isGenerating && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-x-3 bottom-2 h-[2px] origin-left rounded-full bg-accent"
            animate={{ scaleX: [0.1, 1, 0.1], opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>
      <AnimatePresence mode="wait">
        {error ? (
          <motion.p key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert" className="font-mono text-[11px] text-danger">{error}</motion.p>
        ) : status ? (
          <motion.p key={status} initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="truncate font-mono text-[11px] text-muted">
            <span className="text-accent">●</span> {status}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
