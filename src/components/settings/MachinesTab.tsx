"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Ban, CheckCircle2, Cloud, Download, Eraser, Pause, Play, Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import { ClaudeSharePanel } from "./ClaudeSharePanel";
import { ClusterJoinPanel } from "./ClusterJoinPanel";
import { LoadPanel } from "./LoadPanel";
import { MachineDialog } from "./MachineDialog";
import { relativeTime, slotsLabel, STATUS_DOT, STATUS_LABEL, type ConnectionOptions, type Machine, type MachineAvailability } from "./machines-model";

/** The list is refreshed this often so status and "última batida" stay current. */
const REFRESH_MS = 15_000;

interface RowActions {
  readonly onRevoke: (m: Machine) => void;
  readonly onAvailability: (m: Machine, availability: Exclude<MachineAvailability, "pending">) => void;
}

const ACTION = "inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] text-muted";

function AvailabilityAction({ machine, onAvailability }: { readonly machine: Machine } & Pick<RowActions, "onAvailability">) {
  if (machine.kind !== "pool") return null;
  if (machine.availability === "pending") {
    return <button type="button" onClick={() => onAvailability(machine, "active")} aria-label={`Aprovar ${machine.name}`} className={`${ACTION} text-accent hover:text-ink`}><CheckCircle2 className="size-3.5" /> aprovar</button>;
  }
  if (machine.availability === "paused") {
    return <button type="button" onClick={() => onAvailability(machine, "active")} aria-label={`Retomar ${machine.name}`} className={`${ACTION} hover:text-ok`}><Play className="size-3.5" /> retomar</button>;
  }
  return <button type="button" onClick={() => onAvailability(machine, "paused")} aria-label={`Pausar ${machine.name}`} className={`${ACTION} hover:text-warn`}><Pause className="size-3.5" /> pausar</button>;
}

