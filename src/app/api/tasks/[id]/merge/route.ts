import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { mergeIntoBranch } from "@/server/runner/local-delivery";
import { BRANCH_RE } from "@/server/runner/pull-request";
import { notifyChange } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ target: z.string().trim().regex(BRANCH_RE, "nome de branch inválido") });

/** Merges the task branch into a local branch (no remote needed). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const { target } = await parseBody(request, bodySchema);
    const result = await mergeIntoBranch(id, target, user.name);
    if (!result.ok) throw new HttpError(409, result.error);
    notifyChange();
    return ok({ detail: result.detail });
  });
}
