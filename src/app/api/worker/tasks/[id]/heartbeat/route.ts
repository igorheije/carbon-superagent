import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { renew } from "@/server/runner/scheduler";
import { LEASE_LOST, type HeartbeatResponse } from "@/shared/worker-protocol";

export const dynamic = "force-dynamic";

/** Renews the worker's lease; 409 lease_lost when it no longer owns the task. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    const result = renew(id, worker.id, getSettings().workers.leaseMs);
    if (result === "lease_lost") throw new HttpError(409, LEASE_LOST);
    return ok({ cancel: result.cancel } satisfies HeartbeatResponse);
  });
}
