import { handle, HttpError, ok, requireUser } from "@/server/http";
import { listTargetBranches } from "@/server/runner/pull-request";

export const dynamic = "force-dynamic";

/** Branches the task's PR can target, suggestion first. */
export function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const result = await listTargetBranches(id);
    if ("error" in result) throw new HttpError(404, result.error);
    return ok(result);
  });
}
