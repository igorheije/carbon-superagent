"use client";

import { useEngine } from "@/components/engine/EngineProvider";
import { NewTaskDialog } from "./NewTaskDialog";

export function MissionHeader() {
  const { mode } = useEngine();
  return (
    <section className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        <p className="eyebrow">{mode === "demo" ? "Demo · simulação determinística" : "Ao vivo · Claude Code / Codex no seu computador"}</p>
        <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Mission control</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
          Cada tarefa vira um ticket, passa por oito agentes num worktree isolado e sai como commit ou PR revisável. Você só é chamado quando precisa decidir.
        </p>
      </div>
      {mode === "live" && <NewTaskDialog />}
    </section>
  );
}
