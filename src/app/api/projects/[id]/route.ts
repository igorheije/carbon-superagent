import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { deleteProject, findProject, listProjects, projectTaskCounts, updateProject } from "@/server/repo/projects";
import { notifyChange } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), baseBranch: z.string().trim().max(200).optional() });

export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    const project = updateProject(id, await parseBody(request, patchSchema));
    if (!project) throw new HttpError(404, "projeto não encontrado");
    notifyChange();
    return ok({ project });
  });
}

/** Removes the project, its tasks, lessons and index. The repository on disk is untouched. */
export function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!findProject(id)) throw new HttpError(404, "projeto não encontrado");
    if (projectTaskCounts(id).live > 0) throw new HttpError(409, "há tarefas na fila ou rodando neste projeto; conclua ou remova-as antes");
    if (listProjects().length <= 1) throw new HttpError(400, "precisa existir ao menos um projeto");
    deleteProject(id);
    notifyChange();
    return ok({ deleted: true });
  });
}
