"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Gauge } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { computeEfficiency, formatDuration, type Rate } from "@/lib/domain/efficiency";

const GOOD = 0.8;
const FAIR = 0.5;
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

const tone = (v: number | null): { text: string; bar: string } =>
  v === null ? { text: "text-subtle", bar: "bg-line-strong" } : v >= GOOD ? { text: "text-ok", bar: "bg-accent" } : v >= FAIR ? { text: "text-warn", bar: "bg-warn" } : { text: "text-danger", bar: "bg-danger" };

const percent = (n: number): string => `${Math.round(n * 100)}%`;

interface RateTile {
  readonly label: string;
  readonly rate: Rate;
  readonly detail: (r: Rate) => string;
  readonly definition: string;
}

function Tile({ tile, index }: { tile: RateTile; index: number }) {
  const { value } = tile.rate;
  const colors = tone(value);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      title={tile.definition}
      className="flex min-w-0 flex-col gap-2 bg-surface px-4 py-3.5"
    >
      <dt className="eyebrow truncate">{tile.label}</dt>
      <dd className={`text-[26px] font-semibold leading-none tracking-[-0.03em] ${colors.text}`}>
        {value === null ? <span className="text-[15px] font-normal text-subtle">sem dados</span> : <AnimatedNumber value={value} format={percent} />}
      </dd>
      <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
        <motion.div className={`h-full origin-left ${colors.bar}`} initial={{ scaleX: 0 }} animate={{ scaleX: value ?? 0 }} transition={{ type: "spring", stiffness: 120, damping: 22 }} />
      </div>
      <p className="truncate font-mono text-[10.5px] text-subtle">{value === null ? "—" : tile.detail(tile.rate)}</p>
    </motion.div>
  );
}

function UsefulnessRing({ value, parts, finished }: { value: number | null; parts: number; finished: number }) {
  const shouldReduce = useReducedMotion();
  const colors = tone(value);
  const offset = RING_C * (1 - (value ?? 0));
  return (
    <div className="flex items-center gap-4 bg-surface px-4 py-4" title="Média simples das métricas ao lado que já têm dados.">
      <svg viewBox="0 0 100 100" className="size-[92px] shrink-0 -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={RING_R} fill="none" stroke="var(--border)" strokeWidth="8" />
        <motion.circle
          cx="50"
          cy="50"
          r={RING_R}
          fill="none"
          stroke={value === null ? "var(--border-strong)" : value >= GOOD ? "var(--accent)" : value >= FAIR ? "var(--warn)" : "var(--danger)"}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          initial={{ strokeDashoffset: RING_C }}
          animate={{ strokeDashoffset: offset }}
          transition={shouldReduce ? { duration: 0 } : { type: "spring", stiffness: 60, damping: 18 }}
        />
      </svg>
      <div className="min-w-0">
        <p className="eyebrow">índice de utilidade</p>
        <p className={`mt-1 text-[34px] font-semibold leading-none tracking-[-0.03em] ${colors.text}`}>
          {value === null ? <span className="text-[16px] font-normal text-subtle">sem dados</span> : <AnimatedNumber value={value} format={percent} />}
        </p>
        <p className="mt-1.5 font-mono text-[10.5px] text-subtle">
          {value === null ? "termine uma tarefa para medir" : `média de ${parts} métricas · ${finished} tarefa(s) terminadas`}
        </p>
      </div>
    </div>
  );
}

