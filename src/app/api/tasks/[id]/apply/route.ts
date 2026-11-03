import { handle, HttpError, ok, requireUser } from "@/server/http";
import { applyToWorkingDir } from "@/server/runner/local-delivery";
import { notifyChange } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

/** Applies the task's changes to the project folder as uncommitted edits. */
export function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const result = await applyToWorkingDir(id, user.name);
    if (!result.ok) throw new HttpError(409, result.error);
    notifyChange();
    return ok({ detail: result.detail });
  });
}
