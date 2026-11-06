"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Ban, Cloud, Download, Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import { MachineDialog } from "./MachineDialog";
import { relativeTime, STATUS_DOT, STATUS_LABEL, type Machine } from "./machines-model";

/** The list is refreshed this often so status and "última batida" stay current. */
const REFRESH_MS = 15_000;

function MachineRow({ machine, now, onRevoke }: { readonly machine: Machine; readonly now: number; readonly onRevoke: (m: Machine) => void }) {
  const isRevoked = machine.status === "revoked";
  const tasks = machine.currentTasks.map((t) => t.key).join(", ");
  return (
    <motion.tr layout className={`border-t border-line ${isRevoked ? "opacity-55" : ""}`}>
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
          <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[machine.status]}`} aria-hidden />
          {STATUS_LABEL[machine.status]}
        </span>
      </td>
      <td className="max-w-[220px] truncate py-2.5 pr-3 text-[13px]" title={machine.name}>{machine.name}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">{machine.kind === "pool" ? "pool" : "agentcore"}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">{machine.version ?? "—"}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted" title={machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString("pt-BR") : undefined}>{relativeTime(machine.lastSeenAt, now)}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px]">{tasks || <span className="text-subtle">—</span>}</td>
      <td className="py-2.5 text-right">
        {!isRevoked && (
          <button type="button" onClick={() => onRevoke(machine)} aria-label={`Revogar ${machine.name}`} className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] text-muted hover:text-danger">
            <Ban className="size-3.5" /> revogar
          </button>
        )}
      </td>
    </motion.tr>
  );
}

function EmptyState({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <Server className="size-6 text-subtle" />
      <p className="text-[14px]">Nenhuma máquina ainda</p>
      <p className="max-w-md text-[12px] text-muted">Adicione um servidor ou cluster para rodar tarefas fora desta máquina. O painel gera o kit (Docker Compose ou Kubernetes) com o token já configurado.</p>
      <Button variant="accent" onClick={onAdd}><Plus className="size-4" /> Adicionar máquina</Button>
    </div>
  );
}

/** Configurações → Máquinas: fleet (FLT-01), "Adicionar máquina" (SET-04), revoke and the AgentCore kit. */
export function MachinesTab() {
  const [machines, setMachines] = useState<readonly Machine[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const load = useCallback(() => {
    api<{ workers: Machine[] }>("/api/admin/workers")
      .then((d) => {
        setMachines(d.workers);
        setNow(Date.now());
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao carregar as máquinas"));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const revoke = (machine: Machine) => {
    const warning = machine.currentTasks.length > 0 ? `\n\nEla está rodando ${machine.currentTasks.map((t) => t.key).join(", ")}: a tarefa vai falhar quando o lease expirar.` : "";
    if (!window.confirm(`Revogar "${machine.name}"? O token deixa de valer na hora e a máquina para de receber tarefas.${warning}`)) return;
    api(`/api/admin/workers/${encodeURIComponent(machine.id)}/revoke`, { method: "POST" })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao revogar"));
  };

  const active = machines?.filter((m) => m.status !== "revoked").length ?? 0;
  const openDialog = () => setIsDialogOpen(true);
  const closeDialog = useCallback(() => setIsDialogOpen(false), []);

  return (
    <div className="flex flex-col gap-5">
      <Panel
        eyebrow="Máquinas"
        title={machines === null ? "Carregando…" : `${active} ativa${active === 1 ? "" : "s"}`}
        aside={machines && machines.length > 0 ? <Button variant="accent" onClick={openDialog}><Plus className="size-4" /> Adicionar máquina</Button> : undefined}
      >
        {error && <p role="alert" className="mb-3 font-mono text-[12px] text-danger">{error}</p>}
        {machines !== null && machines.length === 0 && <EmptyState onAdd={openDialog} />}
        {machines !== null && machines.length > 0 && (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="eyebrow">
                  <th className="pb-2 pr-3 font-normal">Status</th>
                  <th className="pb-2 pr-3 font-normal">Nome</th>
                  <th className="pb-2 pr-3 font-normal">Tipo</th>
                  <th className="pb-2 pr-3 font-normal">Versão</th>
                  <th className="pb-2 pr-3 font-normal">Última batida</th>
                  <th className="pb-2 pr-3 font-normal">Tarefa atual</th>
                  <th className="pb-2 font-normal"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => <MachineRow key={m.id} machine={m} now={now} onRevoke={revoke} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel eyebrow="Execução remota" title="Kit AgentCore (experimental)">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="flex max-w-2xl gap-2 text-[12px] text-muted">
            <Cloud className="mt-0.5 size-4 shrink-0" />
            <span>Dockerfile arm64, política IAM mínima e <span className="font-mono">deploy.sh</span> para publicar o container na sua conta AWS. Experimental. O kit não contém token — cada sessão recebe um token de uso único.</span>
          </p>
          <a href="/api/admin/agentcore-kit" download className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-line px-5 py-2.5 text-[14px] font-medium text-muted transition-colors hover:border-line-strong hover:text-ink">
            <Download className="size-4" /> Baixar kit AgentCore
          </a>
        </div>
      </Panel>
      <MachineDialog isOpen={isDialogOpen} onClose={closeDialog} onCreated={load} />
    </div>
  );
}
