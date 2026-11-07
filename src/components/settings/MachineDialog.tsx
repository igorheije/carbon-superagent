"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, Globe, KeyRound, Network, TriangleAlert, X } from "lucide-react";
import { Button, CopyCommand, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { version } from "../../../package.json";
import { formatFingerprint } from "@/shared/fingerprint";
import { defaultConnection, downloadBase64, nextCommands, TARGET_LABEL, type ConnectionOptions, type CreatedMachine, type MachineConnection, type MachineExecutor, type MachineTarget } from "./machines-model";

interface MachineDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** Called after the worker exists (list must refresh even if the dialog stays open). */
  readonly onCreated: () => void;
  /** What this panel offers right now (listener IPs/fingerprint, public URL); null while loading. */
  readonly connection: ConnectionOptions | null;
}

const OTHER_ADDRESS = "__other__";

function ConnectionOption({ isSelected, onSelect, icon, title, detail, children }: {
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border transition-colors ${isSelected ? "border-accent bg-accent-weak" : "border-line hover:border-line-strong"}`}>
      <button type="button" role="radio" aria-checked={isSelected} onClick={onSelect} className="flex w-full items-start gap-3 p-3 text-left">
        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? "border-accent" : "border-line-strong"}`} aria-hidden>
          {isSelected && <span className="size-2 rounded-full bg-accent" />}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">{icon}{title}</span>
          <span className="text-[12px] text-muted">{detail}</span>
        </span>
      </button>
      {isSelected && children && <div className="flex flex-col gap-2 px-3 pb-3 pl-10">{children}</div>}
    </div>
  );
}

/** "Como ela chega no painel": direct by IP (pinned certificate) or the configured public URL. */
function ConnectionPicker({ options, value, onChange, address, onAddress }: {
  readonly options: ConnectionOptions | null;
  readonly value: MachineConnection;
  readonly onChange: (c: MachineConnection) => void;
  readonly address: string;
  readonly onAddress: (a: string) => void;
}) {
  const direct = options?.direct;
  const known = direct?.available ? direct.addresses : [];
  const isOther = address === OTHER_ADDRESS || (address !== "" && !known.includes(address));
  return (
    <div role="radiogroup" aria-label="Como ela chega no painel" className="flex flex-col gap-1.5">
      <p className="eyebrow">Como ela chega no painel</p>
      <ConnectionOption isSelected={value === "direct"} onSelect={() => onChange("direct")} icon={<Network className="size-3.5" />} title="IP deste computador" detail="Rede local ou IP público. Sem domínio nem túnel: o worker fixa o certificado deste painel.">
        {!direct && <p className="font-mono text-[11px] text-subtle">carregando…</p>}
        {direct && !direct.available && (
          <p className="flex gap-1.5 text-[12px] text-warn"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{direct.reason}</p>
        )}
        {direct?.available && (
          <>
            <div className="flex flex-wrap gap-1 font-mono text-[11px]">
              {known.map((ip) => (
                <button key={ip} type="button" aria-pressed={address === ip} onClick={() => onAddress(ip)} className={`rounded-full border px-3 py-1 ${address === ip ? "border-ink bg-btn text-btn-text" : "border-line text-muted hover:text-ink"}`}>
                  {ip}:{direct.port}
                </button>
              ))}
              <button type="button" aria-pressed={isOther} onClick={() => onAddress(OTHER_ADDRESS)} className={`rounded-full border px-3 py-1 ${isOther ? "border-ink bg-btn text-btn-text" : "border-line text-muted hover:text-ink"}`}>
                outro (IP público)
              </button>
            </div>
            {isOther && (
              <Field label="IP ou nome" placeholder="200.150.10.20" value={address === OTHER_ADDRESS ? "" : address} onChange={(e) => onAddress(e.target.value.trim() || OTHER_ADDRESS)} maxLength={253} hint={`Pela internet: libere a porta ${direct.port} no roteador (port forwarding) para este computador.`} />
            )}
            {direct.fingerprint && <p className="break-all font-mono text-[10px] text-subtle">certificado {formatFingerprint(direct.fingerprint)}</p>}
            <p className="text-[11px] text-subtle">O firewall do macOS pode perguntar se o Node aceita conexões: permita.</p>
          </>
        )}
      </ConnectionOption>
      <ConnectionOption
        isSelected={value === "public"}
        onSelect={() => onChange("public")}
        icon={<Globe className="size-3.5" />}
        title="URL pública"
        detail={options?.panelPublicUrl ? options.panelPublicUrl : "Domínio, Cloudflare Tunnel ou Tailscale. Não configurada: defina em Configurações → Execução."}
      />
    </div>
  );
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
export function MachineDialog({ isOpen, onClose, onCreated, connection }: MachineDialogProps) {
  const [name, setName] = useState("");
  const [connectionChoice, setConnectionChoice] = useState<MachineConnection | null>(null);
  const [address, setAddress] = useState("");
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
    setConnectionChoice(null);
    setAddress("");
    setImage("");
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // Until the admin picks, follow what the panel can do; the first LAN address is preselected.
  const chosenConnection = connectionChoice ?? defaultConnection(connection);
  const firstAddress = connection?.direct.available ? (connection.direct.addresses[0] ?? "") : "";
  const chosenAddress = address || firstAddress;
  const sentAddress = chosenAddress === OTHER_ADDRESS ? "" : chosenAddress;

  const toggleExecutor = (value: MachineExecutor) =>
    setExecutors((current) => (current.includes(value) ? current.filter((e) => e !== value) : [...current, value]));

  const submit = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await api<Omit<CreatedMachine, "target">>("/api/admin/workers", {
        body: {
          name,
          target,
          connection: chosenConnection,
          address: chosenConnection === "direct" ? sentAddress : undefined,
          replicas: Number(replicas),
          parallel: Number(parallel),
          executors,
          image: image.trim() || undefined,
        },
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
                <p className="rounded-xl border border-line bg-surface-muted px-3 py-2 text-[12px] text-muted">
                  Gera um kit <span className="font-mono">Docker Compose</span>/<span className="font-mono">Kubernetes</span>. Sem Docker na outra máquina? Feche e use <span className="font-medium text-ink">Entrar no cluster</span>: um único comando <span className="font-mono">carbon join</span>.
                </p>
                <ConnectionPicker options={connection} value={chosenConnection} onChange={setConnectionChoice} address={chosenAddress} onAddress={setAddress} />
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
                  <Button onClick={() => void submit()} isLoading={isSaving} disabled={!name.trim() || executors.length === 0 || (chosenConnection === "direct" && !sentAddress)}>Gerar kit</Button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
