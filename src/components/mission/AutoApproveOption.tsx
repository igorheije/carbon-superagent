"use client";

import { ShieldCheck } from "lucide-react";

interface AutoApproveOptionProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** The task may run on a worker: say so, since the worker can be a server running other services. */
  readonly isRemote: boolean;
}

/** "Seguir até o final sem pedir permissão" (per task). Mirrors autoApprovedByTask in permissions/classify.ts. */
export function AutoApproveOption({ checked, onChange, isRemote }: AutoApproveOptionProps) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${checked ? "border-accent bg-accent-weak" : "border-line hover:border-line-strong"}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-[var(--accent)]" />
      <span className="text-[13px]">
        <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> Seguir até o final sem pedir permissão</span>
        <span className="block text-[12px] text-muted">
          O agente não para para perguntar em ações comuns do projeto (instalar dependências, commits, editar arquivos, rodar scripts).
          Continuam pedindo: infraestrutura (docker, kubectl, terraform), acesso à rede (ssh, scp, curl), qualquer coisa fora do projeto e arquivos sensíveis (.env, chaves). O que já é bloqueado (sudo, git push, rm -rf fora do projeto) segue bloqueado.
        </span>
        {isRemote && checked && (
          <span className="mt-1 block text-[12px] text-warn">Vai rodar num worker: confira se é uma máquina que você pode deixar o agente usar sozinho.</span>
        )}
      </span>
    </label>
  );
}
