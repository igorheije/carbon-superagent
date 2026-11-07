"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import { DeviceArt } from "./DeviceArt";
import { activityOf, bytes, cycleSeconds, DEVICE_LABEL, duration, efficiencyVerdict, pct, STALE_TELEMETRY_MS, type LoadNode, type LoadView } from "./load-model";

/** Live enough to watch tasks move without hammering the panel. */
const REFRESH_MS = 5_000;

const TONE = { ok: "text-ok", warn: "text-warn", muted: "text-subtle" } as const;

/** Packets travelling from the panel to a machine, one per running task. */
function Link({ running, activity }: { readonly running: number; readonly activity: number }) {
  const prefersReduced = useReducedMotion();
  const dur = cycleSeconds(activity) * 1.2;
  return (
    <div className="relative hidden h-px flex-1 bg-line md:block" aria-hidden>
      {!prefersReduced &&
        Array.from({ length: Math.min(running, 6) }, (_, i) => (
          <motion.span
            key={i}
            className="absolute -top-[3px] size-[7px] rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
            initial={{ left: "0%", opacity: 0 }}
            animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
            transition={{ duration: dur, delay: (i * dur) / Math.max(1, running), repeat: Infinity, ease: "linear" }}
          />
        ))}
    </div>
  );
}

function Meter({ label, value, hint }: { readonly label: string; readonly value: number | null; readonly hint: string }) {
  const width = `${Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}%`;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-wide text-subtle">
        {label}
        <span className="text-[11px] normal-case tracking-normal text-muted tabular-nums">{hint}</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <motion.span className="block h-full rounded-full bg-accent" initial={false} animate={{ width }} transition={{ duration: 0.6 }} />
      </span>
    </div>
  );
}

function NodeCard({ node, local, now }: { readonly node: LoadNode; readonly local: LoadNode | undefined; readonly now: number }) {
  const t = node.telemetry;
  const isStale = !t || now - t.receivedAt > STALE_TELEMETRY_MS;
  const isOffline = node.status === "offline";
  const activity = activityOf(node, now);
  const verdict = efficiencyVerdict(node, local);
  const memShare = t && t.memTotalBytes > 0 ? t.memUsedBytes / t.memTotalBytes : null;
  const s = node.stats;

  return (
    <motion.article layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex flex-col gap-3 rounded-xl border p-4 ${node.isLocal ? "border-line-strong bg-surface" : "border-line bg-surface-muted"}`}>
      <header className="flex items-start gap-3">
        <DeviceArt kind={node.device} activity={activity} isWorking={s.running > 0} isOffline={isOffline} label={`${DEVICE_LABEL[node.device]} ${node.name}`} />
        <div className="flex min-w-0 flex-col gap-0.5 pt-1">
          <span className="eyebrow">{node.isLocal ? "Painel" : DEVICE_LABEL[node.device]}</span>
          <h3 className="truncate text-[15px] font-medium" title={node.name}>{node.name}</h3>
          <span className="truncate font-mono text-[11px] text-muted">{t ? `${t.osLabel} · ${t.cpus} CPUs · ${t.arch}` : "sem telemetria (worker antigo ou offline)"}</span>
          <span className={`font-mono text-[11px] ${TONE[verdict.tone]}`}>{verdict.label}</span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Meter label="CPU" value={t && !isStale ? t.cpuPercent / 100 : null} hint={t && !isStale ? `${t.cpuPercent.toFixed(0)}% · load ${t.load1}` : "—"} />
        <Meter label="Memória" value={memShare} hint={t ? `${bytes(t.memUsedBytes)} / ${bytes(t.memTotalBytes)}` : "—"} />
        <Meter label="Slots" value={s.running / Math.max(1, node.slots)} hint={`${s.running}/${node.slots} rodando`} />
        <Meter label="Utilização 24 h" value={node.utilization} hint={pct(node.utilization)} />
      </div>

      <dl className="grid grid-cols-3 gap-2 border-t border-line pt-3 font-mono text-[11px]">
        <div><dt className="text-subtle">concluídas</dt><dd className="text-[14px] tabular-nums text-ink">{s.done}</dd></div>
        <div><dt className="text-subtle">tempo médio</dt><dd className="text-[14px] tabular-nums text-ink">{duration(s.avgDoneMs)}</dd></div>
        <div><dt className="text-subtle">sucesso</dt><dd className="text-[14px] tabular-nums text-ink">{pct(s.successRate)}</dd></div>
      </dl>
    </motion.article>
  );
}

/** Stacked bar: who delivered the finished tasks in the window. */
function ShareBar({ nodes }: { readonly nodes: readonly LoadNode[] }) {
  const withShare = nodes.filter((n) => (n.shareOfDone ?? 0) > 0);
  if (withShare.length === 0) return <p className="font-mono text-[11px] text-subtle">Nenhuma tarefa concluída nas últimas 24 h ainda.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={withShare.map((n) => `${n.name} ${pct(n.shareOfDone)}`).join(", ")}>
        {withShare.map((n, i) => (
          <motion.span key={n.id} className="h-full" style={{ background: "var(--accent)", opacity: 1 - i * 0.28 }} initial={false} animate={{ width: pct(n.shareOfDone, 1) }} transition={{ duration: 0.6 }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        {withShare.map((n, i) => (
          <li key={n.id} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: "var(--accent)", opacity: 1 - i * 0.28 }} aria-hidden />
            {n.name} · {pct(n.shareOfDone)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Configurações → Máquinas → Carga: live view of how the work is spread across machines. */
export function LoadPanel() {
  const [view, setView] = useState<LoadView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    const load = () =>
      api<LoadView>("/api/admin/workers/load")
        .then((d) => {
          if (!isActive) return;
          setView(d);
          setError(null);
        })
        .catch((e: unknown) => isActive && setError(e instanceof Error ? e.message : "falha ao carregar a carga"));
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      isActive = false;
      clearInterval(id);
    };
  }, []);

  const local = view?.nodes.find((n) => n.isLocal);
  const remote = view?.nodes.filter((n) => !n.isLocal) ?? [];
  const now = view?.generatedAt ?? 0;
  const running = view?.nodes.reduce((sum, n) => sum + n.stats.running, 0) ?? 0;

  return (
    <Panel eyebrow="Carga" title={view === null ? "Carregando…" : `${running} tarefa${running === 1 ? "" : "s"} rodando em ${view.nodes.length} máquina${view.nodes.length === 1 ? "" : "s"}`}>
      {error && <p role="alert" className="mb-3 font-mono text-[12px] text-danger">{error}</p>}
      {view && local && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
            <div className="md:w-[340px] md:shrink-0"><NodeCard node={local} local={local} now={now} /></div>
            <div className="flex flex-1 flex-col gap-4">
              {remote.length === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-center text-[12px] text-muted">Nenhum worker no cluster. Use “Entrar no cluster” para adicionar servidores.</p>}
              {remote.map((node) => (
                <div key={node.id} className="flex items-center gap-3">
                  <Link running={node.stats.running} activity={activityOf(node, now)} />
                  <div className="w-full md:w-[340px] md:shrink-0"><NodeCard node={node} local={local} now={now} /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="eyebrow">Quem entregou nas últimas 24 h</span>
            <ShareBar nodes={view.nodes} />
          </div>
        </div>
      )}
    </Panel>
  );
}
