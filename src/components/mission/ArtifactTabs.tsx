"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useFocusTicket } from "@/components/engine/EngineProvider";
import { Panel } from "@/components/ui/Panel";
import type { Ticket } from "@/lib/domain/types";

type TabId = "diff" | "rag" | "review" | "tests";
const TABS: readonly { id: TabId; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "rag", label: "RAG" },
  { id: "review", label: "Review" },
  { id: "tests", label: "Testes" },
];

const fade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.2, ease: [0.2, 0, 0.2, 1] as const },
};

function DiffView({ ticket }: { ticket: Ticket }) {
  if (ticket.diff.length === 0) return <Empty text="O coder ainda não alterou arquivos." />;
  return (
    <ul className="flex flex-col gap-2">
      {ticket.diff.map((file, i) => (
        <motion.li key={file.path} {...fade} transition={{ ...fade.transition, delay: i * 0.05 }} className="overflow-hidden rounded-xl border border-line">
          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-muted px-3 py-1.5 font-mono text-[11px]">
            <span className="truncate">{file.path}</span>
            <span className="shrink-0">
              <span className="text-ok">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
            </span>
          </div>
          <pre className="scroll-thin overflow-x-auto bg-surface-sunken px-3 py-2 font-mono text-[11.5px] leading-[1.6]">
            {file.snippet.map((line, j) => (
              <div key={j} className={line.startsWith("+") ? "text-ok" : line.startsWith("-") ? "text-danger" : "text-muted"}>
                {line}
              </div>
            ))}
          </pre>
        </motion.li>
      ))}
    </ul>
  );
}

function RagView({ ticket }: { ticket: Ticket }) {
  if (ticket.hits.length === 0) return <Empty text="O researcher consulta a base depois do plano." />;
  return (
    <ul className="flex flex-col gap-2">
      {ticket.hits.map((hit, i) => (
        <motion.li key={hit.id} {...fade} transition={{ ...fade.transition, delay: i * 0.05 }} className="rounded-xl border border-line p-3">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="rounded-full border border-line px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-subtle">{hit.kind}</span>
            <span className="truncate text-muted">{hit.ref}</span>
            <span className="ml-auto text-ink">{hit.score.toFixed(2)}</span>
          </div>
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-line">
            <motion.div
              className="h-full origin-left bg-accent"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: hit.score }}
              transition={{ duration: 0.7, ease: [0.2, 0, 0.2, 1], delay: 0.1 + i * 0.05 }}
            />
          </div>
          <p className="mt-2 truncate font-mono text-[11.5px] text-muted">{hit.excerpt}</p>
        </motion.li>
      ))}
    </ul>
  );
}

function ReviewView({ ticket }: { ticket: Ticket }) {
  if (ticket.findings.length === 0) return <Empty text="Reviewer e security-reviewer rodam depois dos testes." />;
  return (
    <ul className="flex flex-col gap-2">
      {ticket.findings.map((finding, i) => (
        <motion.li key={`${finding.text}-${i}`} {...fade} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
          <span
            className={`w-16 shrink-0 font-mono text-[10px] tracking-[0.08em] ${
              finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "text-danger" : "text-muted"
            }`}
          >
            {finding.severity}
          </span>
          <span className={`text-[13px] ${finding.resolved ? "text-subtle line-through" : ""}`}>{finding.text}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-subtle">{finding.resolved ? "resolvido" : "aberto"}</span>
        </motion.li>
      ))}
    </ul>
  );
}

function TestsView({ ticket }: { ticket: Ticket }) {
  const tests = ticket.tests;
  if (!tests) return <Empty text="O tester escreve testes antes de rodar a suíte." />;
  const ratio = tests.passing / tests.total;
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const isGreen = tests.passing === tests.total;
  return (
    <motion.div {...fade} className="flex items-center gap-6">
      <svg viewBox="0 0 110 110" className="size-28 -rotate-90">
        <circle cx={55} cy={55} r={radius} fill="none" stroke="var(--border)" strokeWidth={6} />
        <motion.circle
          cx={55}
          cy={55}
          r={radius}
          fill="none"
          stroke={isGreen ? "var(--ok)" : "var(--warn)"}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={false}
          animate={{ strokeDashoffset: circumference * (1 - ratio) }}
          transition={{ duration: 0.8, ease: [0.2, 0, 0.2, 1] }}
        />
      </svg>
      <div>
        <p className="text-[32px] font-semibold tracking-[-0.03em]">
          {tests.passing}/{tests.total}
        </p>
        <p className="font-mono text-[11px] text-muted">{tests.added} testes novos · {isGreen ? "suíte verde" : "corrigindo falha"}</p>
      </div>
    </motion.div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-[13px] text-muted">{text}</p>;
}

export function ArtifactTabs() {
  const ticket = useFocusTicket();
  const [tab, setTab] = useState<TabId>("diff");
  return (
    <Panel
      eyebrow="Artefatos do ticket"
      title={ticket ? ticket.key : "—"}
      aside={
        <div role="tablist" className="flex gap-1 font-mono text-[11px]">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`relative rounded-full px-2.5 py-1 transition-colors ${tab === t.id ? "text-ink" : "text-muted hover:text-ink"}`}
            >
              {tab === t.id && <motion.span layoutId="artifact-tab" className="absolute inset-0 rounded-full border border-line bg-surface-muted" />}
              <span className="relative">[ {t.label} ]</span>
            </button>
          ))}
        </div>
      }
    >
      <div className="min-h-[220px]">
        {!ticket && <Empty text="Nenhum ticket em foco." />}
        {ticket && (
          <AnimatePresence mode="wait">
            <motion.div key={`${tab}-${ticket.id}`} {...fade}>
              {tab === "diff" && <DiffView ticket={ticket} />}
              {tab === "rag" && <RagView ticket={ticket} />}
              {tab === "review" && <ReviewView ticket={ticket} />}
              {tab === "tests" && <TestsView ticket={ticket} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </Panel>
  );
}
