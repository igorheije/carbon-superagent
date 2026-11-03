"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Sparkles } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { useSession } from "@/components/session/SessionProvider";
import { Button, CopyCommand } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import type { PullRequest, Ticket, TicketWorkspace } from "@/lib/domain/types";

const QUICK_TARGETS = 4;

interface Targets {
  readonly branches: readonly string[];
  readonly suggested: string | null;
  readonly hasRemote: boolean;
}

function WorkspaceInfo({ workspace, ticket }: { workspace: TicketWorkspace; ticket: Ticket }) {
  const added = ticket.diff.reduce((n, d) => n + d.additions, 0);
  const removed = ticket.diff.reduce((n, d) => n + d.deletions, 0);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <p className="eyebrow flex items-center gap-1.5"><FolderGit2 className="size-3.5" /> worktree desta tarefa</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11.5px]">
        <dt className="text-subtle">branch</dt>
        <dd className="truncate text-ink" title={workspace.branch}><GitBranch className="mr-1 inline size-3" />{workspace.branch} <span className="text-subtle">← {workspace.base}</span></dd>
        <dt className="text-subtle">commit</dt>
        <dd className="text-ink">{workspace.commit ? <><GitCommitHorizontal className="mr-1 inline size-3" />{workspace.commit}</> : <span className="text-subtle">ainda não commitado</span>}</dd>
        {ticket.diff.length > 0 && (
          <>
            <dt className="text-subtle">mudanças</dt>
            <dd>{ticket.diff.length} arquivo(s) <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span></dd>
          </>
        )}
      </dl>
      <CopyCommand command={`cd ${workspace.path}`} />
    </div>
  );
}

function PrCard({ pr, ticket }: { pr: PullRequest; ticket: Ticket }) {
  return (
    <motion.div
      key={pr.number}
      initial={{ opacity: 0, scale: 0.96, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 24 }}
      className="relative overflow-hidden rounded-xl border border-line-strong p-4"
    >
      <motion.span aria-hidden className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-[var(--accent-weak)] to-transparent" initial={{ x: "-100%" }} animate={{ x: "250%" }} transition={{ duration: 1.1, ease: [0.2, 0, 0.2, 1] }} />
      <div className="relative flex items-center gap-2">
        <GitPullRequest className="size-4 text-accent" strokeWidth={1.8} />
        <span className="text-[20px] font-semibold tracking-[-0.02em]">#{pr.number}</span>
        <span className="ml-auto rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{pr.draft ? "draft" : "pronto p/ review"}</span>
      </div>
      <p className="relative mt-2 text-[13px]">{ticket.title}</p>
      <p className="relative mt-1 font-mono text-[11px] text-muted">{pr.branch} → {pr.base ?? "base padrão"}</p>
      {pr.url && (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="relative mt-3 inline-flex items-center gap-1.5 font-mono text-[11.5px] text-accent hover:underline">
          abrir no GitHub <ExternalLink className="size-3" />
        </a>
      )}
      <p className="relative mt-2 text-[12px] leading-snug text-muted">Merge é humano.</p>
    </motion.div>
  );
}

function OpenPrForm({ ticket }: { ticket: Ticket }) {
  const { settings } = useSession();
  const [targets, setTargets] = useState<Targets | null>(null);
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(settings?.acceptMode !== "act");
  const [isLoading, setIsLoading] = useState(true);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    api<Targets>(`/api/tasks/${ticket.id}/branches`)
      .then((data) => {
        if (!active) return;
        setTargets(data);
        setBase(data.suggested ?? data.branches[0] ?? "");
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : "falha ao listar branches"))
      .finally(() => active && setIsLoading(false));
    return () => {
      active = false;
    };
  }, [ticket.id]);

  const open = async () => {
    setIsOpening(true);
    setError(null);
    try {
      await api(`/api/tasks/${ticket.id}/pr`, { body: { base, draft } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao abrir o PR");
    } finally {
      setIsOpening(false);
    }
  };

  if (isLoading) return <p className="font-mono text-[12px] text-subtle">buscando branches do remoto…</p>;
  if (!targets?.hasRemote) {
    return <p className="text-[12.5px] text-muted">{error ?? "Este repositório não tem remoto com branches para receber um PR. O commit está no worktree acima."}</p>;
  }
  const quick = targets.branches.slice(0, QUICK_TARGETS);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent/50 bg-accent-weak/40 p-3">
      <p className="eyebrow flex items-center gap-1.5"><GitPullRequest className="size-3.5" /> abrir PR · escolha o destino</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Branch de destino">
        {quick.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={base === name}
            onClick={() => setBase(name)}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${base === name ? "border-accent bg-accent-weak text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink"}`}
          >
            {name === targets.suggested && <Sparkles className="size-3 text-accent" />}
            {name}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">ou outro branch ({targets.branches.length})</span>
        <select value={base} onChange={(e) => setBase(e.target.value)} className="rounded-lg border border-line bg-surface-sunken px-2.5 py-2 font-mono text-[12px] outline-none focus:border-line-strong">
          {targets.branches.map((name) => (
            <option key={name} value={name}>{name}{name === targets.suggested ? " (sugerido)" : ""}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[12.5px] text-muted">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="accent-[var(--accent)]" />
        abrir como draft
      </label>
      <Button variant="accent" onClick={() => void open()} isLoading={isOpening} disabled={!base || isOpening}>
        <GitPullRequest className="size-4" /> Abrir PR para {base || "…"}
      </Button>
      {error && <p role="alert" className="font-mono text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

export function DeliveryCard() {
  const ticket = useFocusTicket();
  const { state, mode } = useEngine();
  const pr = ticket?.pr ?? null;
  const workspace = ticket?.workspace ?? null;
  const pendingLessons = state.lessons.filter((l) => l.status === "candidate").length;
  const canOpenPr = mode === "live" && ticket?.status === "done" && !pr && Boolean(workspace?.commit);

  return (
    <Panel eyebrow="Entrega · outbox" title="Worktree e pull request">
      <div className="flex flex-col gap-3">
        {workspace && ticket && <WorkspaceInfo workspace={workspace} ticket={ticket} />}
        <AnimatePresence mode="wait">
          {pr && ticket ? (
            <PrCard pr={pr} ticket={ticket} />
          ) : canOpenPr && ticket ? (
            <OpenPrForm key={ticket.id} ticket={ticket} />
          ) : (
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[13px] text-muted">
              {workspace ? "Quando a tarefa terminar com commit, você escolhe aqui o branch de destino do PR." : "O worktree e o PR aparecem aqui quando uma tarefa começa."}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-line px-3 py-2.5">
        <span className="text-[12px] text-muted">Lições aguardando você</span>
        <span className={`font-mono text-[13px] ${pendingLessons ? "text-accent" : "text-subtle"}`}>{pendingLessons}</span>
      </div>
    </Panel>
  );
}
