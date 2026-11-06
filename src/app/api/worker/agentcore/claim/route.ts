import { requireTaskClaim } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { findTask } from "@/server/repo/tasks";
import { prepareClaim } from "@/server/runner/prepare-claim";
import { claimSpecific } from "@/server/runner/scheduler";
import { agentcoreClaimRequestSchema } from "@/shared/worker-protocol";
import { readWorkerJson } from "../../_lib/body";

export const dynamic = "force-dynamic";

/**
 * The AgentCore container claims the one task it was invoked for. Bearer = the one-time task
 * token from the Invoke payload (burned here). 409 when the task can no longer be claimed
 * (canceled, already taken, project removed).
 */
export function POST(request: Request) {
  return handle(async () => {
    const body = await readWorkerJson(request, agentcoreClaimRequestSchema);
    const worker = requireTaskClaim(request, body.taskId);
    if (findTask(body.taskId)?.runtime !== "agentcore") throw new HttpError(409, "tarefa indisponível para esta sessão");
    const leaseMs = getSettings().workers.leaseMs;
    const lease = claimSpecific(body.taskId, worker.id, leaseMs);
    if (!lease) throw new HttpError(409, "tarefa indisponível para esta sessão");
    const claimed = await prepareClaim(lease, worker, leaseMs);
    if (!claimed) throw new HttpError(409, "tarefa indisponível para esta sessão");
    return ok(claimed);
  });
}
