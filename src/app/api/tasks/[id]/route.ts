import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { deleteTask, findTask, moveToFront } from "@/server/repo/tasks";
import { cancelActive, kick, notifyChange, retryTask, runnerStatus } from "@/server/runner/runner";

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
    } else if (runnerStatus().activeTaskId !== id || !cancelActive()) {
      throw new HttpError(409, "esta tarefa não está executando");
    }
    return ok({ action });
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
