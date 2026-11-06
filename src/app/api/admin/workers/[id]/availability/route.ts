import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { findWorker, setAvailability } from "@/server/repo/workers";

export const dynamic = "force-dynamic";

/** active = resume or approve; paused = drain (finishes running tasks, takes no new ones). */
const availabilitySchema = z.object({ availability: z.enum(["active", "paused"]) });

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    const { availability } = await parseBody(request, availabilitySchema);
    const worker = findWorker(id);
    if (!worker || worker.revokedAt !== null) throw new HttpError(404, "máquina não encontrada ou já removida");
    if (worker.kind !== "pool") throw new HttpError(400, "só máquinas do pool podem ser pausadas");
    setAvailability(id, availability);
    return ok({ id, availability });
  });
}