export function EfficiencyBar() {
  const { state } = useEngine();
  const [isOpen, setIsOpen] = useState(false);
  const m = computeEfficiency(state.tickets);

  const tiles: readonly RateTile[] = [
    { label: "Sucesso", rate: m.success, detail: (r) => `${r.part} de ${r.whole} concluídas`, definition: "Tarefas concluídas ÷ tarefas terminadas (concluídas + falhas)." },
    { label: "Entrega", rate: m.delivery, detail: (r) => `${r.part} de ${r.whole} viraram commit/PR`, definition: "Tarefas concluídas que deixaram commit ou PR ÷ tarefas concluídas." },
    { label: "Autonomia", rate: m.autonomy, detail: (r) => `${r.part} de ${r.whole} sem intervenção`, definition: "Tarefas terminadas sem nenhuma pergunta respondida nem permissão decidida por uma pessoa." },
    { label: "Plano cumprido", rate: m.plan, detail: (r) => `${r.part} de ${r.whole} passos`, definition: "Passos do plano confirmados pelo agente ÷ passos planejados, nas tarefas concluídas." },
    { label: "Testes verdes", rate: m.tests, detail: (r) => `${r.part} de ${r.whole} testes`, definition: "Testes passando ÷ testes executados, no último resultado de cada tarefa." },
    { label: "Revisão limpa", rate: m.review, detail: (r) => `${r.part} de ${r.whole} críticos/altos resolvidos`, definition: "Achados CRITICAL e HIGH da revisão marcados como resolvidos ÷ todos os CRITICAL e HIGH." },
  ];
  const efficiency = [
    { label: "tempo médio", value: m.avgRunSeconds === null ? null : formatDuration(m.avgRunSeconds) },
    { label: "custo médio", value: m.avgCostUsd === null ? null : `US$ ${m.avgCostUsd.toFixed(2)}` },
    { label: "tokens médios", value: m.avgTokens === null ? null : `${Math.round(m.avgTokens / 100) / 10}k` },
    { label: "intervenções/tarefa", value: m.interventionsPerTask === null ? null : m.interventionsPerTask.toFixed(1) },
  ];

  return (
    <section aria-labelledby="efficiency-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p id="efficiency-heading" className="eyebrow flex items-center gap-1.5"><Gauge className="size-3.5" /> Eficácia do agente</p>
        <button type="button" onClick={() => setIsOpen((o) => !o)} aria-expanded={isOpen} className="flex items-center gap-1 font-mono text-[10.5px] text-muted hover:text-ink">
          como calculamos <ChevronDown className={`size-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>
      </div>
      <div className="grid grid-cols-1 overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-[minmax(260px,1.1fr)_3fr_minmax(200px,1fr)]" style={{ gap: 1 }}>
        <UsefulnessRing value={m.usefulness} parts={m.usefulnessParts} finished={m.finished} />
        <dl className="grid grid-cols-2 bg-line sm:grid-cols-3" style={{ gap: 1 }}>
          {tiles.map((tile, i) => <Tile key={tile.label} tile={tile} index={i} />)}
        </dl>
        <dl className="grid grid-cols-2 content-center gap-x-4 gap-y-2.5 bg-surface px-4 py-3.5 lg:grid-cols-1" title="Médias das tarefas terminadas que registraram esse dado (tempo e custo: tarefas rodadas a partir desta versão).">
          <p className="eyebrow col-span-full">eficiência</p>
          {efficiency.map((e) => (
            <div key={e.label} className="flex items-baseline justify-between gap-2">
              <dt className="font-mono text-[10.5px] text-subtle">{e.label}</dt>
              <dd className={`font-mono text-[13px] tabular-nums ${e.value === null ? "text-subtle" : "text-ink"}`}>{e.value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.ul key="defs" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="grid gap-1 overflow-hidden rounded-xl border border-dashed border-line px-4 py-3 text-[12px] leading-relaxed text-muted sm:grid-cols-2">
            {tiles.map((t) => <li key={t.label}><b className="text-ink">{t.label}:</b> {t.definition}</li>)}
            <li><b className="text-ink">Índice de utilidade:</b> média simples das métricas que já têm dados. Sem pesos escondidos.</li>
            <li><b className="text-ink">Base:</b> as tarefas do projeto carregadas no painel. Tempo e custo existem só para tarefas rodadas a partir desta versão; custo vem do Claude Code.</li>
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
  );
}
