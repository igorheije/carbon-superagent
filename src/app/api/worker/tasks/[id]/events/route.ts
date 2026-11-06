import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { ingestRemoteEvents } from "@/server/runner/live";
import { eventsRequestSchema, LEASE_LOST, type EventsResponse } from "@/shared/worker-protocol";
import { readWorkerJson } from "../../../_lib/body";

export const dynamic = "force-dynamic";

/** A batch of executor events from the lease owner. Idempotent by seq. 413 past the snapshot caps (M6). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    const body = await readWorkerJson(request, eventsRequestSchema);
    const result = ingestRemoteEvents(id, worker.id, body.seq, body.events);
    if (result === "lease_lost") throw new HttpError(409, LEASE_LOST);
    if ("tooLarge" in result) throw new HttpError(413, result.tooLarge);
    return ok({ acceptedSeq: result.acceptedSeq } satisfies EventsResponse);
  });
}
