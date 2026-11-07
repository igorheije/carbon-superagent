import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { deleteTask, editTask, findTask, moveToFront } from "@/server/repo/tasks";
import { newTaskSchema } from "@/server/schemas";
import { cancelActive, kick, notifyChange, retryTask, runnerStatus } from "@/server/runner/runner";
import { requestCancel } from "@/server/runner/scheduler";
import { failUnclaimed } from "@/server/runtimes/agentcore-store";
import { stopAgentCoreSession } from "@/server/runtimes/agentcore";

const CANCELED_BY_USER = "cancelado por você";

/**
 * Cancels a remote task. Under lease, the worker sees the flag on its next heartbeat (leaseMs/3)
 * and stops the agent. An AgentCore task dispatched but not yet claimed by its container has no
 * lease: it fails right away and its session is stopped (the burned/revoked token blocks a late claim).
 */
async function cancelRemote(id: string, runtime: string): Promise<boolean> {
  if (requestCancel(id)) return true;
  if (runtime !== "agentcore") return false;
  if (failUnclaimed(id, CANCELED_BY_USER)) {
    await stopAgentCoreSession(id);
    return true;
  }
  // The container may have claimed it in between: then the lease path applies.
  return requestCancel(id);
}

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({ action: z.enum(["prioritize", "retry", "cancel"]) });

export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const task = findTask(id);
    if (!task) throw new HttpError(404, "tarefa não encontrada");
    const { action } = await parseBody(request, actionSchema);
    if (action === "prioritize") {
      moveToFront(id);
      notifyChange();
      kick();
    } else if (action === "retry") {
      if (!retryTask(id)) throw new HttpError(409, "só tarefas concluídas, com falha ou aguardando podem ser reexecutadas");
    } else if (task.runtime !== "local") {
      if (!(await cancelRemote(id, task.runtime))) throw new HttpError(409, "esta tarefa não está executando");
      notifyChange();
    } else if (runnerStatus().activeTaskId !== id || !cancelActive()) {
      throw new HttpError(409, "esta tarefa não está executando");
    }
    return ok({ action });
  });
}

/** What the edit form needs (the description is not part of the live snapshot). */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const task = findTask(id);
    if (!task) throw new HttpError(404, "tarefa não encontrada");
    return ok({
      task: { id: task.id, key: task.key, title: task.title, description: task.description, runtime: task.runtime, status: task.status, distributed: task.snapshot.distributed === true },
    });
  });
}

/** Same rules as creating a task; `rerun` queues it again right after saving. */
const editSchema = newTaskSchema.pick({ title: true, description: true, runtime: true }).extend({ rerun: z.boolean().default(false) });

const EDIT_BUSY = "a tarefa está executando ou aguardando você: pare ou responda antes de editar";

export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const { rerun, ...edit } = await parseBody(request, editSchema);
    const outcome = editTask(id, edit);
    if (outcome === "not_found") throw new HttpError(404, "tarefa não encontrada");
    if (outcome === "busy") throw new HttpError(409, EDIT_BUSY);
    // A queued task already runs with the new text; a finished/failed one goes back to the queue.
    const requeued = rerun && findTask(id)?.status !== "queued" ? retryTask(id) : false;
    if (!requeued) notifyChange();
    return ok({ edited: true, requeued });
  });
}

export function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    if (runnerStatus().activeTaskId === id) throw new HttpError(409, "cancele a execução antes de remover");
    deleteTask(id);
    notifyChange();
    return ok({ deleted: true });
  });
}
