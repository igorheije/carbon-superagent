"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api, type PublicSettings } from "@/lib/client/api";
import { ModelPicker } from "@/components/ui/ModelPicker";
import { ApprovalRules } from "./ApprovalRules";

function Segmented<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: readonly { value: T; label: string; hint: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="grid grid-cols-1 gap-2 md:grid-cols-3">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)} className={`relative rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${value === o.value ? "border-accent" : "border-line hover:border-line-strong"}`}>
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-xl bg-accent-weak" />}
          <span className="relative block font-mono text-[12px]">[ {o.label} ]</span>
          <span className="relative mt-1 block text-[12px] leading-snug text-muted">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

export function ExecutionTab() {
  const { settings, executors, refresh } = useSession();
  const [draft, setDraft] = useState<PublicSettings | null>(settings);
  const [linearKey, setLinearKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  if (!draft) return null;
  const set = (patch: Partial<PublicSettings>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { ...draft, linearApiKey: linearKey };
      delete body.linearConfigured;
      await api("/api/settings", { method: "PUT", body });
      setLinearKey("");
      await refresh();
      setMessage("configurações salvas");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel eyebrow="Agente" title="Executor padrão">
        <Segmented id="exec" value={draft.defaultExecutor} onChange={(v) => set({ defaultExecutor: v })} options={[
          { value: "claude", label: "claude code", hint: executors?.claude === false ? "não instalado nesta máquina" : "claude -p · stream-json · login do seu plano", disabled: executors?.claude === false },
          { value: "codex", label: "codex", hint: executors?.codex === false ? "não instalado nesta máquina" : "codex exec --json · login do ChatGPT", disabled: executors?.codex === false },
        ]} />
        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow">Modelo padrão · Claude Code</p>
            <ModelPicker executor="claude" value={draft.claudeModel || "auto"} onChange={(v) => set({ claudeModel: v })} effort={draft.claudeEffort || "auto"} onEffortChange={(v) => set({ claudeEffort: v })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow">Modelo padrão · Codex</p>
            <ModelPicker executor="codex" value={draft.codexModel || "auto"} onChange={(v) => set({ codexModel: v })} effort={draft.codexEffort || "auto"} onEffortChange={(v) => set({ codexEffort: v })} />
          </div>
        </div>
        <p className="mt-3 text-[12px] text-muted">
          Automático (em modelo e/ou esforço): lê título e descrição da tarefa e escolhe o nível; dá para fixar só um dos dois. Tarefas pontuais → Haiku com esforço baixo; escopo médio → Sonnet; refactors, segurança, migração ou muitos arquivos → Opus com esforço alto. No Codex, mantém o modelo da CLI e ajusta o esforço de raciocínio. Dá para trocar em cada tarefa.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Tempo máximo por tarefa (min)" type="number" min={5} max={240} value={draft.maxRunMinutes} onChange={(e) => set({ maxRunMinutes: Number(e.target.value) })} />
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 md:col-span-2">
            <input type="checkbox" checked={draft.aiProjectSummary} onChange={(e) => set({ aiProjectSummary: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
            <span className="text-[13px]">Visão geral do projeto por IA ao indexar<span className="block text-[12px] text-muted">O agente lê o repositório em modo somente leitura (modelo rápido) e escreve o que o projeto faz. Vai para o contexto de toda tarefa.</span></span>
          </label>
        </div>
      </Panel>
      <Panel eyebrow="Permissões" title="O que o agente pode fazer sozinho">
        <Segmented id="perm" value={draft.permissionProfile} onChange={(v) => set({ permissionProfile: v })} options={[
          { value: "guarded", label: "guarded", hint: "Edita arquivos e roda só testes/build/lint conhecidos. Recomendado." },
          { value: "auto", label: "auto", hint: "Claude decide com classificador; Codex em sandbox do worktree." },
          { value: "unrestricted", label: "unrestricted", hint: "Sem checagens. Só em máquina/container descartável." },
        ]} />
        <p className="mt-3 text-[12px] text-muted">Em todos os modos o agente não faz commit/push: o Carbon faz isso depois, só no branch agent/*. Em guarded e auto, o que não estiver liberado vira um pedido de permissão no painel (Claude Code).</p>
        <div className="mt-5">
          <p className="eyebrow mb-2">Quando o agente pede permissão</p>
          <Segmented id="approval" value={draft.approvalPolicy} onChange={(v) => set({ approvalPolicy: v })} options={[
            { value: "smart", label: "inteligente", hint: "Aprova sozinho o que é de baixo risco dentro do projeto (ler, editar, testar, build). Pergunta só instalações, rede e ações fora do projeto." },
            { value: "autonomous", label: "autônomo", hint: "Nunca pergunta. Ações perigosas (sudo, git push, rm -rf fora do projeto, segredos) continuam bloqueadas." },
            { value: "ask", label: "perguntar tudo", hint: "Mostra um pedido para cada ação fora da lista liberada do perfil." },
          ]} />
          <ApprovalRules />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Prazo para responder permissões (min)" type="number" min={1} max={120} value={draft.permissionTimeoutMinutes} onChange={(e) => set({ permissionTimeoutMinutes: Number(e.target.value) })} hint="sem resposta, o pedido é negado" />
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 md:col-span-2">
            <input type="checkbox" checked={draft.isolateClaudeConfig} onChange={(e) => set({ isolateClaudeConfig: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
            <span className="text-[13px]">Isolar configurações pessoais do Claude<span className="block text-[12px] text-muted">Ignora suas configurações globais, hooks e MCPs nas execuções (as do projeto continuam valendo). Garante que o perfil de permissão acima seja respeitado e reduz muito o contexto de cada tarefa.</span></span>
          </label>
        </div>
      </Panel>
      <Panel eyebrow="Memória" title="Memória do Claude Code">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
          <input type="checkbox" checked={draft.useClaudeMemory} onChange={(e) => set({ useClaudeMemory: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
          <span className="text-[13px]">Usar a memória do Claude Code de cada repositório<span className="block text-[12px] text-muted">Antes de cada tarefa, o Carbon lê a memória que o Claude Code já salvou para o repositório do projeto (a mesma que você usa no terminal) e entrega ao agente. Só leitura: os arquivos de memória não são alterados.</span></span>
        </label>
        <div role="note" className="mt-3 rounded-xl border border-line p-3 text-[12px] text-warn">
          <p className="font-medium">Atenção: use esta opção só se o painel tiver uma única conta.</p>
          <p className="mt-1">A memória lida é a do usuário do computador onde o Carbon roda, com tudo o que foi salvo nela: preferências, decisões, contexto de projetos e o que mais estiver lá. Com a opção ligada, toda tarefa, de qualquer conta do painel, recebe essa memória. Revise o que está salvo antes de ligar e não guarde segredos ou dados pessoais nela.</p>
        </div>
      </Panel>
      <Panel eyebrow="Entrega" title="Como entregar">
        <p className="mb-3 text-[12px] text-muted">Repositório e branch base agora ficam em cada projeto (aba Projetos).</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Segmented id="accept" value={draft.acceptMode} onChange={(v) => set({ acceptMode: v })} options={[
            { value: "observe", label: "observe", hint: "PRs como draft." },
            { value: "act", label: "act", hint: "PRs prontos para review." },
          ]} />
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
            <input type="checkbox" checked={draft.autoPush} onChange={(e) => set({ autoPush: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
            <span className="text-[13px]">Push + PR via gh<span className="block text-[12px] text-muted">Desligado = só commit local no worktree.</span></span>
          </label>
        </div>
      </Panel>
      <Panel eyebrow="Linear" title={draft.linearConfigured ? "API key configurada" : "Não configurado"}>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <Field label="Nova API key" type="password" placeholder={draft.linearConfigured ? "•••••• (deixe vazio para manter)" : "lin_api_…"} value={linearKey} onChange={(e) => setLinearKey(e.target.value)} />
          </div>
          {draft.linearConfigured && <Button variant="ghost" onClick={() => setLinearKey("-")}>Remover key</Button>}
        </div>
      </Panel>
      <div className="flex items-center justify-end gap-3">
        {message && <p role="status" className="font-mono text-[12px] text-muted">{message}</p>}
        <Button onClick={() => void save()} isLoading={isSaving}>Salvar configurações</Button>
      </div>
    </div>
  );
}
