"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { MAX_SPEED_MS, MIN_SPEED_MS } from "@/lib/sim/engine";

const iconButton =
  "inline-flex size-8 items-center justify-center rounded-full border border-line text-muted transition-[color,border-color,transform] duration-150 hover:border-line-strong hover:text-ink active:scale-[0.975]";

export function EngineControls() {
  const { state, dispatch, activeTicket, mode, isConnected, lastError } = useEngine();
  const isDemo = mode === "demo";
  const sliderValue = MAX_SPEED_MS + MIN_SPEED_MS - state.speedMs;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        className={iconButton}
        onClick={() => dispatch({ type: "toggle" })}
        aria-label={state.running ? "Pausar fila" : "Retomar fila"}
        title={state.running ? "Pausar fila (a execução atual termina)" : "Retomar fila"}
      >
        {state.running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </button>
      {isDemo && (
        <>
          <button type="button" className={iconButton} onClick={() => dispatch({ type: "reset" })} aria-label="Reiniciar simulação">
            <RotateCcw className="size-3.5" />
          </button>
          <label className="ml-1 hidden items-center gap-2 sm:flex">
            <span className="sr-only">Velocidade</span>
            <input
              type="range"
              min={MIN_SPEED_MS}
              max={MAX_SPEED_MS}
              value={sliderValue}
              onChange={(e) => dispatch({ type: "setSpeed", speedMs: MAX_SPEED_MS + MIN_SPEED_MS - Number(e.target.value) })}
              className="w-24 accent-[var(--accent)]"
            />
          </label>
        </>
      )}
      {!isDemo && !isConnected && <span className="font-mono text-[11px] text-warn">reconectando…</span>}
      {lastError && <span className="hidden truncate font-mono text-[11px] text-warn md:inline">{lastError}</span>}
      <span className="ml-2 hidden truncate font-mono text-[12px] text-muted lg:inline">
        {activeTicket ? (
          <>
            <span className="text-ink">{activeTicket.key}</span> · {activeTicket.stage ?? "intake"}
          </>
        ) : state.running ? (
          "fila ociosa"
        ) : (
          "fila pausada"
        )}
      </span>
    </div>
  );
}
