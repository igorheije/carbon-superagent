"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import { relativeTime } from "./machines-model";

/** Mirrors ClaudeShareStatus in src/server/claude-share.ts. */
interface ShareStatus {
  readonly state: "off" | "starting" | "on" | "error" | "unsupported";
  readonly port: number;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly requests: number;
  readonly failures: number;
  readonly lastRequestAt: number | null;
}

interface ShareResponse {
  readonly enabled: boolean;
  readonly status: ShareStatus;
}

const REFRESH_MS = 5_000;

const STATE_LABEL: Readonly<Record<ShareStatus["state"], string>> = {
  off: "desligado",
  starting: "ligando… (o macOS pode pedir permissão para acessar o login do Claude Code: clique em Permitir sempre)",
  on: "ligado",
  error: "não ligou",
  unsupported: "indisponível",
};

/** EXPERIMENTAL — Configurações → Máquinas: let pool workers use this Mac's Claude Code login. */
export function ClaudeSharePanel() {
  const [data, setData] = useState<ShareResponse | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api<ShareResponse>("/api/admin/claude-share")
      .then((d) => {
        setData(d);
        setNow(Date.now());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao carregar"));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const toggle = () => {
    if (!data) return;
    const enabled = !data.enabled;
    if (enabled && !window.confirm("Os workers do cluster vão usar a SUA conta do Claude Code (mesmo plano e mesmos limites de uso). Quem tiver acesso de administrador a essas máquinas consegue usar a conta enquanto isso estiver ligado. Ligar?")) return;
    setIsBusy(true);
    setError(null);
    setData({ ...data, status: { ...data.status, state: enabled ? "starting" : "off" } });
    api<ShareResponse>("/api/admin/claude-share", { method: "POST", body: { enabled } })
      .then((d) => {
        setData(d);
        setNow(Date.now());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao alterar"))
      .finally(() => setIsBusy(false));
  };

  const status = data?.status;
  const isOn = data?.enabled === true && status?.state === "on";
  const isUnsupported = status?.state === "unsupported";

  return (
    <Panel
      eyebrow="Experimental"
      title="Claude Code deste computador para os workers"
      aside={
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label="Compartilhar o Claude Code deste computador com os workers"
          disabled={!data || isBusy || isUnsupported}
          onClick={toggle}
          className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${isOn ? "bg-accent ring-accent" : "bg-surface-sunken ring-line-strong"}`}
        >
          {/* track 48px − padding 4px − knob 24px = 20px of travel (translate-x-5) */}
          <span aria-hidden className={`size-6 rounded-full bg-white shadow-sm transition-transform duration-200 ${isOn ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      }
    >
      <div className="flex flex-col gap-3 text-[12px] text-muted">
        <p className="flex max-w-3xl gap-2">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>
            Os workers usam o login do Claude Code que já está neste Mac, sem copiar nenhuma credencial para eles. O login fica no Keychain e quem renova é o próprio Claude Code daqui. Os workers chegam por <span className="font-mono">127.0.0.1:{status?.port ?? 8787}</span> pelo túnel SSH.
          </span>
        </p>
        {status && (
          <p className="font-mono text-[11px]">
            <span className={status.state === "on" ? "text-ok" : status.state === "error" ? "text-danger" : "text-subtle"}>● {STATE_LABEL[status.state]}</span>
            {status.state === "on" && (
              <span className="text-subtle">
                {" "}· {status.requests} chamada{status.requests === 1 ? "" : "s"}
                {status.failures > 0 && <span className="text-warn"> ({status.failures} recusada{status.failures === 1 ? "" : "s"})</span>}
                {" "}· última {relativeTime(status.lastRequestAt, now)}
              </span>
            )}
            {status.error && <span className="block pt-1 text-danger">{status.error}</span>}
          </p>
        )}
        {error && <p role="alert" className="font-mono text-[11px] text-danger">{error}</p>}
        <p className="flex max-w-3xl gap-2 text-[11px] text-subtle">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>Ligue só com máquinas que você controla. O consumo sai do seu plano, e o código das tarefas continua indo para o worker.</span>
        </p>
      </div>
    </Panel>
  );
}
