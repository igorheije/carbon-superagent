import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { answerPermission } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  requestId: z.string().min(1).max(200),
  decision: z.enum(["allow", "allow_always", "allow_task", "deny"]),
});

/** Answer a pending Claude Code permission prompt for the running task. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const { requestId, decision } = await parseBody(request, decisionSchema);
    const result = answerPermission(id, requestId, decision, user.name);
    if (!result.ok) throw new HttpError(409, result.error ?? "não foi possível responder");
    return ok({ decision });
  });
}
