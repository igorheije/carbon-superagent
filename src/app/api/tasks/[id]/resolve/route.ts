import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { conflictsWith } from "@/server/runner/local-delivery";
import { BRANCH_RE } from "@/server/runner/pull-request";
import { requestConflictResolution } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  target: z.string().trim().regex(BRANCH_RE, "nome de branch inválido"),
  /** Merge into the target automatically once the agent resolved the conflicts. */
  thenMerge: z.boolean().default(true),
});

/**
 * "Resolver conflito com o agente": the task runs again on this computer, on its own branch, to
 * bring `target` in and resolve the conflicts; the conflicting files are computed here, never
 * taken from the client.
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const { target, thenMerge } = await parseBody(request, bodySchema);
    const conflicts = await conflictsWith(id, target);
    if ("error" in conflicts) throw new HttpError(409, conflicts.error);
    const result = requestConflictResolution(id, { target, files: conflicts.files, thenMerge, requestedBy: user.name });
    if (!result.ok) throw new HttpError(409, result.error);
    return ok({ queued: true, conflicts: conflicts.files });
  });
}
