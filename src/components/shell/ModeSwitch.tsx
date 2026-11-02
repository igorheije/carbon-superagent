"use client";

import { motion } from "motion/react";
import { useEngine, type EngineMode } from "@/components/engine/EngineProvider";

const MODES: readonly { id: EngineMode; label: string }[] = [
  { id: "live", label: "ao vivo" },
  { id: "demo", label: "demo" },
];

export function ModeSwitch() {
  const { mode, setMode, isConnected } = useEngine();
  return (
    <div role="radiogroup" aria-label="Fonte dos dados" className="hidden items-center rounded-full border border-line p-0.5 font-mono text-[11px] sm:flex">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          onClick={() => setMode(m.id)}
          className={`relative flex items-center gap-1.5 rounded-full px-2.5 py-1 ${mode === m.id ? "text-btn-text" : "text-muted hover:text-ink"}`}
        >
          {mode === m.id && <motion.span layoutId="mode-switch" className="absolute inset-0 rounded-full bg-btn" />}
          {m.id === "live" && <span className={`relative size-1.5 rounded-full ${isConnected && mode === "live" ? "bg-accent" : "bg-line-strong"}`} />}
          <span className="relative">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
