"use client";

import { Field } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { runtimeOptionsOf } from "@/components/mission/RuntimePicker";

/** Settings fields for remote runtimes (mirrors agentcore/panelPublicUrl in repo/settings.ts). */
export interface AgentCoreSettingsDraft {
  readonly enabled: boolean;
  readonly region: string;
  readonly runtimeArn: string;
  readonly qualifier: string;
  readonly maxConcurrent: number;
}

export interface RemoteRuntimesDraft {
  readonly panelPublicUrl: string;
  readonly agentcore: AgentCoreSettingsDraft;
}

const AGENTCORE_DEFAULTS: AgentCoreSettingsDraft = { enabled: false, region: "sa-east-1", runtimeArn: "", qualifier: "DEFAULT", maxConcurrent: 3 };

/** Reads the remote-runtime fields from the settings payload, with defaults for older panels. */
export function remoteRuntimesOf(settings: unknown): RemoteRuntimesDraft {
  const raw = (settings ?? {}) as Partial<RemoteRuntimesDraft>;
  return { panelPublicUrl: raw.panelPublicUrl ?? "", agentcore: { ...AGENTCORE_DEFAULTS, ...raw.agentcore } };
}

interface RemoteRuntimesPanelProps {
  readonly value: RemoteRuntimesDraft;
  /** Availability as last saved (from the server), shown as the current status. */
  readonly saved: unknown;
  readonly onChange: (next: RemoteRuntimesDraft) => void;
}

export function RemoteRuntimesPanel({ value, saved, onChange }: RemoteRuntimesPanelProps) {
  const agentcore = value.agentcore;
  const setAgentCore = (patch: Partial<AgentCoreSettingsDraft>) => onChange({ ...value, agentcore: { ...agentcore, ...patch } });
  const status = runtimeOptionsOf(saved).agentcore;
  return (
    <Panel eyebrow="Execução remota" title="Workers e AgentCore">
      <Field
        label="URL pública do painel"
        placeholder="https://carbon.sua-empresa.dev"
        value={value.panelPublicUrl}
        onChange={(e) => onChange({ ...value, panelPublicUrl: e.target.value })}
        hint="HTTPS onde workers e containers AgentCore alcançam /api/worker/* (túnel ou VPN)"
      />
      <div className="mt-5 flex flex-col gap-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
          <input type="checkbox" checked={agentcore.enabled} onChange={(e) => setAgentCore({ enabled: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
          <span className="text-[13px]">
            AgentCore Runtime (experimental)
            <span className="block text-[12px] text-muted">Roda tarefas numa sessão do AWS Bedrock AgentCore na sua conta. Experimental. As credenciais AWS vêm da máquina do painel (AWS_PROFILE, SSO ou variáveis de ambiente); nada é guardado aqui.</span>
          </span>
        </label>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="ARN do runtime" placeholder="arn:aws:bedrock-agentcore:sa-east-1:123456789012:runtime/carbon-worker" value={agentcore.runtimeArn} onChange={(e) => setAgentCore({ runtimeArn: e.target.value })} />
          <Field label="Região AWS" value={agentcore.region} onChange={(e) => setAgentCore({ region: e.target.value })} />
          <Field label="Qualifier (endpoint)" value={agentcore.qualifier} onChange={(e) => setAgentCore({ qualifier: e.target.value })} hint="DEFAULT quando não há endpoint próprio" />
          <Field label="Sessões simultâneas (máx.)" type="number" min={1} max={20} value={agentcore.maxConcurrent} onChange={(e) => setAgentCore({ maxConcurrent: Number(e.target.value) })} hint="limita custo" />
        </div>
        <p role="status" className={`font-mono text-[12px] ${status.available ? "text-muted" : "text-warn"}`}>
          {status.available ? "AgentCore disponível no seletor “Onde rodar”" : `AgentCore indisponível: ${status.reason ?? "—"}`}
        </p>
      </div>
    </Panel>
  );
}
