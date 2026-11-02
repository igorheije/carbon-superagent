"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CheckList } from "@/components/setup/CheckList";
import { useSession } from "@/components/session/SessionProvider";
import { Button } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api, type SystemCheck } from "@/lib/client/api";

const LABELS = ["Node.js", "Git", "GitHub CLI", "Claude Code", "Codex CLI", "Repositório"];

export default function EnvironmentPage() {
  const { settings } = useSession();
  const [checks, setChecks] = useState<readonly SystemCheck[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api<{ checks: SystemCheck[] }>("/api/system/check");
      setChecks(data.checks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha");
    } finally {
      setIsLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="eyebrow">Doctor · executores · integrações</p>
          <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Ambiente</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">O que este computador consegue rodar agora. Mesmo diagnóstico do <code className="font-mono text-[13px]">npm run doctor</code>.</p>
        </div>
        <Button variant="ghost" onClick={() => void load()} isLoading={isLoading}><RefreshCw className="size-4" /> Verificar de novo</Button>
      </section>
      {error && <p className="font-mono text-[12px] text-danger">{error}</p>}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <CheckList checks={checks} isLoading={isLoading} labels={LABELS} />
        </div>
        <div className="flex flex-col gap-5 lg:col-span-2">
          <Panel eyebrow="Como o Carbon chama os agentes" title="Sem API key extra">
            <ul className="flex flex-col gap-2 font-mono text-[11.5px] leading-relaxed text-muted">
              <li><span className="text-ink">claude</span> -p … --output-format stream-json --permission-mode {settings?.permissionProfile === "guarded" ? "acceptEdits" : settings?.permissionProfile === "auto" ? "auto" : "bypassPermissions"}</li>
              <li><span className="text-ink">codex</span> exec --json -C &lt;worktree&gt; --sandbox workspace-write …</li>
            </ul>
            <p className="mt-3 text-[12px] text-muted">Cada CLI usa o login que já existe no seu computador (plano Claude Pro/Max ou ChatGPT). O Carbon nunca lê nem guarda esses tokens.</p>
          </Panel>
          <Panel eyebrow="Integrações" title="Fontes de tarefa">
            <ul className="flex flex-col gap-2 text-[13px]">
              <li className="flex justify-between"><span>Linear</span><span className="font-mono text-[11px] text-muted">{settings?.linearConfigured ? "configurado" : "sem API key"}</span></li>
              <li className="flex justify-between"><span>GitHub issues / PRs</span><span className="font-mono text-[11px] text-muted">{checks.find((c) => c.id === "gh")?.status === "ok" ? "via gh" : "gh ausente"}</span></li>
              <li className="flex justify-between"><span>Push automático</span><span className="font-mono text-[11px] text-muted">{settings?.autoPush ? "ligado" : "desligado"}</span></li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
