"use client";

import { AsciiReveal } from "ascii-reveal";
import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, Minus, TriangleAlert, X } from "lucide-react";
import { CopyCommand } from "@/components/ui/Form";
import type { SystemCheck } from "@/lib/client/api";

const ICON = {
  ok: <Check className="size-3.5 text-ok" strokeWidth={2.5} />,
  warn: <TriangleAlert className="size-3.5 text-warn" />,
  missing: <X className="size-3.5 text-danger" strokeWidth={2.5} />,
  optional: <Minus className="size-3.5 text-subtle" strokeWidth={2.5} />,
} as const;

/** Each check "resolves" in sequence so the scan reads like a boot log. */
export const HELMET_MASCOT = "/carbon-mark.svg";

export function CheckList({ checks, isLoading, labels }: { readonly checks: readonly SystemCheck[]; readonly isLoading: boolean; readonly labels: readonly string[] }) {
  const rows = checks.length ? checks : labels.map((label) => ({ id: label, label, status: "ok" as const, detail: "", fix: null }));
  return (
    <AsciiReveal loading={isLoading} mascot={HELMET_MASCOT} revealOnMount={false} selector="[data-check]">
    <ul className="flex flex-col gap-1.5">
      {rows.map((check, i) => (
        <motion.li
          key={check.id}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.09, duration: 0.25, ease: [0.2, 0, 0.2, 1] }}
          className="rounded-xl border border-line bg-surface px-3.5 py-2.5"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line">
              <AnimatePresence mode="wait">
                {isLoading || !checks.length ? (
                  <motion.span key="spin" exit={{ opacity: 0, scale: 0.5 }}>
                    <Loader2 className="size-3.5 animate-spin text-muted" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="icon"
                    initial={{ scale: 0, rotate: -30 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: i * 0.12, type: "spring", stiffness: 500, damping: 22 }}
                  >
                    {ICON[check.status]}
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
            <span className="text-[14px]">{check.label}</span>
            <span data-check className="ml-auto truncate font-mono text-[11px] text-muted">{isLoading ? "verificando…" : check.detail}</span>
          </div>
          {!isLoading && check.fix && (check.status === "missing" || check.status === "warn") && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ delay: 0.3 + i * 0.1 }} className="mt-2 pl-9">
              <CopyCommand command={check.fix} />
            </motion.div>
          )}
        </motion.li>
      ))}
    </ul>
    </AsciiReveal>
  );
}
