import { handle, HttpError, ok, requireUser } from "@/server/http";
import { listLocalTargets } from "@/server/runner/local-delivery";
import { listTargetBranches } from "@/server/runner/pull-request";

export const dynamic = "force-dynamic";

/** Where a delivered task can go: remote branches (PR) and local branches (merge). */
export function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const [remote, local] = await Promise.all([listTargetBranches(id), listLocalTargets(id)]);
    if ("error" in remote) throw new HttpError(404, remote.error);
    if ("error" in local) throw new HttpError(409, local.error);
    return ok({ remote, local });
  });
}
