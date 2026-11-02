"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { Button } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import type { PermissionPrompt, Ticket } from "@/lib/domain/types";

type Choice = "allow" | "allow_always" | "allow_task" | "deny";

const STATUS_LABEL: Readonly<Record<PermissionPrompt["status"], string>> = {
  pending: "pendente",
  allowed: "permitido",
  denied: "negado",
  expired: "expirou",
};

function PendingCard({ ticket, prompt }: { ticket: Ticket; prompt: PermissionPrompt }) {
  const [busy, setBusy] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: Choice) => {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/tasks/${ticket.id}/permissions`, { body: { requestId: prompt.id, decision } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao responder");
      setBusy(null);
    }
  };
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      role="alertdialog"
      aria-label={`Permissão pedida: ${prompt.tool}`}
      className="relative overflow-hidden rounded-2xl border border-warn/60 bg-surface p-5 shadow-[var(--shadow-md)]"
    >
      <motion.span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-warn" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-warn/50 text-warn">
          <ShieldAlert className="size-4.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{ticket.key} · o agente pede permissão</p>
          <p className="mt-1 text-[16px] font-medium">
            <span className="font-mono text-[14px] text-warn">{prompt.tool}</span> — {prompt.summary}
          </p>
        </div>
        <span className="font-mono text-[10px] text-subtle">{new Date(prompt.askedAt).toLocaleTimeString("pt-BR")}</span>
      </div>
      {prompt.detail && (
        <pre className="scroll-thin mt-3 max-h-56 overflow-auto rounded-xl border border-line bg-surface-sunken p-3 font-mono text-[12px] leading-relaxed text-ink">
          {prompt.detail}
        </pre>
      )}
      <p className="mt-3 text-[12px] text-muted">
        A execução fica parada até você responder. Sem resposta, o pedido é negado automaticamente. Ações de baixo risco dentro do projeto já são aprovadas sozinhas (política em Configurações → Execução).
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="accent" onClick={() => void answer("allow")} isLoading={busy === "allow"} disabled={busy !== null}>
          <ShieldCheck className="size-4" /> Permitir
        </Button>
        <Button variant="ghost" onClick={() => void answer("allow_always")} isLoading={busy === "allow_always"} disabled={busy !== null} title="Salva uma regra: não pergunta mais isso neste repositório">
          Sempre neste repositório
        </Button>
        <Button variant="ghost" onClick={() => void answer("allow_task")} isLoading={busy === "allow_task"} disabled={busy !== null} title="Não pergunta mais nada até esta tarefa terminar (bloqueios de segurança continuam)">
          Liberar tudo nesta tarefa
        </Button>
        <Button variant="ghost" onClick={() => void answer("deny")} isLoading={busy === "deny"} disabled={busy !== null} className="hover:border-danger hover:text-danger">
          <ShieldX className="size-4" /> Negar
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 font-mono text-[12px] text-danger">{error}</p>}
    </motion.article>
  );
}

/** Pending prompts on top (blocking), decided ones as a compact history. */
export function PermissionPanel() {
  const { mode } = useEngine();
  const ticket = useFocusTicket();
  if (mode !== "live" || !ticket?.permissions?.length) return null;
  const pending = ticket.permissions.filter((p) => p.status === "pending");
  const autoCount = ticket.permissions.filter((p) => p.auto && p.status === "allowed").length;
  const history = ticket.permissions.filter((p) => p.status !== "pending" && !(p.auto && p.status === "allowed")).slice(-6).reverse();
  return (
    <section aria-label="Permissões do agente" className="flex flex-col gap-3">
      <AnimatePresence>
        {pending.map((p) => (
          <PendingCard key={p.id} ticket={ticket} prompt={p} />
        ))}
      </AnimatePresence>
      {(history.length > 0 || autoCount > 0) && (
        <ul className="flex flex-wrap gap-2">
          {autoCount > 0 && (
            <li className="flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted" title="Ações de baixo risco dentro do projeto, regras salvas ou tarefa liberada">
              <span className="text-ok">{autoCount}</span> aprovadas automaticamente
            </li>
          )}
          {history.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted">
              <span className={p.status === "allowed" ? "text-ok" : p.status === "denied" ? "text-danger" : "text-subtle"}>{STATUS_LABEL[p.status]}</span>
              <span className="text-ink">{p.tool}</span>
              <span className="max-w-[260px] truncate">{p.summary}</span>
              {p.decidedBy && <span className="text-subtle">· {p.decidedBy}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
