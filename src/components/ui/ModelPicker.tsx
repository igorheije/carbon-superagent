"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  AUTO_EFFORT,
  AUTO_MODEL,
  CLAUDE_MODELS,
  CODEX_MODELS,
  effortOptions,
  isValidModelName,
  resolveModel,
  type EffortOption,
  type ModelOption,
} from "@/lib/domain/models";

interface ModelPickerProps {
  readonly executor: "claude" | "codex";
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Reasoning effort ("auto" or a level). Omit both effort props to hide the effort row. */
  readonly effort?: string;
  readonly onEffortChange?: (value: string) => void;
  /** When given, previews what "auto" would pick for this task. */
  readonly task?: { readonly title: string; readonly description: string };
}

const CUSTOM = "__custom";

function Chips({ group, options, selected, onPick }: { group: string; options: readonly (ModelOption | EffortOption)[]; selected: string; onPick: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={group} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const isActive = selected === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            title={o.hint}
            onClick={() => onPick(o.value)}
            className={`relative rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors ${isActive ? "border-accent text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink"}`}
          >
            {isActive && <motion.span layoutId={`chip-${group}`} className="absolute inset-0 rounded-full bg-accent-weak" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ModelPicker({ executor, value, onChange, effort, onEffortChange, task }: ModelPickerProps) {
  const models = executor === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  const modelOptions = executor === "codex" ? [...models, { value: CUSTOM, label: "Outro…", hint: "nome exato do modelo" }] : models;
  const selected = models.some((o) => o.value === value) ? value : CUSTOM;
  const efforts = effortOptions(executor);
  const showEffort = effort !== undefined && onEffortChange !== undefined;
  const currentEffort = efforts.some((o) => o.value === effort) ? (effort as string) : AUTO_EFFORT;
  const isAnyAuto = value === AUTO_MODEL || (showEffort && currentEffort === AUTO_EFFORT);
  const preview = task && isAnyAuto && (task.title || task.description) ? resolveModel(executor, value, task.title, task.description, showEffort ? currentEffort : AUTO_EFFORT) : null;
  const isCustomInvalid = selected === CUSTOM && value !== "" && !isValidModelName(value);

  return (
    <div className="flex flex-col gap-2">
      <Chips group={`modelo-${executor}`} options={modelOptions} selected={selected} onPick={(v) => onChange(v === CUSTOM ? "" : v)} />
      {selected === CUSTOM && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="ex.: nome do modelo no seu Codex"
          aria-invalid={isCustomInvalid || undefined}
          className="rounded-xl border border-line bg-surface-sunken px-3 py-2 font-mono text-[12px] outline-none focus:border-line-strong aria-[invalid=true]:border-danger"
        />
      )}
      {showEffort && (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="eyebrow">Esforço de raciocínio</p>
          <Chips group={`esforco-${executor}`} options={efforts} selected={currentEffort} onPick={onEffortChange} />
        </div>
      )}
      <AnimatePresence mode="wait">
        {preview ? (
          <motion.p key={preview.label} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="font-mono text-[11px] text-muted">
            <span className="text-accent">→ {preview.label}</span> · {preview.reason}
          </motion.p>
        ) : (
          <p className="text-[11px] text-subtle">
            {[models.find((o) => o.value === selected)?.hint, showEffort ? efforts.find((o) => o.value === currentEffort)?.hint : null].filter(Boolean).join(" · ") || "passado direto para a CLI"}
          </p>
        )}
      </AnimatePresence>
    </div>
  );
}
