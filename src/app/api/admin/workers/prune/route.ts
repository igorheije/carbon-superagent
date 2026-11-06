import { revokeWorker } from "@/server/auth/worker-auth";
import { handle, ok, requireAdmin } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { listFleet } from "../_lib/fleet";

export const dynamic = "force-dynamic";

/**
 * "Remover nós offline": revokes every node that entered with the join token and is offline with no
 * task. Recreated containers come back as new nodes; this clears the ones they left behind.
 */
export function POST() {
  return handle(async () => {
    await requireAdmin();
    const stale = listFleet(getSettings().workers.leaseMs).filter((w) => w.joinedVia === "join" && w.status === "offline" && w.currentTasks.length === 0);
    const removed = stale.filter((w) => revokeWorker(w.id)).map((w) => w.id);
    return ok({ removed });
  });
}
