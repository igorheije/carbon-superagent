"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ExecutionTab } from "@/components/settings/ExecutionTab";
import { IntegrationsTab } from "@/components/settings/IntegrationsTab";
import { MachinesTab } from "@/components/settings/MachinesTab";
import { PeopleTab } from "@/components/settings/PeopleTab";
import { ProjectsTab } from "@/components/settings/ProjectsTab";
import { ProfileTab } from "@/components/settings/ProfileTab";
import { useSession } from "@/components/session/SessionProvider";

type Tab = "profile" | "projects" | "execution" | "machines" | "integrations" | "people";

export default function SettingsPage() {
  const { user, isLoading } = useSession();
  const [tab, setTab] = useState<Tab>("profile");
  const isAdmin = user?.role === "admin";
  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "profile", label: "Perfil" },
    ...(isAdmin
      ? [
          { id: "projects" as const, label: "Projetos" },
          { id: "execution" as const, label: "Execução" },
          { id: "machines" as const, label: "Máquinas" },
          { id: "integrations" as const, label: "Integrações" },
          { id: "people" as const, label: "Pessoas" },
        ]
      : []),
  ];

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
      <section className="flex flex-col gap-2">
        <p className="eyebrow">Perfil · agente · acesso</p>
        <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Configurações</h1>
      </section>
      <div role="tablist" className="flex gap-1 font-mono text-[12px]">
        {tabs.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`relative rounded-full px-3.5 py-1.5 ${tab === t.id ? "text-ink" : "text-muted hover:text-ink"}`}>
            {tab === t.id && <motion.span layoutId="settings-tab" className="absolute inset-0 rounded-full border border-line bg-surface-muted" />}
            <span className="relative">[ {t.label} ]</span>
          </button>
        ))}
      </div>
      {isLoading ? null : tab === "profile" ? <ProfileTab key={user?.id} /> : tab === "projects" && isAdmin ? <ProjectsTab /> : tab === "execution" && isAdmin ? <ExecutionTab /> : tab === "machines" && isAdmin ? <MachinesTab /> : tab === "integrations" && isAdmin ? <IntegrationsTab /> : isAdmin ? <PeopleTab /> : null}
    </div>
  );
}
