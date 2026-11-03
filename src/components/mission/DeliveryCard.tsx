"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ExternalLink, FolderGit2, FolderInput, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Sparkles } from "lucide-react";
import { useEngine, useFocusTicket } from "@/components/engine/EngineProvider";
import { useSession } from "@/components/session/SessionProvider";
import { Button, CopyCommand } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import type { PullRequest, Ticket, TicketWorkspace } from "@/lib/domain/types";

const QUICK_TARGETS = 4;

interface RemoteTargets {
  readonly branches: readonly string[];
  readonly suggested: string | null;
  readonly hasRemote: boolean;
}
interface LocalTargets {
  readonly branches: readonly string[];
  readonly current: string | null;
  readonly suggested: string | null;
  readonly hasCommits: boolean;
}
interface Targets {
  readonly remote: RemoteTargets;
  readonly local: LocalTargets;
}
type Action = "pr" | "merge" | "apply";

function WorkspaceInfo({ workspace, ticket }: { workspace: TicketWorkspace; ticket: Ticket }) {
  const added = ticket.diff.reduce((n, d) => n + d.additions, 0);
  const removed = ticket.diff.reduce((n, d) => n + d.deletions, 0);
  const isActive = workspace.isActive !== false;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <p className="eyebrow flex items-center gap-1.5">
        <FolderGit2 className="size-3.5" /> {isActive ? "worktree ativo" : "branch no seu repositório"}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11.5px]">
        <dt className="text-subtle">branch</dt>
        <dd className="truncate text-ink" title={`${workspace.branch} ← ${workspace.base}`}>
          <GitBranch className="mr-1 inline size-3" />{workspace.branch} <span className="text-subtle">← {workspace.base}</span>
        </dd>
        <dt className="text-subtle">commit</dt>
        <dd className="text-ink">{workspace.commit ? <><GitCommitHorizontal className="mr-1 inline size-3" />{workspace.commit}</> : <span className="text-subtle">ainda não commitado</span>}</dd>
        {ticket.diff.length > 0 && (
          <>
            <dt className="text-subtle">mudanças</dt>
            <dd>{ticket.diff.length} arquivo(s) <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span></dd>
          </>
        )}
        {(workspace.mergedInto || workspace.appliedAt) && (
          <>
            <dt className="text-subtle">levado</dt>
            <dd className="flex items-center gap-1 text-ok">
              <CheckCircle2 className="size-3" />
              {workspace.mergedInto ? `merge em ${workspace.mergedInto}` : "aplicado na pasta do projeto"}
            </dd>
          </>
        )}
      </dl>
      {isActive ? (
        <CopyCommand command={`cd ${workspace.path}`} />
      ) : (
        <>
          <p className="text-[11.5px] leading-snug text-muted">O worktree era temporário e já foi removido. As mudanças estão no branch acima, dentro do seu repositório.</p>
          <CopyCommand command={`git log --stat ${workspace.branch}`} />
        </>
      )}
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

function BranchPicker({ branches, suggested, value, onChange, label }: { branches: readonly string[]; suggested: string | null; value: string; onChange: (b: string) => void; label: string }) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {branches.slice(0, QUICK_TARGETS).map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={value === name}
            onClick={() => onChange(name)}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${value === name ? "border-accent bg-accent-weak text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink"}`}
          >
            {name === suggested && <Sparkles className="size-3 text-accent" />}
            {name}
          </button>
        ))}
      </div>
      {branches.length > QUICK_TARGETS && (
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">ou outro branch ({branches.length})</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-surface-sunken px-2.5 py-2 font-mono text-[12px] outline-none focus:border-line-strong">
            {branches.map((name) => <option key={name} value={name}>{name}{name === suggested ? " (sugerido)" : ""}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

function useAction(run: () => Promise<{ detail?: string }>) {
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const data = await run();
      setMessage({ ok: true, text: data.detail ?? "feito" });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "falhou" });
    } finally {
      setIsBusy(false);
    }
  };
  return { isBusy, message, go };
}

function Feedback({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return <p role={message.ok ? "status" : "alert"} className={`font-mono text-[11.5px] ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</p>;
}

function PrForm({ ticket, remote }: { ticket: Ticket; remote: RemoteTargets }) {
  const { settings } = useSession();
  const [base, setBase] = useState(remote.suggested ?? remote.branches[0] ?? "");
  const [draft, setDraft] = useState(settings?.acceptMode !== "act");
  const action = useAction(() => api(`/api/tasks/${ticket.id}/pr`, { body: { base, draft } }));
  return (
    <>
      <BranchPicker branches={remote.branches} suggested={remote.suggested} value={base} onChange={setBase} label="Branch de destino do PR" />
      <label className="flex items-center gap-2 text-[12.5px] text-muted">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="accent-[var(--accent)]" /> abrir como draft
      </label>
      <Button variant="accent" onClick={() => void action.go()} isLoading={action.isBusy} disabled={!base || action.isBusy}>
        <GitPullRequest className="size-4" /> Abrir PR para {base || "…"}
      </Button>
      <Feedback message={action.message} />
    </>
  );
}

