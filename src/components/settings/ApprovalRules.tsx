"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";

interface Rule {
  readonly id: string;
  readonly tool: string;
  readonly pattern: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Rules created by "Sempre neste repositório" — removing one makes Carbon ask again. */
export function ApprovalRules() {
  const [rules, setRules] = useState<readonly Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ rules: Rule[] }>("/api/permissions/rules")
      .then((d) => setRules(d.rules))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));
  }, []);
  useEffect(load, [load]);

  const remove = (id: string) =>
    api(`/api/permissions/rules/${id}`, { method: "DELETE" })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha"));

  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">Sempre permitido neste repositório</p>
      {error && <p className="font-mono text-[12px] text-danger">{error}</p>}
      {rules?.length === 0 && <p className="text-[12px] text-subtle">Nenhuma regra ainda. Elas aparecem quando você escolhe “Sempre neste repositório” num pedido de permissão.</p>}
      <ul className="flex flex-col gap-1.5">
        {rules?.map((r) => (
          <li key={r.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
            <span className="font-mono text-[12px] text-ink">{r.tool}</span>
            <span className="truncate font-mono text-[12px] text-muted">{r.pattern || "(qualquer uso)"}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-subtle">{r.createdBy} · {new Date(r.createdAt).toLocaleDateString("pt-BR")}</span>
            <button type="button" onClick={() => void remove(r.id)} aria-label={`Remover regra ${r.tool} ${r.pattern}`} className="rounded-full p-1 text-muted hover:text-danger">
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
