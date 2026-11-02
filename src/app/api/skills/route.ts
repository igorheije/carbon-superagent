import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { createSkill, listSkills, skillNameTaken } from "@/server/repo/skills";
import { skillBodySchema } from "@/server/schemas";
import { skillInputSchema } from "@/server/skills/parse";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    await requireUser();
    return ok({ skills: listSkills() });
  });
}

export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const raw = await parseBody(request, skillBodySchema);
    const parsed = skillInputSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "skill inválida");
    if (skillNameTaken(parsed.data.name)) throw new HttpError(409, "já existe uma skill com esse nome");
    const skill = createSkill({ ...parsed.data, personas: raw.personas, source: "created", sourceUrl: null, enabled: true, authorId: user.id });
    return ok({ skill }, 201);
  });
}