function MachineRow({ machine, now, onRevoke, onAvailability }: { readonly machine: Machine; readonly now: number } & RowActions) {
  const isRevoked = machine.status === "revoked";
  const tasks = machine.currentTasks.map((t) => t.key).join(", ");
  const isDraining = machine.availability === "paused" && machine.currentTasks.length > 0;
  return (
    <motion.tr layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`border-t border-line ${isRevoked ? "opacity-55" : ""}`}>
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px] text-muted">
          <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[machine.status]}`} aria-hidden />
          {isDraining ? "pausando…" : STATUS_LABEL[machine.status]}
        </span>
      </td>
      <td className="max-w-[220px] py-2.5 pr-3 text-[13px]">
        <span className="block truncate" title={machine.hostname && machine.hostname !== machine.name ? `${machine.name} (${machine.hostname})` : machine.name}>{machine.name}</span>
      </td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">
        <span className="whitespace-nowrap">{machine.kind === "pool" ? "pool" : "agentcore"}</span>
        {machine.joinedVia === "join" && <span className="ml-1.5 rounded-full border border-line px-1.5 py-px text-[10px]">join</span>}
      </td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">{machine.version ?? "—"}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px] text-muted" title={machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString("pt-BR") : undefined}>{relativeTime(machine.lastSeenAt, now)}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px] tabular-nums text-muted">{machine.kind === "pool" && !isRevoked ? slotsLabel(machine) : "—"}</td>
      <td className="py-2.5 pr-3 font-mono text-[11px]">{tasks || <span className="text-subtle">—</span>}</td>
      <td className="py-2.5 text-right">
        {!isRevoked && (
          <span className="inline-flex items-center gap-1">
            <AvailabilityAction machine={machine} onAvailability={onAvailability} />
            <button type="button" onClick={() => onRevoke(machine)} aria-label={`Remover ${machine.name}`} className={`${ACTION} hover:text-danger`}>
              <Ban className="size-3.5" /> remover
            </button>
          </span>
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
      <p className="max-w-md text-[12px] text-muted">Use “Entrar no cluster” acima para colocar servidores com um comando, ou adicione uma máquina com kit próprio (Docker Compose ou Kubernetes).</p>
      <Button variant="accent" onClick={onAdd}><Plus className="size-4" /> Adicionar máquina</Button>
    </div>
  );
}

/** Configurações → Máquinas: cluster join, fleet (FLT-01) with pause/resume/approve/remove, "Adicionar máquina" (SET-04) and the AgentCore kit. */
export function MachinesTab() {
  const [machines, setMachines] = useState<readonly Machine[] | null>(null);
  const [connection, setConnection] = useState<ConnectionOptions | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const load = useCallback(() => {
    api<{ workers: Machine[]; connection: ConnectionOptions }>("/api/admin/workers")
      .then((d) => {
        setMachines(d.workers);
        setConnection(d.connection);
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
    if (!window.confirm(`Remover "${machine.name}" do cluster? A credencial deixa de valer na hora e a máquina para de receber tarefas.${warning}`)) return;
    api(`/api/admin/workers/${encodeURIComponent(machine.id)}/revoke`, { method: "POST" })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao revogar"));
  };

  const setAvailability = (machine: Machine, availability: Exclude<MachineAvailability, "pending">) => {
    api(`/api/admin/workers/${encodeURIComponent(machine.id)}/availability`, { method: "POST", body: { availability } })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao atualizar a máquina"));
  };

  const prune = () => {
    if (!window.confirm("Remover todos os servidores do cluster que estão offline e sem tarefa? (containers recriados entram como nós novos e deixam o antigo offline.)")) return;
    api("/api/admin/workers/prune", { method: "POST" })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao limpar"));
  };

  const active = machines?.filter((m) => m.status !== "revoked").length ?? 0;
  const pending = machines?.filter((m) => m.status === "pending").length ?? 0;
  const staleJoined = machines?.filter((m) => m.joinedVia === "join" && m.status === "offline" && m.currentTasks.length === 0).length ?? 0;
  const openDialog = () => setIsDialogOpen(true);
  const closeDialog = useCallback(() => setIsDialogOpen(false), []);

  return (
    <div className="flex flex-col gap-5">
      <LoadPanel />
      <ClaudeSharePanel />
      <ClusterJoinPanel onChanged={load} />
      <Panel
        eyebrow="Máquinas"
        title={machines === null ? "Carregando…" : `${active} ativa${active === 1 ? "" : "s"}${pending > 0 ? ` · ${pending} aguardando aprovação` : ""}`}
        aside={
          machines && machines.length > 0 ? (
            <span className="flex flex-wrap gap-2">
              {staleJoined > 0 && <Button variant="ghost" onClick={prune}><Eraser className="size-4" /> Limpar {staleJoined} offline</Button>}
              <Button variant="accent" onClick={openDialog}><Plus className="size-4" /> Adicionar máquina</Button>
            </span>
          ) : undefined
        }
      >
        {error && <p role="alert" className="mb-3 font-mono text-[12px] text-danger">{error}</p>}
        {machines !== null && machines.length === 0 && <EmptyState onAdd={openDialog} />}
        {machines !== null && machines.length > 0 && (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead>
                <tr className="eyebrow">
                  <th className="pb-2 pr-3 font-normal">Status</th>
                  <th className="pb-2 pr-3 font-normal">Nome</th>
                  <th className="pb-2 pr-3 font-normal">Tipo</th>
                  <th className="pb-2 pr-3 font-normal">Versão</th>
                  <th className="pb-2 pr-3 font-normal">Última batida</th>
                  <th className="pb-2 pr-3 font-normal">Slots</th>
                  <th className="pb-2 pr-3 font-normal">Tarefa atual</th>
                  <th className="pb-2 font-normal"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => <MachineRow key={m.id} machine={m} now={now} onRevoke={revoke} onAvailability={setAvailability} />)}
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
      <MachineDialog isOpen={isDialogOpen} onClose={closeDialog} onCreated={load} connection={connection} />
    </div>
  );
}