function MergeForm({ ticket, local }: { ticket: Ticket; local: LocalTargets }) {
  const [target, setTarget] = useState(local.suggested ?? local.branches[0] ?? "");
  const action = useAction(() => api(`/api/tasks/${ticket.id}/merge`, { body: { target } }));
  const isCurrent = target === local.current;
  return (
    <>
      <BranchPicker branches={local.branches} suggested={local.suggested} value={target} onChange={setTarget} label="Branch local de destino" />
      <p className="text-[11.5px] leading-snug text-muted">
        {isCurrent ? `${target} é o branch aberto na sua pasta: ela precisa estar sem mudanças pendentes.` : `${target} recebe o merge sem mexer na sua pasta.`} Com conflito, nada é alterado.
      </p>
      <Button variant="accent" onClick={() => void action.go()} isLoading={action.isBusy} disabled={!target || action.isBusy}>
        <GitMerge className="size-4" /> Fazer merge em {target || "…"}
      </Button>
      <Feedback message={action.message} />
    </>
  );
}

function ApplyForm({ ticket }: { ticket: Ticket }) {
  const action = useAction(() => api(`/api/tasks/${ticket.id}/apply`, { method: "POST" }));
  return (
    <>
      <p className="text-[11.5px] leading-snug text-muted">Copia as mudanças da tarefa para a pasta do projeto, sem commit, para você revisar (git status) e commitar. Só aplica se encaixar limpo; senão, nada muda.</p>
      <Button variant="accent" onClick={() => void action.go()} isLoading={action.isBusy} disabled={action.isBusy}>
        <FolderInput className="size-4" /> Aplicar na minha pasta
      </Button>
      <Feedback message={action.message} />
    </>
  );
}

const ACTION_LABEL: Readonly<Record<Action, string>> = { pr: "Abrir PR", merge: "Merge local", apply: "Aplicar na pasta" };

function Deliver({ ticket }: { ticket: Ticket }) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("apply");

  useEffect(() => {
    let active = true;
    api<Targets>(`/api/tasks/${ticket.id}/targets`)
      .then((data) => {
        if (!active) return;
        setTargets(data);
        setAction(data.remote.hasRemote ? "pr" : data.local.hasCommits && data.local.branches.length ? "merge" : "apply");
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : "falha ao listar branches"));
    return () => {
      active = false;
    };
  }, [ticket.id]);

  if (error) return <p className="font-mono text-[12px] text-danger">{error}</p>;
  if (!targets) return <p className="font-mono text-[12px] text-subtle">verificando branches…</p>;
  const available: readonly Action[] = [
    ...(targets.remote.hasRemote ? (["pr"] as const) : []),
    ...(targets.local.hasCommits && targets.local.branches.length ? (["merge"] as const) : []),
    "apply",
  ];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent/50 bg-accent-weak/40 p-3">
      <p className="eyebrow">levar as mudanças</p>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Como levar as mudanças">
        {available.map((a) => (
          <button key={a} type="button" role="tab" aria-selected={action === a} onClick={() => setAction(a)} className={`rounded-full border px-3 py-1 font-mono text-[11px] transition-colors ${action === a ? "border-accent bg-accent text-accent-ink" : "border-line text-muted hover:text-ink"}`}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {action === "pr" && <PrForm ticket={ticket} remote={targets.remote} />}
      {action === "merge" && <MergeForm ticket={ticket} local={targets.local} />}
      {action === "apply" && <ApplyForm ticket={ticket} />}
      {!targets.remote.hasRemote && <p className="font-mono text-[10.5px] text-subtle">sem remoto: PR indisponível{targets.local.hasCommits ? "" : " · repositório sem commits: merge indisponível"}</p>}
    </div>
  );
}

export function DeliveryCard() {
  const ticket = useFocusTicket();
  const { state, mode } = useEngine();
  const pr = ticket?.pr ?? null;
  const workspace = ticket?.workspace ?? null;
  const pendingLessons = state.lessons.filter((l) => l.status === "candidate").length;
  const canDeliver = mode === "live" && ticket?.status === "done" && !pr && Boolean(workspace?.commit);

  return (
    <Panel eyebrow="Entrega · outbox" title="Branch e entrega">
      <div className="flex flex-col gap-3">
        {workspace && ticket && <WorkspaceInfo workspace={workspace} ticket={ticket} />}
        <AnimatePresence mode="wait">
          {pr && ticket ? (
            <PrCard pr={pr} ticket={ticket} />
          ) : canDeliver && ticket ? (
            <Deliver key={ticket.id} ticket={ticket} />
          ) : (
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[13px] text-muted">
              {workspace ? "Quando a tarefa terminar com commit, você escolhe aqui como levar as mudanças." : "O branch da tarefa e a entrega aparecem aqui quando uma tarefa começa."}
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
