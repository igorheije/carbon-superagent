import type { Ticket } from "./types";

/**
 * Agent effectiveness, computed only from what Carbon records on each ticket.
 * A rate is null when there is no data for it yet: the panel shows "sem dados", never a guess.
 */
export interface Rate {
  readonly value: number | null;
  readonly part: number;
  readonly whole: number;
}

export interface EfficiencyMetrics {
  readonly finished: number;
  readonly success: Rate;
  readonly delivery: Rate;
  readonly autonomy: Rate;
  readonly plan: Rate;
  readonly tests: Rate;
  readonly review: Rate;
  readonly avgRunSeconds: number | null;
  readonly avgCostUsd: number | null;
  readonly avgTokens: number | null;
  readonly interventionsPerTask: number | null;
  /** Plain average of the rates that have data, 0..1. */
  readonly usefulness: number | null;
  readonly usefulnessParts: number;
}

const rate = (part: number, whole: number): Rate => ({ value: whole > 0 ? part / whole : null, part, whole });
const avg = (values: readonly number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Human decisions a task needed: answered questions plus permission prompts a person decided. */
export function interventionsOf(ticket: Ticket): number {
  const answered = (ticket.questions ?? []).filter((q) => q.answer !== null).length;
  const humanPermissions = (ticket.permissions ?? []).filter((p) => !p.auto && (p.status === "allowed" || p.status === "denied")).length;
  return answered + humanPermissions;
}

const isDelivered = (t: Ticket): boolean => Boolean(t.pr || t.workspace?.commit || t.diff.length > 0);
const BLOCKING = new Set(["CRITICAL", "HIGH"]);

export function computeEfficiency(tickets: readonly Ticket[]): EfficiencyMetrics {
  const done = tickets.filter((t) => t.status === "done");
  const failed = tickets.filter((t) => t.status === "failed");
  const finished = [...done, ...failed];

  const steps = done.flatMap((t) => t.plan);
  const tested = tickets.filter((t) => t.tests && t.tests.total > 0);
  const blocking = tickets.flatMap((t) => t.findings.filter((f) => BLOCKING.has(f.severity)));
  const timed = finished.map((t) => t.runSeconds ?? 0).filter((s) => s > 0);
  const costed = finished.map((t) => t.costUsd ?? 0).filter((c) => c > 0);
  const tokened = finished.map((t) => t.tokens).filter((n) => n > 0);

  const success = rate(done.length, finished.length);
  const delivery = rate(done.filter(isDelivered).length, done.length);
  const autonomy = rate(finished.filter((t) => interventionsOf(t) === 0).length, finished.length);
  const plan = rate(steps.filter((s) => s.done).length, steps.length);
  const tests = rate(sum(tested.map((t) => t.tests?.passing ?? 0)), sum(tested.map((t) => t.tests?.total ?? 0)));
  const review = rate(blocking.filter((f) => f.resolved).length, blocking.length);

  const parts = [success, delivery, autonomy, plan, tests, review].map((r) => r.value).filter((v): v is number => v !== null);
  return {
    finished: finished.length,
    success,
    delivery,
    autonomy,
    plan,
    tests,
    review,
    avgRunSeconds: avg(timed),
    avgCostUsd: avg(costed),
    avgTokens: avg(tokened),
    interventionsPerTask: finished.length ? sum(finished.map(interventionsOf)) / finished.length : null,
    usefulness: avg(parts),
    usefulnessParts: parts.length,
  };
}

/** "4 min 20 s", "38 s", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
