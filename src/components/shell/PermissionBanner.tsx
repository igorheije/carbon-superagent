"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";

const BASE_TITLE = "Carbon SuperAgent — Agentes autônomos";

/** Visible on every page: a running agent is blocked waiting for a human decision. */
export function PermissionBanner() {
  const { state, mode } = useEngine();
  const waiting =
    mode === "live"
      ? state.tickets.flatMap((t) => (t.permissions ?? []).filter((p) => p.status === "pending").map((p) => ({ ticket: t, prompt: p })))
      : [];
  const count = waiting.length;

  useEffect(() => {
    document.title = count > 0 ? `(${count}) Permissão pendente · Carbon` : BASE_TITLE;
  }, [count]);

  const first = waiting[0];
  return (
    <AnimatePresence>
      {first && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
          <Link
            href="/"
            className="flex items-center gap-2 rounded-full border border-warn/60 bg-surface px-3 py-1.5 font-mono text-[11px] text-warn transition-colors hover:bg-surface-muted"
          >
            <motion.span animate={{ scale: [1, 1.15, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
              <ShieldAlert className="size-3.5" />
            </motion.span>
            <span className="hidden sm:inline">
              {first.ticket.key} pede {first.prompt.tool}
              {count > 1 ? ` (+${count - 1})` : ""}
            </span>
            <span className="sm:hidden">{count}</span>
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
