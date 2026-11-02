"use client";

import { useEffect, useState } from "react";
import { AsciiReveal } from "ascii-reveal";
import { motion } from "motion/react";
import { api } from "@/lib/client/api";
import { STAGE_META } from "@/lib/domain/stages";
import { STAGES } from "@/lib/domain/types";
import { HELMET_MASCOT } from "./CheckList";

export interface IndexStatus {
  readonly phase: "idle" | "scanning" | "graph" | "summary" | "done" | "error";
  readonly done: number;
  readonly total: number;
  readonly message: string;
}

export interface KbOverview {
  readonly fileCount: number;
  readonly edgeCount: number;
  readonly languages: readonly { readonly lang: string; readonly files: number }[];
  readonly stack: readonly string[];
  readonly hubs: readonly { readonly path: string; readonly inDegree: number }[];
  readonly aiSummary: string | null;
  readonly indexedAt: string;
}

const PHASE_LABEL: Readonly<Record<IndexStatus["phase"], string>> = {
  idle: "aguardando",
  scanning: "lendo arquivos",
  graph: "ligando imports no grafo",
  summary: "IA lendo o projeto (somente leitura)",
  done: "base de conhecimento pronta",
  error: "falhou ao indexar",
};
const POLL_MS = 700;
const BUSY: ReadonlySet<IndexStatus["phase"]> = new Set(["scanning", "graph", "summary"]);

/** Polls the indexer while it works. `version` restarts polling (e.g. after "reindexar"). */
export function useIndexStatus(version = 0) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [overview, setOverview] = useState<KbOverview | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let isAlive = true;
    let idleTicks = 0;
    const tick = async () => {
      try {
        const data = await api<{ status: IndexStatus; overview: KbOverview | null }>("/api/knowledge/status");
        if (!isAlive) return;
        setStatus(data.status);
        setOverview(data.overview);
        idleTicks = data.status.phase === "idle" ? idleTicks + 1 : 0;
        // Keep polling while busy, and briefly while a just-started job may still be "idle".
        if (BUSY.has(data.status.phase) || idleTicks < 6) timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (isAlive) timer = setTimeout(() => void tick(), POLL_MS * 3);
      }
    };
    void tick();
    return () => {
      isAlive = false;
      if (timer) clearTimeout(timer);
    };
  }, [version]);
  return { status, overview };
}

export function IndexProgress({ status, overview }: { readonly status: IndexStatus | null; readonly overview: KbOverview | null }) {
  const phase = status?.phase ?? "idle";
  const isBusy = BUSY.has(phase) || (phase === "idle" && !overview);
  const scanRatio = status && status.total > 0 ? status.done / status.total : 0;
  const ratio = phase === "done" ? 1 : phase === "summary" ? 0.9 : phase === "graph" ? 0.8 : phase === "scanning" ? 0.05 + scanRatio * 0.7 : overview ? 1 : 0.03;
  return (
    <div className="card w-full p-5" data-ascii="surface">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${phase === "error" ? "bg-danger" : "bg-accent"}`} /> Base de conhecimento
        </p>
        <p className={`font-mono text-[11px] ${phase === "error" ? "text-danger" : "text-muted"}`}>{phase === "idle" && overview ? "pronta" : PHASE_LABEL[phase]}</p>
      </div>
      <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-line">
        <motion.div className={`h-full origin-left ${phase === "error" ? "bg-danger" : "bg-accent"}`} animate={{ scaleX: ratio }} transition={{ duration: 0.5, ease: [0.2, 0, 0.2, 1] }} />
      </div>
      <p className="mt-2 truncate font-mono text-[11px] text-subtle">{status?.message || (overview ? `indexado em ${new Date(overview.indexedAt).toLocaleString("pt-BR")}` : "preparando…")}</p>
      <AsciiReveal loading={isBusy} mascot={HELMET_MASCOT} revealOnMount={false} className="mt-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Arquivos", overview?.fileCount ?? "—"],
            ["Conexões", overview?.edgeCount ?? "—"],
            ["Linguagens", overview?.languages.slice(0, 2).map((l) => l.lang).join(", ") || "—"],
            ["Stack", overview?.stack.slice(0, 3).join(", ") || "—"],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-line p-3">
              <dt className="eyebrow">{label}</dt>
              <dd className="mt-1 truncate font-mono text-[13px]">{String(value)}</dd>
            </div>
          ))}
        </dl>
        {overview?.aiSummary && (
          <p className="mt-3 line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-muted">{overview.aiSummary.replace(/[#*`]/g, "")}</p>
        )}
      </AsciiReveal>
    </div>
  );
}

/** Success moment: agents boot in sequence while the project gets mapped. */
export function Launch({ name }: { readonly name: string }) {
  const { status, overview } = useIndexStatus();
  return (
    <div className="flex flex-col items-start gap-6">
      <p className="eyebrow">Pronto</p>
      <h2 className="text-[clamp(36px,6vw,64px)] font-semibold leading-[1] tracking-[-0.04em]">Bem-vindo, {name.split(" ")[0]}</h2>
      <ol className="grid w-full grid-cols-4 gap-2 sm:grid-cols-8">
        {STAGES.map((stage, i) => (
          <motion.li
            key={stage}
            initial={{ opacity: 0.25, borderColor: "var(--border)" }}
            animate={{ opacity: 1, borderColor: "var(--accent)" }}
            transition={{ delay: 0.25 + i * 0.16, duration: 0.3 }}
            className="relative overflow-hidden rounded-xl border bg-surface p-2.5"
          >
            <motion.span aria-hidden className="absolute inset-0 bg-accent-weak" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} style={{ originX: 0 }} transition={{ delay: 0.25 + i * 0.16, duration: 0.35, ease: [0.2, 0, 0.2, 1] }} />
            <p className="relative font-mono text-[9px] uppercase tracking-[0.08em] text-subtle">{STAGE_META[stage].agent}</p>
            <p className="relative text-[13px] font-medium">{STAGE_META[stage].label}</p>
          </motion.li>
        ))}
      </ol>
      <IndexProgress status={status} overview={overview} />
      <p className="max-w-xl text-[14px] text-muted">
        Enquanto o projeto é mapeado, você já pode abrir o Mission Control. Com a base pronta, o research de cada tarefa parte dos arquivos certos em vez de explorar o repositório inteiro.
      </p>
    </div>
  );
}
