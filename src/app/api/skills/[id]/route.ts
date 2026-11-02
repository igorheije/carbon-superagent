import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { deleteSkill, findSkill, updateSkill, type Skill } from "@/server/repo/skills";
import type { User } from "@/server/repo/users";
import { skillPatchSchema } from "@/server/schemas";
import { skillInputSchema } from "@/server/skills/parse";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function load(params: Params["params"]): Promise<{ user: User; skill: Skill }> {
  const user = await requireUser();
  const skill = findSkill((await params).id);
  if (!skill) throw new HttpError(404, "skill não encontrada");
  const canEdit = user.role === "admin" || (skill.source !== "builtin" && skill.authorId === user.id);
  if (!canEdit) throw new HttpError(403, "só o autor ou um admin pode alterar esta skill");
  return { user, skill };
}

export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { skill } = await load(params);
    const patch = await parseBody(request, skillPatchSchema);
    if (skill.source === "builtin" && (patch.body !== undefined || patch.description !== undefined)) {
      throw new HttpError(400, "skills nativas só podem ser ligadas/desligadas");
    }
    const check = skillInputSchema.safeParse({ name: skill.name, description: patch.description ?? skill.description, body: patch.body ?? skill.body });
    if (!check.success) throw new HttpError(400, check.error.issues[0]?.message ?? "skill inválida");
    return ok({ skill: updateSkill(skill.id, { ...patch, description: check.data.description, body: check.data.body }) });
  });
}

export function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { skill } = await load(params);
    if (skill.source === "builtin") throw new HttpError(400, "skills nativas não podem ser removidas; desligue-as");
    deleteSkill(skill.id);
    return ok({ deleted: true });
  });
}
