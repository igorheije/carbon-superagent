import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { finishRun, outcomeOfStatus } from "@/server/repo/task-runs";
import { importRemoteResult, leaseOwnedBy } from "@/server/runner/remote-delivery";
import { LEASE_LOST, resultRequestSchema } from "@/shared/worker-protocol";
import { readWorkerJson } from "../../../_lib/body";

export const dynamic = "force-dynamic";

/**
 * Final result of a remote task. bundle transport uses the bundle uploaded with PUT .../bundle;
 * push transport fetches the branch from the project's origin. 422 when the result could not be
 * imported (the task is failed with the reason); 409 lease_lost when the worker no longer owns it.
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    if (!leaseOwnedBy(id, worker.id)) throw new HttpError(409, LEASE_LOST);
    const body = await readWorkerJson(request, resultRequestSchema);
    const outcome = await importRemoteResult(id, worker.id, body);
    if (outcome === "lease_lost") throw new HttpError(409, LEASE_LOST);
    finishRun(id, outcomeOfStatus(outcome.status));
    if (body.status === "done" && outcome.status !== "done") throw new HttpError(422, outcome.error ?? "falha ao importar o resultado");
    return ok({ status: outcome.status });
  });
}
