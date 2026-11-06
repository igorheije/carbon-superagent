"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, KeyRound, X } from "lucide-react";
import { Button, CopyCommand, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { version } from "../../../package.json";
import { downloadBase64, nextCommands, TARGET_LABEL, type CreatedMachine, type MachineExecutor, type MachineTarget } from "./machines-model";

interface MachineDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** Called after the worker exists (list must refresh even if the dialog stays open). */
  readonly onCreated: () => void;
}

const TARGETS: readonly MachineTarget[] = ["compose", "k8s"];
const EXECUTORS: readonly MachineExecutor[] = ["claude", "codex"];
/** Same default as the kit route: built locally from deploy/worker/Dockerfile, not published anywhere. */
const DEFAULT_IMAGE = `carbon-worker:${version}`;

const EXECUTOR_LABEL: Readonly<Record<MachineExecutor, string>> = { claude: "Claude Code", codex: "Codex" };

function ChipGroup<T extends string>({ label, options, isSelected, onToggle, labelOf }: {
  readonly label: string;
  readonly options: readonly T[];
  readonly isSelected: (value: T) => boolean;
  readonly onToggle: (value: T) => void;
  readonly labelOf: (value: T) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="eyebrow">{label}</p>
      <div className="flex flex-wrap gap-1 self-start rounded-full border border-line p-0.5 font-mono text-[11px]">
        {options.map((value) => (
          <button key={value} type="button" aria-pressed={isSelected(value)} onClick={() => onToggle(value)} className={`rounded-full px-3 py-1 ${isSelected(value) ? "bg-btn text-btn-text" : "text-muted hover:text-ink"}`}>
            {labelOf(value)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The image is never pulled from a public registry: build it (and push it when more than one machine/cluster uses it). */
function ImageSteps({ image, target }: { readonly image: string; readonly target: MachineTarget }) {
  const hasRegistry = image.includes("/");
  const pushed = hasRegistry ? image : `<registry>/${image}`;
  const command =
    target === "k8s"
      ? `docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 -t ${pushed} --push .`
      : hasRegistry
        ? `docker build -f deploy/worker/Dockerfile -t ${image} . && docker push ${image}`
        : `docker build -f deploy/worker/Dockerfile -t ${image} .`;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="eyebrow">Imagem do worker (não vem pronta)</p>
      <p className="text-[12px] text-muted">No repositório do Carbon, na mesma versão do painel:</p>
      <CopyCommand command={command} />
      {!hasRegistry && (
        <p className="text-[12px] text-subtle">
          {target === "k8s"
            ? <>O cluster precisa baixar a imagem: publique num registry seu e troque <span className="font-mono">image:</span> no deployment.yaml (ou gere o kit com o campo Imagem preenchido).</>
            : <>Mais de uma máquina? Envie para um registry (<span className="font-mono">docker push</span>) e troque <span className="font-mono">image:</span> no docker-compose.yml (ou gere o kit com o campo Imagem preenchido).</>}
        </p>
      )}
    </div>
  );
}

function CreatedKit({ created, image }: { readonly created: CreatedMachine; readonly image: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-accent/50 bg-accent-weak p-4">
        <p className="flex items-center gap-2 text-[13px]"><KeyRound className="size-4" /> Token de <span className="font-mono">{created.worker.name}</span> (mostrado só agora):</p>
        <div className="mt-2"><CopyCommand command={created.token} /></div>
        <p className="mt-2 text-[12px] text-muted">Ele já está no kit ({created.target === "compose" ? ".env" : "secret.yaml"}). Não versione nem compartilhe esse arquivo. Perdeu? Revogue e crie outra máquina.</p>
      </div>
      <Button variant="accent" onClick={() => downloadBase64(created.kitBase64, created.filename)} className="self-start">
        <Download className="size-4" /> Baixar kit (.tar.gz)
      </Button>
      <ImageSteps image={image} target={created.target} />
      <div className="flex flex-col gap-1.5">
        <p className="eyebrow">Na máquina de destino</p>
        {nextCommands(created).map((command) => <CopyCommand key={command} command={command} />)}
        <p className="text-[12px] text-subtle">Antes de subir, preencha as credenciais do modelo (e do git, se usar) indicadas no README do kit.</p>
      </div>
    </div>
  );
}

/** "Adicionar máquina": generates a pool worker + its Compose/Kubernetes kit; shows the token once. */
export function MachineDialog({ isOpen, onClose, onCreated }: MachineDialogProps) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState<MachineTarget>("compose");
  const [replicas, setReplicas] = useState("1");
  const [parallel, setParallel] = useState("1");
  const [image, setImage] = useState("");
  const [executors, setExecutors] = useState<readonly MachineExecutor[]>(["claude"]);
  const [created, setCreated] = useState<CreatedMachine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // The token must not survive a close: reopening starts a fresh form.
  const close = useCallback(() => {
    setCreated(null);
    setError(null);
    setName("");
    setImage("");
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  const toggleExecutor = (value: MachineExecutor) =>
    setExecutors((current) => (current.includes(value) ? current.filter((e) => e !== value) : [...current, value]));

  const submit = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await api<Omit<CreatedMachine, "target">>("/api/admin/workers", {
        body: { name, target, replicas: Number(replicas), parallel: Number(parallel), executors, image: image.trim() || undefined },
      });
      setCreated({ ...data, target });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao criar a máquina");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
          <motion.div role="dialog" aria-modal="true" aria-label="Adicionar máquina" data-ascii="surface" className="card scroll-thin max-h-[88vh] w-full max-w-xl overflow-y-auto p-6 shadow-[var(--shadow-md)]" initial={{ y: -16, scale: 0.98, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 32 }} onClick={(e) => e.stopPropagation()}>
            <header className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">Pool de workers</p>
                <h2 className="mt-1 text-[18px] font-medium tracking-[-0.01em]">{created ? "Kit pronto" : "Adicionar máquina"}</h2>
              </div>
              <button type="button" onClick={close} aria-label="Fechar" className="rounded-full p-1.5 text-muted hover:text-ink"><X className="size-4" /></button>
            </header>
            {created ? (
              <CreatedKit created={created} image={image.trim() || DEFAULT_IMAGE} />
            ) : (
              <div className="flex flex-col gap-4">
                <Field label="Nome da máquina" placeholder="servidor-sp-01" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} hint="Aparece no painel e nas tarefas; vira o nome dos recursos (minúsculas e hífens)" />
                <ChipGroup label="Onde vai rodar" options={TARGETS} isSelected={(t) => t === target} onToggle={setTarget} labelOf={(t) => TARGET_LABEL[t]} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Réplicas" type="number" min={1} max={100} value={replicas} onChange={(e) => setReplicas(e.target.value)} hint="Processos de worker" />
                  <Field label="Tarefas em paralelo" type="number" min={1} max={64} value={parallel} onChange={(e) => setParallel(e.target.value)} hint="Por réplica" />
                </div>
                <Field label="Imagem (opcional)" placeholder={DEFAULT_IMAGE} value={image} onChange={(e) => setImage(e.target.value)} maxLength={255} hint="Vazio = imagem gerada localmente. Várias máquinas ou Kubernetes: use a do seu registry (ex.: ghcr.io/sua-org/carbon-worker)" />
                <ChipGroup label="Executores" options={EXECUTORS} isSelected={(e) => executors.includes(e)} onToggle={toggleExecutor} labelOf={(e) => EXECUTOR_LABEL[e]} />
                {error && <p role="alert" className="font-mono text-[12px] text-danger">{error}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>Cancelar</Button>
                  <Button onClick={() => void submit()} isLoading={isSaving} disabled={!name.trim() || executors.length === 0}>Gerar kit</Button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
