"use client";

import type { TaskRuntime } from "@/lib/domain/types";

/** Mirrors RuntimeAvailability from /api/auth/me (settings.runtimes). */
export interface RuntimeOption {
  readonly available: boolean;
  readonly reason: string | null;
}
export type RuntimeOptions = Readonly<Record<TaskRuntime, RuntimeOption>>;

const LABELS: Readonly<Record<TaskRuntime, string>> = {
  local: "Esta máquina",
  pool: "Pool de workers",
  agentcore: "AgentCore (experimental)",
};
const ORDER: readonly TaskRuntime[] = ["local", "pool", "agentcore"];

/** Settings without `runtimes` (older panel) → only "Esta máquina". */
export function runtimeOptionsOf(settings: unknown): RuntimeOptions {
  const runtimes = (settings as { runtimes?: RuntimeOptions } | null)?.runtimes;
  const off: RuntimeOption = { available: false, reason: "indisponível" };
  return runtimes ?? { local: { available: true, reason: null }, pool: off, agentcore: off };
}

/** Never send a runtime that is not available; fall back to this machine. */
export function effectiveRuntime(value: TaskRuntime, options: RuntimeOptions): TaskRuntime {
  return options[value].available ? value : "local";
}

interface RuntimePickerProps {
  readonly value: TaskRuntime;
  readonly options: RuntimeOptions;
  readonly onChange: (runtime: TaskRuntime) => void;
}

/** "Onde rodar": unavailable runtimes stay visible, disabled, with the reason. */
export function RuntimePicker({ value, options, onChange }: RuntimePickerProps) {
  const unavailable = ORDER.filter((r) => !options[r].available && options[r].reason);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="eyebrow" id="runtime-label">Onde rodar</p>
      <div role="radiogroup" aria-labelledby="runtime-label" className="flex flex-wrap gap-1 rounded-full border border-line p-0.5 font-mono text-[11px] self-start">
        {ORDER.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={value === r}
            disabled={!options[r].available}
            title={options[r].reason ?? undefined}
            onClick={() => onChange(r)}
            className={`rounded-full px-3 py-1 disabled:cursor-not-allowed disabled:opacity-45 ${value === r ? "bg-btn text-btn-text" : "text-muted"}`}
          >
            {LABELS[r]}
          </button>
        ))}
      </div>
      {unavailable.length > 0 && (
        <ul className="text-[11px] text-muted">
          {unavailable.map((r) => (
            <li key={r}>
              {LABELS[r]}: {options[r].reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
