import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { findProject, setActiveProject } from "@/server/repo/projects";

export const dynamic = "force-dynamic";

/** Switches the signed-in user's project (each person has their own). */
export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(100) }));
    const project = findProject(id);
    if (!project) throw new HttpError(404, "projeto não encontrado");
    setActiveProject(user.id, project.id);
    return ok({ project });
  });
}
