"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Trash2 } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api, type ProjectInfo } from "@/lib/client/api";

interface ProjectRow extends ProjectInfo {
  readonly tasks: { readonly live: number; readonly total: number };
  readonly index: { readonly phase: string; readonly fileCount: number | null; readonly indexedAt: string | null };
}

function ProjectCard({ project, isActive, onChanged }: { project: ProjectRow; isActive: boolean; onChanged: () => void }) {
  const { switchProject } = useSession();
  const [name, setName] = useState(project.name);
  const [baseBranch, setBaseBranch] = useState(project.baseBranch);
  const [isConfirming, setIsConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isDirty = name !== project.name || baseBranch !== project.baseBranch;

  const save = () =>
    api(`/api/projects/${project.id}`, { method: "PATCH", body: { name, baseBranch } })
      .then(() => {
        setMessage("salvo");
        onChanged();
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "falha"));
  const remove = () =>
    api(`/api/projects/${project.id}`, { method: "DELETE" })
      .then(onChanged)
      .catch((e: unknown) => {
        setMessage(e instanceof Error ? e.message : "falha");
        setIsConfirming(false);
      });

  return (
    <motion.li layout className={`rounded-2xl border p-4 ${isActive ? "border-accent/60" : "border-line"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-subtle">{project.repoPath}</p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            {project.tasks.total} tarefas{project.tasks.live ? ` · ${project.tasks.live} ativas` : ""} · índice:{" "}
            {project.index.fileCount !== null ? `${project.index.fileCount} arquivos` : project.index.phase === "idle" ? "pendente" : project.index.phase}
          </p>
        </div>
        {isActive ? (
          <span className="flex items-center gap-1 rounded-full border border-accent/60 px-2.5 py-1 font-mono text-[10px] text-accent"><Check className="size-3" /> ativo para você</span>
        ) : (
          <Button variant="ghost" className="!px-3 !py-1 !text-[12px]" onClick={() => void switchProject(project.id)}>Usar este</Button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Branch base (vazio = branch atual)" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="!px-3 !py-1.5 !text-[12px]" disabled={!isDirty} onClick={() => void save()}>Salvar</Button>
        <AnimatePresence mode="wait">
          {isConfirming ? (
            <motion.span key="confirm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-2 text-[12px] text-danger">
              Remove tarefas, lições e índice deste projeto (o repositório no disco não é tocado).
              <button type="button" onClick={() => void remove()} className="rounded-full border border-danger px-3 py-1 font-mono text-[11px] text-danger hover:bg-danger hover:text-white">confirmar</button>
              <button type="button" onClick={() => setIsConfirming(false)} className="font-mono text-[11px] text-muted hover:text-ink">cancelar</button>
            </motion.span>
          ) : (
            <motion.button key="remove" type="button" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsConfirming(true)} className="ml-auto flex items-center gap-1 font-mono text-[11px] text-muted hover:text-danger">
              <Trash2 className="size-3.5" /> remover projeto
            </motion.button>
          )}
        </AnimatePresence>
        {message && <span className="font-mono text-[11px] text-muted">{message}</span>}
      </div>
    </motion.li>
  );
}

export function ProjectsTab() {
  const { refresh } = useSession();
  const [projects, setProjects] = useState<readonly ProjectRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(() => {
    api<{ projects: ProjectRow[]; activeId: string | null }>("/api/projects")
      .then((d) => {
        setProjects(d.projects);
        setActiveId(d.activeId);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  }, []);
  useEffect(load, [load]);

  const changed = () => {
    load();
    void refresh();
  };

  const add = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api("/api/projects", { body: { repoPath } });
      setRepoPath("");
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel eyebrow="Novo projeto" title="Adicionar repositório">
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <Field label="Repositório (clone local)" placeholder="/Users/voce/code/outro-projeto" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
          </div>
          <Button onClick={() => void add()} isLoading={isSaving} disabled={!repoPath.trim()}>Criar e indexar</Button>
        </div>
        {error && <p className="mt-2 font-mono text-[12px] text-danger">{error}</p>}
      </Panel>
      <Panel eyebrow="Projetos" title={`${projects.length} repositório(s)`}>
        <ul className="flex flex-col gap-3">
          {projects.map((p) => (
            <ProjectCard key={`${p.id}:${p.name}:${p.baseBranch}`} project={p} isActive={p.id === activeId} onChanged={changed} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}
