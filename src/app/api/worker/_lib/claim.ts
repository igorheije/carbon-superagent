import "server-only";
import type { ExecutorId } from "@/server/repo/settings";
import type { Worker } from "@/server/repo/workers";
import { prepareClaim } from "@/server/runner/prepare-claim";
import { claimNext } from "@/server/runner/scheduler";
import type { ClaimedTask } from "@/shared/worker-protocol";

export const CLAIM_WAIT_MS = 25_000;
export const CLAIM_CHECK_MS = 1_000;

export interface PollOptions {
  readonly waitMs: number;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly signal?: AbortSignal;
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Long-poll: tries to claim a pool task every `intervalMs` until one is won or `waitMs` passes
 * (or the worker hangs up). A task that cannot be prepared is failed and the poll goes on.
 */
export async function pollClaim(worker: Pick<Worker, "id" | "name">, executors: readonly ExecutorId[], options: PollOptions): Promise<ClaimedTask | null> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    if (options.signal?.aborted) return null;
    const lease = claimNext(worker.id, executors, options.leaseMs);
    if (lease) {
      const claimed = await prepareClaim(lease, worker, options.leaseMs);
      if (claimed) return claimed;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await pause(Math.min(options.intervalMs, left), options.signal);
  }
}

/** Test hook: CARBON_WORKER_CLAIM_WAIT_MS shortens the long-poll. */
export function claimWaitMs(): number {
  const override = Number(process.env.CARBON_WORKER_CLAIM_WAIT_MS);
  return Number.isFinite(override) && override >= 0 ? Math.min(override, CLAIM_WAIT_MS) : CLAIM_WAIT_MS;
}
