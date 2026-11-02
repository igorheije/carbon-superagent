"use client";

import { useCallback, useEffect, useState } from "react";
import { AsciiReveal, AsciiSkeleton } from "ascii-reveal";
import { AnimatePresence, motion } from "motion/react";
import { Download, Plus, Trash2 } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { SkillDialog } from "@/components/skills/SkillEditor";
import { HELMET_MASCOT } from "@/components/setup/CheckList";
import { Button } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { PERSONA_IDS, PERSONAS, type PersonaId } from "@/lib/domain/personas";

interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly personas: readonly PersonaId[];
  readonly source: "builtin" | "created" | "imported";
  readonly sourceUrl: string | null;
  readonly enabled: boolean;
  readonly authorId: string | null;
}

const SOURCE_LABEL = { builtin: "nativa", created: "criada", imported: "importada" } as const;

function download(skill: Skill) {
  const md = `---\nname: ${skill.name}\ndescription: "${skill.description.replace(/"/g, '\\"')}"\n---\n\n${skill.body}\n`;
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${skill.name}-SKILL.md` });
  a.click();
  URL.revokeObjectURL(url);
}

function SkillCard({ skill, canEdit, onChange }: { skill: Skill; canEdit: boolean; onChange: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = (p: Promise<unknown>) => p.then(onChange).catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  return (
    <motion.li layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} data-ascii="surface" className={`card flex flex-col p-4 ${skill.enabled ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-[13px]">{skill.name}</p>
            <span className={`rounded-full border px-2 py-px font-mono text-[9px] uppercase tracking-[0.08em] ${skill.source === "imported" ? "border-warn/50 text-warn" : "border-line text-subtle"}`}>{SOURCE_LABEL[skill.source]}</span>
          </div>
          <p className="mt-1.5 text-[13px] leading-snug text-muted">{skill.description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={skill.enabled}
          aria-label={`${skill.enabled ? "Desligar" : "Ligar"} ${skill.name}`}
          disabled={!canEdit}
          onClick={() => call(api(`/api/skills/${skill.id}`, { method: "PATCH", body: { enabled: !skill.enabled } }))}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${skill.enabled ? "bg-accent" : "bg-line-strong"}`}
        >
          <motion.span className="absolute top-0.5 size-4 rounded-full bg-white" animate={{ left: skill.enabled ? 18 : 2 }} transition={{ type: "spring", stiffness: 600, damping: 32 }} />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {(skill.personas.length ? skill.personas : ["todas"]).map((p) => (
          <span key={p} className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] text-muted">{p === "todas" ? "todas as personas" : PERSONAS[p as PersonaId].label}</span>
        ))}
      </div>
      <AnimatePresence>
        {isOpen && (
          <motion.pre initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="scroll-thin mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-[11.5px] leading-relaxed text-muted">
            {skill.body}
          </motion.pre>
        )}
      </AnimatePresence>
      {skill.sourceUrl && <p className="mt-2 truncate font-mono text-[10px] text-subtle">fonte: {skill.sourceUrl}</p>}
      {error && <p className="mt-2 font-mono text-[11px] text-danger">{error}</p>}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[12px]">
        <button type="button" onClick={() => setIsOpen((o) => !o)} className="text-muted hover:text-ink">{isOpen ? "ocultar" : "ver instruções"}</button>
        <button type="button" onClick={() => download(skill)} className="ml-auto flex items-center gap-1 text-muted hover:text-ink"><Download className="size-3.5" /> SKILL.md</button>
        {canEdit && skill.source !== "builtin" && (
          <button type="button" onClick={() => call(api(`/api/skills/${skill.id}`, { method: "DELETE" }))} className="flex items-center gap-1 text-muted hover:text-danger" aria-label={`Remover ${skill.name}`}><Trash2 className="size-3.5" /></button>
        )}
      </div>
    </motion.li>
  );
}

export default function SkillsPage() {
  const { user } = useSession();
  const [skills, setSkills] = useState<readonly Skill[] | null>(null);
  const [filter, setFilter] = useState<PersonaId | "all">("all");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ skills: Skill[] }>("/api/skills").then((d) => setSkills(d.skills)).catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  }, []);
  useEffect(load, [load]);

  const visible = (skills ?? []).filter((s) => filter === "all" || s.personas.length === 0 || s.personas.includes(filter));
  const canEdit = (s: Skill) => user?.role === "admin" || (s.source !== "builtin" && s.authorId === user?.id);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="eyebrow">SKILL.md · Claude Code + Codex</p>
          <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Skills</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">Instruções reutilizáveis que o agente carrega conforme a persona de quem pediu a tarefa. Instaladas em cada worktree, nunca commitadas.</p>
        </div>
        <Button onClick={() => setIsDialogOpen(true)}><Plus className="size-4" /> Nova skill</Button>
      </section>
      <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
        {(["all", ...PERSONA_IDS] as const).map((p) => (
          <button key={p} type="button" aria-pressed={filter === p} onClick={() => setFilter(p)} className={`rounded-full border px-3 py-1 ${filter === p ? "border-ink text-ink" : "border-line text-muted hover:text-ink"}`}>
            {p === "all" ? "todas" : PERSONAS[p].label}
          </button>
        ))}
      </div>
      {error && <p className="font-mono text-[12px] text-danger">{error}</p>}
      {skills === null && <AsciiSkeleton variant="braille" lines={5} />}
      <AsciiReveal loading={skills === null} mascot={HELMET_MASCOT} revealOnMount={false}>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence>
          {visible.map((skill) => <SkillCard key={skill.id} skill={skill} canEdit={canEdit(skill)} onChange={load} />)}
        </AnimatePresence>
      </ul>
      </AsciiReveal>
      <SkillDialog isOpen={isDialogOpen} onClose={() => setIsDialogOpen(false)} onSaved={load} />
    </div>
  );
}
