"use client";

import { useState } from "react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, Field, PersonaPicker } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import type { PersonaId } from "@/lib/domain/personas";

export function ProfileTab() {
  const { user, refresh } = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [persona, setPersona] = useState<PersonaId>(user?.persona ?? "engineering");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setIsSaving(true);
    setMessage(null);
    try {
      await fn();
      await refresh();
      setMessage(success);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) return null;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <Panel eyebrow="Perfil" title={user.email} className="lg:col-span-2">
        <div className="flex flex-col gap-4">
          <Field label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <p className="eyebrow mb-2">Persona — define framing, entregável e skills padrão</p>
            <PersonaPicker value={persona} onChange={setPersona} />
          </div>
          <div className="flex justify-end">
            <Button isLoading={isSaving} onClick={() => void run(() => api("/api/profile", { method: "PATCH", body: { name, persona } }), "perfil salvo")}>Salvar perfil</Button>
          </div>
        </div>
      </Panel>
      <Panel eyebrow="Segurança" title={user.mustChangePassword ? "Troque sua senha temporária" : "Senha"}>
        <div className="flex flex-col gap-3">
          <Field label="Senha atual" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <Field label="Nova senha" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="mín. 10 caracteres" />
          <Button
            variant="ghost"
            isLoading={isSaving}
            onClick={() =>
              void run(async () => {
                await api("/api/auth/password", { body: { current, next } });
                setCurrent("");
                setNext("");
              }, "senha alterada")
            }
          >
            Alterar senha
          </Button>
        </div>
      </Panel>
      {message && <p role="status" className="font-mono text-[12px] text-muted lg:col-span-3">{message}</p>}
    </div>
  );
}
