"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, MessageCircleQuestion, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { PlacementBadge } from "@/components/mission/PlacementBadge";
import { api } from "@/lib/client/api";
import { hasNewAlert, pendingAlertsOf, type PendingAlert } from "./pending-alerts";

/** Alerts shown at once; the rest are summarized ("+N"). */
const MAX_VISIBLE = 3;

function PermissionActions({ alert }: { readonly alert: Extract<PendingAlert, { kind: "permission" }> }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = alert.id.split(":").at(-1) ?? "";
  const answer = async (decision: "allow" | "deny") => {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/tasks/${alert.ticket.id}/permissions`, { body: { requestId, decision } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao responder");
      setBusy(null);
    }
  };
  const button = "inline-flex items-center gap-1 rounded-full px-3 py-1 font-mono text-[11px] transition-colors disabled:opacity-50";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <button type="button" disabled={busy !== null} onClick={() => void answer("allow")} className={`${button} bg-accent text-accent-ink`}>
        <ShieldCheck className="size-3.5" /> {busy === "allow" ? "permitindo…" : "permitir"}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => void answer("deny")} className={`${button} border border-line text-muted hover:text-ink`}>
        <ShieldX className="size-3.5" /> {busy === "deny" ? "negando…" : "negar"}
      </button>
      <Link href="/" className={`${button} text-muted underline-offset-2 hover:text-ink hover:underline`}>mais opções</Link>
      {error && <p role="alert" className="w-full font-mono text-[10px] text-danger">{error}</p>}
    </div>
  );
}

function AlertCard({ alert }: { readonly alert: PendingAlert }) {
  const isPermission = alert.kind === "permission";
  const Icon = isPermission ? ShieldAlert : MessageCircleQuestion;
  return (
    <motion.article
      layout
      initial={{ opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      role="alert"
      className="relative w-full overflow-hidden rounded-2xl border border-warn/60 bg-surface p-3.5 shadow-[var(--shadow-md)]"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-warn" />
      <div className="flex items-start gap-2.5 pl-1">
        <Icon className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
            <span>{alert.ticket.key} · {isPermission ? "pede permissão" : "tem uma pergunta"}</span>
            {(alert.ticket.runtime ?? "local") !== "local" && <PlacementBadge ticket={alert.ticket} />}
          </p>
          {isPermission ? (
            <p className="mt-1 line-clamp-2 text-[13px]" title={alert.summary}>
              <span className="font-mono text-[12px] text-warn">{alert.tool}</span> — {alert.summary}
            </p>
          ) : (
            <p className="mt-1 line-clamp-3 text-[13px]" title={alert.text}>{alert.text}</p>
          )}
          {isPermission ? (
            <PermissionActions alert={alert} />
          ) : (
            <Link href="/" className="mt-2 inline-flex rounded-full bg-accent px-3 py-1 font-mono text-[11px] text-accent-ink">responder</Link>
          )}
        </div>
      </div>
    </motion.article>
  );
}

/**
 * Fixed on every page (bottom-right): permissions and questions an agent is blocked on, from any
 * machine. Can be minimized; a new request opens it again so it is never silently missed.
 */
export function PendingAlerts() {
  const { state, mode } = useEngine();
  const reduce = useReducedMotion();
  const alerts = useMemo(() => (mode === "live" ? pendingAlertsOf(state.tickets) : []), [mode, state.tickets]);
  const [isMinimized, setIsMinimized] = useState(false);
  const seen = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (hasNewAlert(seen.current, alerts)) setIsMinimized(false);
    seen.current = new Set(alerts.map((a) => a.id));
  }, [alerts]);

  if (alerts.length === 0) return null;
  const visible = alerts.slice(0, MAX_VISIBLE);
  const hidden = alerts.length - visible.length;
  const label = `${alerts.length} ${alerts.length === 1 ? "agente precisa" : "agentes precisam"} de você`;

  return (
    <aside aria-label="Pedidos dos agentes" className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(380px,calc(100vw-2rem))] flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setIsMinimized((v) => !v)}
        aria-expanded={!isMinimized}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-warn/60 bg-surface px-3 py-1.5 font-mono text-[11px] text-warn shadow-[var(--shadow-md)]"
      >
        <motion.span animate={reduce ? undefined : { scale: [1, 1.18, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
          <ShieldAlert className="size-3.5" />
        </motion.span>
        {label}
        <ChevronDown className={`size-3.5 transition-transform ${isMinimized ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {!isMinimized && (
          <motion.div key="stack" className="pointer-events-auto flex w-full flex-col gap-2" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            <AnimatePresence initial={false}>
              {visible.map((alert) => <AlertCard key={alert.id} alert={alert} />)}
            </AnimatePresence>
            {hidden > 0 && (
              <Link href="/" className="self-end rounded-full border border-line bg-surface px-3 py-1 font-mono text-[11px] text-muted hover:text-ink">
                +{hidden} {hidden === 1 ? "outro pedido" : "outros pedidos"} no mission control
              </Link>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
