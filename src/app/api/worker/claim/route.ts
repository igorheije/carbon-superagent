import { NextResponse } from "next/server";
import { requireWorker } from "@/server/auth/worker-auth";
import { handle, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { claimRequestSchema } from "@/shared/worker-protocol";
import { readWorkerJson } from "../_lib/body";
import { CLAIM_CHECK_MS, claimWaitMs, pollClaim } from "../_lib/claim";
import { withPollSlot } from "../_lib/poll-slots";

export const dynamic = "force-dynamic";

/** Long-poll for the next pool task: ClaimedTask, or 204 when nothing showed up in time. 429 above the per-worker poll cap. */
export function POST(request: Request) {
  return handle(async () => {
    const worker = requireWorker(request);
    const body = await readWorkerJson(request, claimRequestSchema);
    const claimed = await withPollSlot(worker, "claim", () =>
      pollClaim(worker, body.executors, {
        waitMs: claimWaitMs(),
        intervalMs: CLAIM_CHECK_MS,
        leaseMs: getSettings().workers.leaseMs,
        signal: request.signal,
      }),
    );
    return claimed ? ok(claimed) : new NextResponse(null, { status: 204 });
  });
}
