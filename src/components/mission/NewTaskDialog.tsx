"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Plus, X } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { PERSONAS } from "@/lib/domain/personas";
import { ModelPicker } from "@/components/ui/ModelPicker";
import type { TaskRuntime } from "@/lib/domain/types";
import { effectiveRuntime, RuntimePicker, runtimeOptionsOf } from "./RuntimePicker";
import { DraftField } from "./DraftField";

type Tab = "manual" | "linear" | "github";
interface ExternalIssue {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly imported: boolean;
}

function IssuePicker({ source, onDone }: { source: "linear" | "github"; onDone: () => void }) {
  const [issues, setIssues] = useState<readonly ExternalIssue[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setIssues(null);
    setError(null);
    api<{ issues: ExternalIssue[] }>(`/api/import/${source}`).then((d) => setIssues(d.issues)).catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  }, [source]);

  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const submit = async () => {
    setIsSaving(true);
    try {
      await api(`/api/import/${source}`, { body: { ids: [...selected] } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  if (error) return <p className="rounded-xl border border-dashed border-line p-4 font-mono text-[12px] text-danger">{error}</p>;
  if (!issues) return <p className="p-4 font-mono text-[12px] text-muted">carregando issues…</p>;
  if (!issues.length) return <p className="p-4 text-[13px] text-muted">Nenhuma issue aberta {source === "linear" ? "atribuída a você" : "no repositório"}.</p>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="scroll-thin flex max-h-80 flex-col gap-1.5 overflow-y-auto">
        {issues.map((issue, i) => (
          <motion.li key={issue.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <button
              type="button"
              disabled={issue.imported}
              aria-pressed={selected.has(issue.id)}
              onClick={() => toggle(issue.id)}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-45 ${selected.has(issue.id) ? "border-accent bg-accent-weak" : "border-line hover:border-line-strong"}`}
            >
              <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${selected.has(issue.id) ? "border-accent bg-accent" : "border-line-strong"}`}>
                {selected.has(issue.id) && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
              </span>
              <span className="font-mono text-[11px] text-muted">{issue.key}</span>
              <span className="truncate text-[13px]">{issue.title}</span>
              {issue.imported && <span className="ml-auto font-mono text-[10px] text-subtle">já na fila</span>}
            </button>
          </motion.li>
        ))}
      </ul>
      <Button onClick={() => void submit()} isLoading={isSaving} disabled={selected.size === 0} className="self-end">
        Enfileirar {selected.size || ""}
      </Button>
    </div>
  );
}

export function NewTaskDialog() {
  const { user, settings, executors } = useSession();
  const installed = (["claude", "codex"] as const).filter((x) => executors?.[x] ?? true);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("manual");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [executor, setExecutor] = useState<"claude" | "codex">(settings?.defaultExecutor ?? "claude");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<TaskRuntime>("local");

  // Never send an executor that is not installed; fall back to the one that is.
  const chosen = installed.includes(executor) ? executor : (installed[0] ?? executor);
  const runtimeOptions = runtimeOptionsOf(settings);
  const chosenRuntime = effectiveRuntime(runtime, runtimeOptions);

  const defaultModel = (chosen === "claude" ? settings?.claudeModel : settings?.codexModel) || "auto";
  const currentModel = model ?? defaultModel;
  const defaultEffort = (chosen === "claude" ? settings?.claudeEffort : settings?.codexEffort) || "auto";
  const currentEffort = effort ?? defaultEffort;

  const close = () => {
    setIsOpen(false);
    setError(null);
  };
  const createManual = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api("/api/tasks", { body: { title, description, executor: chosen, model: currentModel, effort: currentEffort, runtime: chosenRuntime } });
      setTitle("");
      setDescription("");
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button onClick={() => setIsOpen(true)} variant="accent">
        <Plus className="size-4" /> Nova tarefa
      </Button>
      <AnimatePresence>
        {isOpen && (
          <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
            <motion.div role="dialog" aria-label="Nova tarefa" data-ascii="surface" className="card scroll-thin max-h-[88vh] w-full max-w-2xl overflow-y-auto p-6 shadow-[var(--shadow-md)]" initial={{ y: -16, scale: 0.98, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 32 }} onClick={(e) => e.stopPropagation()}>
              <header className="flex items-center justify-between">
                <div role="tablist" className="flex gap-1 font-mono text-[12px]">
                  {(["manual", "linear", "github"] as const).map((t) => (
                    <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`relative rounded-full px-3 py-1.5 ${tab === t ? "text-ink" : "text-muted hover:text-ink"}`}>
                      {tab === t && <motion.span layoutId="task-tab" className="absolute inset-0 rounded-full border border-line bg-surface-muted" />}
                      <span className="relative">[ {t === "manual" ? "Escrever" : t === "linear" ? "Linear" : "GitHub"} ]</span>
                    </button>
                  ))}
                </div>
                <button type="button" onClick={close} aria-label="Fechar" className="rounded-full p-1.5 text-muted hover:text-ink"><X className="size-4" /></button>
              </header>
              <p className="mt-3 text-[12px] text-muted">
                Executa como <span className="text-ink">{user ? PERSONAS[user.persona].label : "—"}</span>: entregável “{user ? PERSONAS[user.persona].deliverable : ""}”.
              </p>
              <div className="mt-4">
                {tab === "manual" ? (
                  <div className="flex flex-col gap-4">
                    <Field label="O que fazer" placeholder="Adicionar validação de e-mail no cadastro" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                    <DraftField title={title} value={description} onChange={setDescription} executor={chosen} />
                    <div className="flex flex-col gap-1.5">
                      <p className="eyebrow">Modelo e esforço</p>
                      <ModelPicker key={chosen} executor={chosen} value={currentModel} onChange={setModel} effort={currentEffort} onEffortChange={setEffort} task={{ title, description }} />
                    </div>
                    <RuntimePicker value={chosenRuntime} options={runtimeOptions} onChange={setRuntime} />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {installed.length > 1 ? (
                        <div role="radiogroup" aria-label="Agente" className="flex gap-1 rounded-full border border-line p-0.5 font-mono text-[11px]">
                          {installed.map((x) => (
                            <button key={x} type="button" role="radio" aria-checked={chosen === x} onClick={() => { setExecutor(x); setModel(null); setEffort(null); }} className={`rounded-full px-3 py-1 ${chosen === x ? "bg-btn text-btn-text" : "text-muted"}`}>
                              {x === "claude" ? "claude code" : "codex"}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="font-mono text-[11px] text-muted">
                          {installed.length === 1 ? `executa com ${installed[0] === "claude" ? "Claude Code" : "Codex"}` : "nenhum agente instalado"}
                        </span>
                      )}
                      <Button onClick={() => void createManual()} isLoading={isSaving} disabled={title.trim().length < 3}>Enfileirar</Button>
                    </div>
                    {error && <p className="font-mono text-[12px] text-danger">{error}</p>}
                  </div>
                ) : (
                  <IssuePicker source={tab} onDone={close} />
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
