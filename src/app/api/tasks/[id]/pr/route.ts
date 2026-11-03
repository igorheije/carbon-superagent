import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { BRANCH_RE, openPullRequest } from "@/server/runner/pull-request";
import { notifyChange } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  base: z.string().trim().regex(BRANCH_RE, "nome de branch inválido"),
  draft: z.boolean().default(true),
});

/** Opens the PR for a delivered task against the chosen target branch. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const { base, draft } = await parseBody(request, bodySchema);
    const result = await openPullRequest(id, base, draft, user.name);
    if (!result.ok) throw new HttpError(409, result.error);
    notifyChange();
    return ok({ url: result.url });
  });
}
