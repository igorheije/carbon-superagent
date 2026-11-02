"use client";

import { motion } from "motion/react";
import { Field, PersonaPicker } from "@/components/ui/Form";
import { isUsable, type SystemCheck } from "@/lib/client/api";
import type { PersonaId } from "@/lib/domain/personas";
import { CheckList } from "./CheckList";

export interface SetupDraft {
  readonly repoPath: string;
  readonly executor: "claude" | "codex";
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly persona: PersonaId;
  readonly linearApiKey: string;
  readonly autoPush: boolean;
  readonly aiSummary: boolean;
}

export type Patch = (patch: Partial<SetupDraft>) => void;

export function StepWelcome() {
  return (
    <div className="flex flex-col items-start gap-6">
      <p className="eyebrow">Setup · leva ~2 minutos</p>
      <h1 className="text-[clamp(44px,8vw,88px)] font-semibold leading-[0.95] tracking-[-0.04em]">
        Carbon <span className="text-muted">SuperAgent</span>
      </h1>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }} className="max-w-xl text-[17px] leading-relaxed text-muted">
        Agentes que pegam uma tarefa do Linear ou GitHub e entregam um PR revisável — rodando no <span className="text-ink">seu computador</span>, com o{" "}
        <span className="text-ink">Claude Code</span> ou o <span className="text-ink">Codex</span> do seu plano.
      </motion.p>
      <motion.ul initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.9 } } }} className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
        {["Checar o ambiente", "Escolher o agente", "Criar seu perfil"].map((text, i) => (
          <motion.li key={text} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className="rounded-xl border border-line bg-surface p-3">
            <p className="font-mono text-[11px] text-accent">0{i + 1}</p>
            <p className="mt-1 text-[14px]">{text}</p>
          </motion.li>
        ))}
      </motion.ul>
    </div>
  );
}

export function StepEnvironment({ draft, patch, checks, isLoading, onRecheck }: { draft: SetupDraft; patch: Patch; checks: readonly SystemCheck[]; isLoading: boolean; onRecheck: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="eyebrow">01 · Ambiente</p>
        <h2 className="mt-2 text-[34px] font-semibold tracking-[-0.03em]">Vamos olhar sua máquina</h2>
        <p className="mt-1 text-[14px] text-muted">Precisamos de Node, Git e pelo menos um agente: Claude Code ou Codex. O GitHub CLI é opcional (abre PRs).</p>
      </header>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onRecheck();
        }}
      >
        <div className="flex-1">
          <Field label="Repositório (clone local)" placeholder="/Users/voce/code/meu-projeto" value={draft.repoPath} onChange={(e) => patch({ repoPath: e.target.value })} hint="Pasta raiz de um repositório git. Os agentes trabalham em worktrees isolados, nunca no seu branch atual." />
        </div>
        <button type="submit" className="mb-[26px] rounded-full border border-line px-4 py-2.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-ink">
          Verificar
        </button>
      </form>
      <CheckList checks={checks} isLoading={isLoading} labels={["Node.js", "Git", "GitHub CLI", "Claude Code", "Codex CLI", "Repositório"]} />
    </div>
  );
}

const EXECUTORS = [
  { id: "claude" as const, name: "Claude Code", vendor: "Anthropic", note: "Usa o login do seu plano Pro/Max (ou API key). Skills nativas em .claude/skills." },
  { id: "codex" as const, name: "Codex", vendor: "OpenAI", note: "Usa o login do ChatGPT (codex login). Sandbox de escrita restrito ao worktree." },
];

