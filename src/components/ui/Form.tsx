"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Loader2 } from "lucide-react";
import { PERSONA_IDS, PERSONAS, type PersonaId } from "@/lib/domain/personas";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
}

export function Field({ label, hint, error, id, ...input }: FieldProps) {
  const fieldId = id ?? `f-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="eyebrow">
        {label}
      </label>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className="rounded-xl border border-line bg-surface-sunken px-3.5 py-2.5 text-[14px] outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-line-strong focus:shadow-[var(--ring)] aria-[invalid=true]:border-danger"
        {...input}
      />
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] text-subtle">{hint}</p> : null}
    </div>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly isLoading?: boolean;
  readonly variant?: "primary" | "ghost" | "accent";
}

const VARIANTS = {
  primary: "bg-btn text-btn-text",
  accent: "bg-accent text-accent-ink",
  ghost: "border border-line text-muted hover:border-line-strong hover:text-ink",
} as const;

export function Button({ isLoading, variant = "primary", className = "", children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-medium transition-[transform,opacity,color,border-color] active:scale-[0.975] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {isLoading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function CopyCommand({ command }: { readonly command: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch {
      setIsCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="group flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-left font-mono text-[12px] text-muted transition-colors hover:text-ink"
    >
      <span className="truncate">
        <span className="text-accent">$</span> {command}
      </span>
      {isCopied ? <Check className="size-3.5 shrink-0 text-ok" /> : <Copy className="size-3.5 shrink-0 opacity-60 group-hover:opacity-100" />}
    </button>
  );
}

export function PersonaPicker({ value, onChange }: { readonly value: PersonaId; readonly onChange: (p: PersonaId) => void }) {
  return (
    <div role="radiogroup" aria-label="Persona" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {PERSONA_IDS.map((id) => {
        const persona = PERSONAS[id];
        const isSelected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(id)}
            className={`relative rounded-xl border p-3 text-left transition-colors ${isSelected ? "border-accent bg-accent-weak" : "border-line hover:border-line-strong"}`}
          >
            {isSelected && (
              <motion.span layoutId="persona-dot" className="absolute right-3 top-3 size-2 rounded-full bg-accent" transition={{ type: "spring", stiffness: 500, damping: 30 }} />
            )}
            <p className="text-[14px] font-medium">{persona.label}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{persona.tagline}</p>
          </button>
        );
      })}
    </div>
  );
}
