import { handle, ok, requireAdmin } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { findWorker } from "@/server/repo/workers";
import { listFleet } from "../_lib/fleet";
import { buildLoadView } from "../_lib/load";

export const dynamic = "force-dynamic";

/** Configurações → Máquinas → Carga: host snapshot and 24 h run stats per machine (admin only). */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    const fleet = listFleet(getSettings().workers.leaseMs);
    return ok(buildLoadView(fleet, (id) => findWorker(id)?.telemetry ?? null));
  });
}