export function StepExecutor({ draft, patch, checks }: { draft: SetupDraft; patch: Patch; checks: readonly SystemCheck[] }) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="eyebrow">02 · Agente</p>
        <h2 className="mt-2 text-[34px] font-semibold tracking-[-0.03em]">Quem executa as tarefas</h2>
        <p className="mt-1 text-[14px] text-muted">Basta um dos dois. Com os dois instalados, você escolhe por tarefa. Nada é cobrado à parte: o Carbon chama a CLI que você já usa.</p>
      </header>
      <div role="radiogroup" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {EXECUTORS.map((ex) => {
          const check = checks.find((c) => c.id === ex.id);
          const isAvailable = isUsable(check);
          const isSelected = draft.executor === ex.id;
          return (
            <motion.button
              key={ex.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={!isAvailable}
              whileHover={isAvailable ? { y: -3 } : undefined}
              onClick={() => patch({ executor: ex.id })}
              className={`relative overflow-hidden rounded-2xl border p-5 text-left transition-colors disabled:opacity-45 ${isSelected ? "border-accent" : "border-line hover:border-line-strong"}`}
            >
              {isSelected && <motion.span layoutId="executor-glow" className="absolute inset-0 bg-accent-weak" transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
              <div className="relative">
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">{ex.vendor}</p>
                <p className="mt-1 text-[24px] font-semibold tracking-[-0.02em]">{ex.name}</p>
                <p className="mt-2 text-[13px] leading-snug text-muted">{ex.note}</p>
                <p className={`mt-4 font-mono text-[11px] ${isAvailable ? "text-ok" : "text-subtle"}`}>{check ? (isAvailable ? `✓ ${check.detail}` : "não instalado") : "…"}</p>
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

export function StepProfile({ draft, patch, errors }: { draft: SetupDraft; patch: Patch; errors: Partial<Record<keyof SetupDraft, string>> }) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="eyebrow">03 · Seu perfil</p>
        <h2 className="mt-2 text-[34px] font-semibold tracking-[-0.03em]">Você é o admin</h2>
        <p className="mt-1 text-[14px] text-muted">Depois você convida produto, design e QA — cada persona recebe skills e entregáveis próprios.</p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Nome" autoComplete="name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} error={errors.name} />
        <Field label="E-mail" type="email" autoComplete="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} error={errors.email} />
        <Field label="Senha" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => patch({ password: e.target.value })} error={errors.password} hint="mín. 10 caracteres" />
      </div>
      <div>
        <p className="eyebrow mb-2">Persona</p>
        <PersonaPicker value={draft.persona} onChange={(persona) => patch({ persona })} />
      </div>
    </div>
  );
}

export function StepIntegrations({ draft, patch, checks }: { draft: SetupDraft; patch: Patch; checks: readonly SystemCheck[] }) {
  const gh = checks.find((c) => c.id === "gh");
  const canPush = gh?.status === "ok";
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="eyebrow">04 · Integrações (opcional)</p>
        <h2 className="mt-2 text-[34px] font-semibold tracking-[-0.03em]">De onde vêm as tarefas</h2>
        <p className="mt-1 text-[14px] text-muted">Sem nada aqui você já cria tarefas manualmente. Dá para configurar depois.</p>
      </header>
      <Field
        label="Linear · API key pessoal"
        type="password"
        placeholder="lin_api_…"
        value={draft.linearApiKey}
        onChange={(e) => patch({ linearApiKey: e.target.value })}
        hint="Linear → Settings → Security & access → Personal API keys. Fica só neste computador."
      />
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4">
        <input type="checkbox" checked={draft.aiSummary} onChange={(e) => patch({ aiSummary: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
        <span>
          <span className="block text-[14px]">Gerar visão geral do projeto com IA</span>
          <span className="block text-[12px] text-muted">Logo após o setup, o Carbon mapeia o repositório (arquivos, imports, stack) e o seu agente lê em modo somente leitura para descrever o que o projeto faz. Deixa o research das tarefas bem mais rápido.</span>
        </span>
      </label>
      <label className={`flex items-start gap-3 rounded-xl border border-line p-4 ${canPush ? "cursor-pointer" : "opacity-60"}`}>
        <input type="checkbox" disabled={!canPush} checked={draft.autoPush && canPush} onChange={(e) => patch({ autoPush: e.target.checked })} className="mt-1 accent-[var(--accent)]" />
        <span>
          <span className="block text-[14px]">Fazer push e abrir PR no GitHub</span>
          <span className="block text-[12px] text-muted">
            {canPush ? "Usa seu login do gh. Em modo observe, PRs saem como draft." : "Requer GitHub CLI autenticado (gh auth login). Sem isso, o Carbon só faz commit local."}
          </span>
        </span>
      </label>
    </div>
  );
}
