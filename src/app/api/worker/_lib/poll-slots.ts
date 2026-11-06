import "server-only";
import { HttpError } from "@/server/http";
import type { Worker } from "@/server/repo/workers";

/**
 * Caps concurrent long-polls per worker (M5). A worker runs `maxParallel` slots, each with at
 * most one claim poll and one permissions poll at a time; one extra covers a retry racing the
 * previous request. Anything above is a misbehaving or stolen token holding panel connections
 * open → 429. In memory, per panel process (Next runs the worker routes in one process).
 */

export type PollKind = "claim" | "permissions";

const MAX_DECLARED_PARALLEL = 64;
const inflight = new Map<string, number>();

/** max(parallel, 1) + 1, with parallel from the worker's hello (1 for AgentCore containers). */
export function pollLimitFor(worker: Pick<Worker, "capabilities">): number {
  const declared = worker.capabilities.maxParallel;
  const parallel = typeof declared === "number" && Number.isInteger(declared) ? Math.min(Math.max(declared, 1), MAX_DECLARED_PARALLEL) : 1;
  return parallel + 1;
}

/** Runs `fn` holding one poll slot of `kind` for this worker; 429 when none is free. */
export async function withPollSlot<T>(worker: Pick<Worker, "id" | "capabilities">, kind: PollKind, fn: () => Promise<T>): Promise<T> {
  const key = `${kind}:${worker.id}`;
  const current = inflight.get(key) ?? 0;
  if (current >= pollLimitFor(worker)) throw new HttpError(429, "muitas consultas simultâneas deste worker; aguarde as anteriores");
  inflight.set(key, current + 1);
  try {
    return await fn();
  } finally {
    const left = (inflight.get(key) ?? 1) - 1;
    if (left <= 0) inflight.delete(key);
    else inflight.set(key, left);
  }
}

/** Test hook. */
export const inflightPolls = (worker: Pick<Worker, "id">, kind: PollKind): number => inflight.get(`${kind}:${worker.id}`) ?? 0;
