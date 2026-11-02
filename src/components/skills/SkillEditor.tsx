"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Upload, X } from "lucide-react";
import { Button, Field } from "@/components/ui/Form";
import { api } from "@/lib/client/api";
import { PERSONA_IDS, PERSONAS, type PersonaId } from "@/lib/domain/personas";

export function PersonaChips({ value, onChange }: { readonly value: readonly PersonaId[]; readonly onChange: (v: readonly PersonaId[]) => void }) {
  const toggle = (id: PersonaId) => onChange(value.includes(id) ? value.filter((p) => p !== id) : [...value, id]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {PERSONA_IDS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={value.includes(id)}
          onClick={() => toggle(id)}
          className={`rounded-full border px-3 py-1 font-mono text-[11px] transition-colors ${value.includes(id) ? "border-accent bg-accent-weak text-ink" : "border-line text-muted hover:text-ink"}`}
        >
          {PERSONAS[id].label}
        </button>
      ))}
      <span className="self-center pl-1 text-[11px] text-subtle">{value.length === 0 ? "nenhuma = todas as personas" : ""}</span>
    </div>
  );
}

const TEMPLATE = `# Nome da skill

Quando usar: descreva o gatilho.

## Passos
1. ...
2. ...

## Não fazer
- ...
`;

type Tab = "create" | "import";

export function SkillDialog({ isOpen, onClose, onSaved }: { readonly isOpen: boolean; readonly onClose: () => void; readonly onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>("create");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(TEMPLATE);
  const [personas, setPersonas] = useState<readonly PersonaId[]>([]);
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      if (tab === "create") await api("/api/skills", { body: { name, description, body, personas } });
      else await api("/api/skills/import", { body: content.trim() ? { content, personas } : { url, personas } });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao salvar");
    } finally {
      setIsSaving(false);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 200_000) return setError("arquivo maior que 200 KB");
    setContent(await file.text());
    setUrl("");
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.aside
            role="dialog"
            aria-label="Nova skill"
            className="flex h-full w-full max-w-2xl flex-col gap-5 overflow-y-auto border-l border-line bg-bg p-6"
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 60, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between">
              <div role="tablist" className="flex gap-1 font-mono text-[12px]">
                {(["create", "import"] as const).map((t) => (
                  <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`relative rounded-full px-3 py-1.5 ${tab === t ? "text-ink" : "text-muted"}`}>
                    {tab === t && <motion.span layoutId="skill-tab" className="absolute inset-0 rounded-full border border-line bg-surface-muted" />}
                    <span className="relative">[ {t === "create" ? "Criar" : "Importar"} ]</span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1.5 text-muted hover:text-ink">
                <X className="size-4" />
              </button>
            </header>

            {tab === "create" ? (
              <div className="flex flex-col gap-4">
                <Field label="Nome (kebab-case)" placeholder="api-review" value={name} onChange={(e) => setName(e.target.value)} />
                <Field label="Descrição — quando o agente deve usar" placeholder="Use ao revisar contratos de API REST antes do PR." value={description} onChange={(e) => setDescription(e.target.value)} />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="skill-body" className="eyebrow">Instruções (markdown)</label>
                  <textarea id="skill-body" value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="scroll-thin rounded-xl border border-line bg-surface-sunken p-3.5 font-mono text-[12.5px] leading-relaxed outline-none focus:border-line-strong focus:shadow-[var(--ring)]" />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-[13px] text-muted">
                  Formato SKILL.md (frontmatter com <code className="font-mono">name</code> e <code className="font-mono">description</code>) — o mesmo do Claude Code e do Codex. Skills importadas entram <span className="text-ink">desligadas</span> até alguém revisar.
                </p>
                <Field label="URL do GitHub" placeholder="https://github.com/org/repo/blob/main/skills/x/SKILL.md" value={url} onChange={(e) => { setUrl(e.target.value); setContent(""); }} />
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line p-5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-ink">
                  <Upload className="size-4" /> Enviar arquivo SKILL.md
                  <input type="file" accept=".md,text/markdown,text/plain" className="sr-only" onChange={(e) => void readFile(e.target.files?.[0])} />
                </label>
                <textarea value={content} onChange={(e) => { setContent(e.target.value); setUrl(""); }} rows={10} placeholder={"ou cole aqui:\n---\nname: minha-skill\ndescription: ...\n---\n..."} className="scroll-thin rounded-xl border border-line bg-surface-sunken p-3.5 font-mono text-[12.5px] outline-none focus:border-line-strong" />
              </div>
            )}

            <div>
              <p className="eyebrow mb-2">Para quais personas</p>
              <PersonaChips value={personas} onChange={setPersonas} />
            </div>
            {error && <p role="alert" className="font-mono text-[12px] text-danger">{error}</p>}
            <div className="mt-auto flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancelar</Button>
              <Button onClick={() => void save()} isLoading={isSaving}>{tab === "create" ? "Criar skill" : "Importar"}</Button>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
