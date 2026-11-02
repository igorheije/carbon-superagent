"use client";

import { useCallback, useEffect, useState } from "react";
import { AsciiReveal } from "ascii-reveal";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Launch } from "@/components/setup/Launch";
import { StepEnvironment, StepExecutor, StepIntegrations, StepProfile, StepWelcome, type SetupDraft } from "@/components/setup/steps";
import { Button } from "@/components/ui/Form";
import { api, isUsable, type SystemCheck } from "@/lib/client/api";

const STEPS = ["Início", "Ambiente", "Agente", "Perfil", "Integrações"] as const;
const LAUNCH = STEPS.length;

const INITIAL: SetupDraft = {
  repoPath: "",
  executor: "claude",
  name: "",
  email: "",
  password: "",
  persona: "engineering",
  linearApiKey: "",
  autoPush: false,
  aiSummary: true,
};

type Errors = Partial<Record<keyof SetupDraft, string>>;

function validateProfile(d: SetupDraft): Errors {
  return {
    ...(d.name.trim().length < 2 ? { name: "informe seu nome" } : {}),
    ...(!/^\S+@\S+\.\S+$/.test(d.email) ? { email: "e-mail inválido" } : {}),
    ...(d.password.length < 10 ? { password: "mín. 10 caracteres" } : {}),
  };
}

function canAdvance(step: number, checks: readonly SystemCheck[], draft: SetupDraft): string | null {
  if (step === 1) {
    const byId = (id: string) => checks.find((c) => c.id === id)?.status;
    if (!checks.length) return "rode a verificação";
    if (byId("node") === "missing" || byId("git") === "missing") return "Node e Git são obrigatórios";
    if (!isUsable(checks.find((c) => c.id === "claude")) && !isUsable(checks.find((c) => c.id === "codex"))) return "instale Claude Code ou Codex (basta um)";
    if (byId("repo") !== "ok") return "informe um repositório git válido";
  }
  if (step === 2 && !isUsable(checks.find((c) => c.id === draft.executor))) return "escolha um agente instalado";
  if (step === 3 && Object.keys(validateProfile(draft)).length) return "complete seu perfil";
  return null;
}

export default function SetupPage() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [draft, setDraft] = useState<SetupDraft>(INITIAL);
  const [checks, setChecks] = useState<readonly SystemCheck[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/setup/status")
      .then((s) => !s.needsSetup && window.location.replace("/login"))
      .catch(() => null);
  }, []);

  const patch = useCallback((p: Partial<SetupDraft>) => setDraft((d) => ({ ...d, ...p })), []);

  const recheck = useCallback(async () => {
    setIsChecking(true);
    try {
      const data = await api<{ checks: SystemCheck[] }>("/api/setup/check", { body: { repoPath: draft.repoPath } });
      await new Promise((r) => setTimeout(r, 600));
      setChecks(data.checks);
      const hasClaude = isUsable(data.checks.find((c) => c.id === "claude"));
      const hasCodex = isUsable(data.checks.find((c) => c.id === "codex"));
      if (!hasClaude && hasCodex) patch({ executor: "codex" });
      if (hasClaude && !hasCodex) patch({ executor: "claude" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha na verificação");
    } finally {
      setIsChecking(false);
    }
  }, [draft.repoPath, patch]);

  useEffect(() => {
    if (step === 1 && !checks.length && !isChecking) void recheck();
  }, [step, checks.length, isChecking, recheck]);

  const go = (delta: number) => {
    setError(null);
    setDirection(delta);
    setStep((s) => Math.max(0, Math.min(LAUNCH, s + delta)));
  };

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await api("/api/setup/complete", { body: { ...draft, linearApiKey: draft.linearApiKey || undefined } });
      go(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao concluir");
    } finally {
      setIsSubmitting(false);
    }
  };

  const next = () => {
    if (step === 3) {
      const found = validateProfile(draft);
      setErrors(found);
      if (Object.keys(found).length) return;
    }
    const blocker = canAdvance(step, checks, draft);
    if (blocker) return setError(blocker);
    if (step === STEPS.length - 1) return void submit();
    go(1);
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-5 py-8 md:py-12">
      <header className="flex items-center justify-between">
        <span className="text-[17px] font-semibold tracking-[-0.02em]"><span className="flex items-baseline gap-1.5">Carbon<span className="font-mono text-[0.45em] font-medium uppercase tracking-[0.14em] text-accent">SuperAgent</span></span></span>
        <ol className="flex items-center gap-1.5" aria-label="Progresso">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <motion.span
                className="block h-1.5 rounded-full"
                animate={{ width: i === step ? 28 : 8, backgroundColor: i <= step ? "var(--accent)" : "var(--border-strong)" }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                aria-label={label}
              />
            </li>
          ))}
        </ol>
      </header>

      <section className="relative mt-10 flex-1 md:mt-16">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={step}
            custom={direction}
            initial={{ opacity: 0, x: direction * 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -40 }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0.2, 1] }}
          >
            <AsciiReveal revealOnHydrate preset={step === 0 ? "terminal" : step === LAUNCH ? "blueprint" : "decode"} duration={step === 0 || step === LAUNCH ? "cinematic" : "fast"} origin="top-left">
              {step === 0 && <StepWelcome />}
            {step === 1 && <StepEnvironment draft={draft} patch={patch} checks={checks} isLoading={isChecking} onRecheck={() => void recheck()} />}
            {step === 2 && <StepExecutor draft={draft} patch={patch} checks={checks} />}
            {step === 3 && <StepProfile draft={draft} patch={patch} errors={errors} />}
            {step === 4 && <StepIntegrations draft={draft} patch={patch} checks={checks} />}
            {step === LAUNCH && <Launch name={draft.name} />}
            </AsciiReveal>
          </motion.div>
        </AnimatePresence>
      </section>

      <footer className="mt-10 flex items-center justify-between gap-3 border-t border-line pt-5">
        {step > 0 && step < LAUNCH ? (
          <Button variant="ghost" onClick={() => go(-1)}>
            <ArrowLeft className="size-4" /> Voltar
          </Button>
        ) : (
          <span />
        )}
        <AnimatePresence>
          {error && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="alert" className="text-center font-mono text-[12px] text-danger">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
        {step < LAUNCH ? (
          <Button variant={step === STEPS.length - 1 ? "accent" : "primary"} onClick={next} isLoading={isSubmitting}>
            {step === 0 ? "Começar" : step === STEPS.length - 1 ? "Ligar o Carbon" : "Continuar"} <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button variant="accent" onClick={() => window.location.assign("/")}>
            Abrir Mission Control <ArrowRight className="size-4" />
          </Button>
        )}
      </footer>
    </div>
  );
}
