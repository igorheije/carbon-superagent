"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, KeyRound, Network, PowerOff, RefreshCw, ShieldAlert } from "lucide-react";
import { Button, CopyCommand } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import { JOIN_TTL_OPTIONS, joinTokenSummary, type GeneratedJoinToken, type JoinStatus } from "./machines-model";

/** Multi-line command with a copy button (the docker run command does not fit CopyCommand's single line). */
function CopyBlock({ text, label }: { readonly text: string; readonly label: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch {
      setIsCopied(false);
    }
  };
  return (
    <div className="relative rounded-lg border border-line bg-surface-sunken">
      <pre className="scroll-thin overflow-x-auto px-3 py-2.5 pr-10 font-mono text-[12px] leading-relaxed text-muted">{text}</pre>
      <button type="button" onClick={() => void copy()} aria-label={`Copiar ${label}`} className="absolute right-2 top-2 rounded-md p-1 text-muted hover:text-ink">
        {isCopied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function GeneratedCommands({ generated, onDismiss }: { readonly generated: GeneratedJoinToken; readonly onDismiss: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-weak p-4">
      <p className="flex items-start gap-2 text-[12px] text-warn">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <span>Copie agora: o token aparece só esta vez. Quem tiver este token coloca servidores no cluster e recebe tarefas (código e prompt). Trate como senha.</span>
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="eyebrow">Em cada servidor novo (com o repositório do Carbon e npm install)</p>
        <CopyCommand command={generated.commands.cli} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="eyebrow">Ou com Docker (imagem de deploy/worker/Dockerfile)</p>
        <CopyBlock text={generated.commands.docker} label="comando docker" />
      </div>
      {!generated.panelUrl && (
        <p className="text-[12px] text-warn">O painel não tem URL pública configurada (Configurações → Execução): troque o placeholder pela URL https onde os workers alcançam o painel.</p>
      )}
      <div>
        <Button variant="ghost" onClick={onDismiss}>Já copiei</Button>
      </div>
    </motion.div>
  );
}

/** "Entrar no cluster" (Docker Swarm-like join): one shared token, one command per new server. */
export function ClusterJoinPanel({ onChanged }: { readonly onChanged: () => void }) {
  const [status, setStatus] = useState<JoinStatus | null>(null);
  const [generated, setGenerated] = useState<GeneratedJoinToken | null>(null);
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [maxUses, setMaxUses] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<JoinStatus>("/api/admin/workers/join-token")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao carregar o token de join"));
  }, []);
  useEffect(load, [load]);

  const fail = (fallback: string) => (e: unknown) => setError(e instanceof Error ? e.message : fallback);

  const rotate = () => {
    if (status?.token && !window.confirm("Girar o token? O atual deixa de valer para joins novos. Servidores que já entraram continuam trabalhando.")) return;
    const uses = maxUses.trim() === "" ? null : Number(maxUses);
    if (uses !== null && (!Number.isInteger(uses) || uses < 1)) {
      setError("máximo de usos precisa ser um inteiro ≥ 1 (ou vazio para ilimitado)");
      return;
    }
    setIsBusy(true);
    api<GeneratedJoinToken>("/api/admin/workers/join-token", { method: "POST", body: { ttlHours, maxUses: uses } })
      .then((g) => {
        setGenerated(g);
        load();
        onChanged();
      })
      .catch(fail("falha ao gerar o token"))
      .finally(() => setIsBusy(false));
  };

  const disable = () => {
    if (!window.confirm("Desligar o join? Nenhum servidor novo entra até gerar outro token. Os que já entraram continuam.")) return;
    api("/api/admin/workers/join-token", { method: "DELETE" })
      .then(() => {
        setGenerated(null);
        load();
      })
      .catch(fail("falha ao desligar o join"));
  };

  const toggleApproval = (requireApproval: boolean) => {
    api("/api/admin/workers/join-token", { method: "PATCH", body: { requireApproval } })
      .then(load)
      .catch(fail("falha ao salvar"));
  };

  const hasToken = Boolean(status?.token);
  return (
    <Panel
      eyebrow="Cluster"
      title="Entrar no cluster"
      aside={
        status && (
          <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <span className={`size-2 rounded-full ${hasToken ? "bg-ok" : "bg-subtle"}`} aria-hidden />
            {hasToken ? "join ligado" : "join desligado"}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex max-w-3xl gap-2 text-[12px] text-muted">
          <Network className="mt-0.5 size-4 shrink-0" />
          <span>
            Como no Docker Swarm: gere um token, rode o comando em cada servidor e ele entra no cluster sozinho, aparece na lista abaixo e começa a pegar
            tarefas do pool. Cada servidor recebe a própria credencial, então remover um não afeta os outros.
          </span>
        </p>
        {error && <p role="alert" className="font-mono text-[12px] text-danger">{error}</p>}
        {status?.token && <p className="font-mono text-[12px] text-muted"><KeyRound className="mr-1.5 inline size-3.5" />{joinTokenSummary(status.token)}</p>}

        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">
            Validade
            <select
              value={ttlHours ?? ""}
              onChange={(e) => setTtlHours(e.target.value === "" ? null : Number(e.target.value))}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink"
            >
              {JOIN_TTL_OPTIONS.map((o) => <option key={o.label} value={o.hours ?? ""}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">
            Máximo de servidores
            <input
              inputMode="numeric"
              placeholder="ilimitado"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink md:w-36"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" onClick={rotate} isLoading={isBusy}>
              <RefreshCw className="size-4" /> {hasToken ? "Girar token" : "Gerar token de join"}
            </Button>
            {hasToken && (
              <Button variant="ghost" onClick={disable}>
                <PowerOff className="size-4" /> Desligar join
              </Button>
            )}
          </div>
        </div>

        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" checked={status?.requireApproval ?? false} disabled={!status} onChange={(e) => toggleApproval(e.target.checked)} />
          <span>
            Exigir aprovação
            <span className="block text-[12px] text-muted">Servidores novos ficam “aguardando aprovação” e só pegam tarefas depois que um admin aprovar.</span>
          </span>
        </label>

        <AnimatePresence>{generated && <GeneratedCommands generated={generated} onDismiss={() => setGenerated(null)} />}</AnimatePresence>
      </div>
    </Panel>
  );
}
