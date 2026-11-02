"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronsUpDown, FolderGit2, Plus, X } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";

function NewProjectDialog({ onClose }: { readonly onClose: () => void }) {
  const { refresh } = useSession();
  const [repoPath, setRepoPath] = useState("");
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const create = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api("/api/projects", { body: { repoPath, name: name || undefined, baseBranch } });
      await refresh();
      onClose();
      window.location.assign("/knowledge");
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao criar o projeto");
      setIsSaving(false);
    }
  };

  return (
    <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        role="dialog"
        aria-label="Novo projeto"
        className="card w-full max-w-lg p-6 shadow-[var(--shadow-md)]"
        initial={{ y: -12, scale: 0.98, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Novo projeto</p>
            <p className="mt-1 text-[18px] font-medium">Adicionar um repositório</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1.5 text-muted hover:text-ink"><X className="size-4" /></button>
        </header>
        <div className="mt-5 flex flex-col gap-4">
          <Field label="Repositório (clone local)" placeholder="/Users/voce/code/outro-projeto" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} hint="Pasta raiz com .git. Cada projeto tem sua fila, base de conhecimento, lições e regras." autoFocus />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Nome (opcional)" placeholder="nome da pasta" value={name} onChange={(e) => setName(e.target.value)} />
            <Field label="Branch base (opcional)" placeholder="branch atual" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </div>
          {error && <p role="alert" className="font-mono text-[12px] text-danger">{error}</p>}
          <p className="text-[12px] text-muted">Ao criar, o Carbon troca para o projeto e já começa a mapear o repositório.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={() => void create()} isLoading={isSaving} disabled={repoPath.trim().length === 0}>Criar e indexar</Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Active project + quick switch. Each person keeps their own active project. */
export function ProjectSwitcher() {
  const { projects, activeProject, switchProject, user } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  if (!user) return null;

  const pick = async (id: string) => {
    setIsOpen(false);
    if (id === activeProject?.id) return;
    try {
      await switchProject(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao trocar");
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="flex max-w-[260px] items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[12.5px] transition-colors hover:border-line-strong"
      >
        <FolderGit2 className="size-3.5 shrink-0 text-accent" />
        <span className="truncate">{activeProject?.name ?? "sem projeto"}</span>
        <ChevronsUpDown className="size-3 shrink-0 text-muted" />
      </button>
      {error && <p className="absolute left-0 top-full mt-1 font-mono text-[10px] text-danger">{error}</p>}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            role="listbox"
            aria-label="Projetos"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="card absolute left-0 top-full z-40 mt-2 w-[320px] p-1.5 shadow-[var(--shadow-md)]"
          >
            <p className="eyebrow px-2.5 pb-1 pt-1.5">Projetos</p>
            <ul className="scroll-thin max-h-72 overflow-y-auto">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={p.id === activeProject?.id}
                    onClick={() => void pick(p.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${p.id === activeProject?.id ? "bg-surface-muted" : "hover:bg-surface-muted"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{p.name}</span>
                      <span className="block truncate font-mono text-[10px] text-subtle">{p.repoPath}</span>
                    </span>
                    {p.id === activeProject?.id && <Check className="size-3.5 shrink-0 text-accent" />}
                  </button>
                </li>
              ))}
            </ul>
            {user.role === "admin" && (
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setIsCreating(true);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2.5 pb-1.5 pt-2.5 text-left text-[12.5px] text-muted hover:text-ink"
              >
                <Plus className="size-3.5" /> Novo projeto
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{isCreating && <NewProjectDialog onClose={() => setIsCreating(false)} />}</AnimatePresence>
    </div>
  );
}
