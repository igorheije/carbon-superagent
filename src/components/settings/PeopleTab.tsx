"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Trash2, UserPlus } from "lucide-react";
import { Button, CopyCommand, Field, PersonaPicker } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api, type SessionUser } from "@/lib/client/api";
import { PERSONAS, type PersonaId } from "@/lib/domain/personas";

export function PeopleTab() {
  const [users, setUsers] = useState<readonly SessionUser[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [persona, setPersona] = useState<PersonaId>("product");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [invite, setInvite] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(() => {
    api<{ users: SessionUser[] }>("/api/users").then((d) => setUsers(d.users)).catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await api<{ user: SessionUser; temporaryPassword: string }>("/api/users", { body: { name, email, persona, role } });
      setInvite({ email: data.user.email, password: data.temporaryPassword });
      setName("");
      setEmail("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha");
    } finally {
      setIsSaving(false);
    }
  };

  const remove = (id: string) => api(`/api/users/${id}`, { method: "DELETE" }).then(load).catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
      <Panel eyebrow="Convidar" title="Nova pessoa" className="lg:col-span-3">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
            <Field label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <PersonaPicker value={persona} onChange={setPersona} />
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={role === "admin"} onChange={(e) => setRole(e.target.checked ? "admin" : "member")} className="accent-[var(--accent)]" />
            Admin (gerencia pessoas, configurações e skills de todos)
          </label>
          {error && <p className="font-mono text-[12px] text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={() => void create()} isLoading={isSaving}><UserPlus className="size-4" /> Criar acesso</Button>
          </div>
          <AnimatePresence>
            {invite && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl border border-accent/50 bg-accent-weak p-4">
                <p className="text-[13px]">Acesso criado para <span className="font-mono">{invite.email}</span>. Senha temporária (mostrada só agora):</p>
                <div className="mt-2"><CopyCommand command={invite.password} /></div>
                <p className="mt-2 text-[12px] text-muted">Envie por um canal privado. A pessoa troca a senha no primeiro acesso em Configurações → Perfil.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Panel>
      <Panel eyebrow="Pessoas" title={`${users.length} com acesso`} className="lg:col-span-2">
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <motion.li layout key={u.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px]">{u.name}</p>
                <p className="truncate font-mono text-[10px] text-subtle">{u.email} · {PERSONAS[u.persona].label} · {u.role}{u.mustChangePassword ? " · senha temporária" : ""}</p>
              </div>
              <button type="button" onClick={() => void remove(u.id)} aria-label={`Remover ${u.name}`} className="rounded-full p-1.5 text-muted hover:text-danger"><Trash2 className="size-3.5" /></button>
            </motion.li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
