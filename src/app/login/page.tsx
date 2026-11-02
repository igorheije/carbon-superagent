"use client";

import { useEffect, useState } from "react";
import { AsciiReveal } from "ascii-reveal";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/setup/status")
      .then((s) => s.needsSetup && window.location.replace("/setup"))
      .catch(() => null);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { email, password } });
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "falha no login");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <AsciiReveal revealOnHydrate preset="terminal" duration="cinematic" className="w-full max-w-sm">
      <motion.form
        onSubmit={(e) => void submit(e)}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.2, 0, 0.2, 1] }}
        data-ascii="surface" className="card w-full p-7"
      >
        <p className="text-[22px] font-semibold tracking-[-0.02em]"><span className="flex items-baseline gap-1.5">Carbon<span className="font-mono text-[0.45em] font-medium uppercase tracking-[0.14em] text-accent">SuperAgent</span></span></p>
        <p className="mt-1 text-[14px] text-muted">Entre para acompanhar seus agentes.</p>
        <div className="mt-6 flex flex-col gap-4">
          <Field label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={error} />
        </div>
        <Button type="submit" isLoading={isLoading} className="mt-6 w-full">
          Entrar <ArrowRight className="size-4" />
        </Button>
        <p className="mt-4 text-center text-[12px] text-subtle">Sem conta? Peça ao admin para te convidar em Configurações → Pessoas.</p>
      </motion.form>
      </AsciiReveal>
    </div>
  );
}
