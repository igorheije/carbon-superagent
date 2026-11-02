"use client";

import { useEngine } from "@/components/engine/EngineProvider";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";

interface Kpi {
  readonly label: string;
  readonly value: number;
  readonly suffix?: string;
  readonly format?: (n: number) => string;
}

const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k` : Math.round(n).toString();

export function KpiStrip() {
  const { state } = useEngine();
  const { metrics, lessons, tickets } = state;
  const avgEvents = metrics.ticksPerTicket.length
    ? metrics.ticksPerTicket.reduce((a, b) => a + b, 0) / metrics.ticksPerTicket.length
    : 0;
  const kpis: readonly Kpi[] = [
    { label: "Tickets entregues", value: metrics.completed, suffix: `/${tickets.length}` },
    { label: "PRs abertos", value: metrics.prsOpened },
    { label: "Tokens consumidos", value: metrics.tokens, format: compact },
    { label: "Eventos por ticket", value: avgEvents },
    { label: "Lições promovidas", value: lessons.filter((l) => l.status === "promoted").length },
  ];
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-5" style={{ gap: 1 }}>
      {kpis.map((kpi) => (
        <div key={kpi.label} className="bg-surface px-4 py-4">
          <dt className="eyebrow">{kpi.label}</dt>
          <dd className="mt-2 text-[30px] font-semibold leading-none tracking-[-0.03em]">
            <AnimatedNumber value={kpi.value} format={kpi.format} />
            {kpi.suffix && <span className="text-[16px] font-normal text-subtle">{kpi.suffix}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
