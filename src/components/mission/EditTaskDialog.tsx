"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RotateCcw, X } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import type { TaskRuntime, Ticket } from "@/lib/domain/types";
import { AutoApproveOption } from "./AutoApproveOption";
import { DraftField } from "./DraftField";
import { effectiveRuntime, RuntimePicker, runtimeOptionsOf } from "./RuntimePicker";

/** GET /api/tasks/:id → what the form edits (the description is not in the live snapshot). */
interface EditableTask {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly runtime: TaskRuntime;
  readonly status: Ticket["status"];
  readonly distributed: boolean;
  readonly autoApprove: boolean;
}

interface EditTaskDialogProps {
  readonly ticket: Pick<Ticket, "id" | "key">;
  readonly onClose: () => void;
}

const MIN_TITLE = 3;

/** "Editar": change what the task asks for and where it runs, then save or save and run again. */
export function EditTaskDialog({ ticket, onClose }: EditTaskDialogProps) {
  const { settings, executors } = useSession();
  const [task, setTask] = useState<EditableTask | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<TaskRuntime>("local");
  const [autoApprove, setAutoApprove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "rerun" | null>(null);

  useEffect(() => {
    let isActive = true;
    api<{ task: EditableTask }>(`/api/tasks/${encodeURIComponent(ticket.id)}`)
      .then(({ task: loaded }) => {
        if (!isActive) return;
        setTask(loaded);
        setTitle(loaded.title);
        setDescription(loaded.description);
        setRuntime(loaded.runtime);
        setAutoApprove(loaded.autoApprove);
      })
      .catch((e: unknown) => isActive && setError(e instanceof Error ? e.message : "falha ao carregar a tarefa"));
    return () => {
      isActive = false;
    };
  }, [ticket.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runtimeOptions = runtimeOptionsOf(settings);
  const chosenRuntime = effectiveRuntime(runtime, runtimeOptions);
  // Same rule as "Nova tarefa": only for the draft helper, the task keeps its own executor.
  const executor = (executors?.claude ?? true) ? "claude" : "codex";
  const isFinished = task?.status === "done" || task?.status === "failed";
  const canSave = task !== null && title.trim().length >= MIN_TITLE && saving === null;

  const save = async (rerun: boolean) => {
    setSaving(rerun ? "rerun" : "save");
    setError(null);
    try {
      await api(`/api/tasks/${encodeURIComponent(ticket.id)}`, {
        method: "PATCH",
        body: { title, description, runtime: task?.distributed ? undefined : chosenRuntime, autoApprove, rerun },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao salvar");
    } finally {
      setSaving(null);
    }
  };

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Editar ${ticket.key}`}
          data-ascii="surface"
          className="card scroll-thin max-h-[88vh] w-full max-w-2xl overflow-y-auto p-6 shadow-[var(--shadow-md)]"
          initial={{ y: -16, scale: 0.98, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="mb-5 flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow">{ticket.key}</p>
              <h2 className="mt-1 text-[18px] font-medium tracking-[-0.01em]">Editar tarefa</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1.5 text-muted hover:text-ink"><X className="size-4" /></button>
          </header>

          {task === null && !error && <p className="font-mono text-[12px] text-subtle">carregando…</p>}
          {task !== null && (
            <div className="flex flex-col gap-4">
              <Field label="O que fazer" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
              <DraftField title={title} value={description} onChange={setDescription} executor={executor} />
              {task.distributed ? (
                <p className="rounded-xl border border-line p-3 text-[12px] text-muted">
                  Tarefa dividida: ela planeja e integra <span className="text-ink">neste computador</span>; as partes vão para o cluster.
                </p>
              ) : (
                <RuntimePicker value={chosenRuntime} options={runtimeOptions} onChange={setRuntime} />
              )}
              <AutoApproveOption checked={autoApprove} onChange={setAutoApprove} isRemote={task.distributed || chosenRuntime !== "local"} />
              {isFinished && (
                <p className="text-[12px] text-subtle">
                  Rodar de novo recomeça a tarefa com o texto novo. As respostas que você já deu ao agente continuam valendo.
                </p>
              )}
            </div>
          )}

          {error && <p role="alert" className="mt-3 font-mono text-[12px] text-danger">{error}</p>}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button variant={isFinished ? "ghost" : "primary"} onClick={() => void save(false)} isLoading={saving === "save"} disabled={!canSave}>Salvar</Button>
            {isFinished && (
              <Button variant="accent" onClick={() => void save(true)} isLoading={saving === "rerun"} disabled={!canSave}>
                <RotateCcw className="size-4" /> Salvar e rodar de novo
              </Button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
