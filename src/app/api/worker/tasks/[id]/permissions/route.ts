import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { notifyLive } from "@/server/runner/live";
import { pollRemoteDecisions } from "@/server/runner/remote-permissions";
import { LEASE_LOST, type PermissionsResponse } from "@/shared/worker-protocol";

export const dynamic = "force-dynamic";

const WAIT_MS = 25_000;
const CHECK_MS = 1_000;

/** Test hook: CARBON_WORKER_PERMISSION_WAIT_MS shortens the long-poll. */
function waitMs(): number {
  const override = Number(process.env.CARBON_WORKER_PERMISSION_WAIT_MS);
  return Number.isFinite(override) && override >= 0 ? Math.min(override, WAIT_MS) : WAIT_MS;
}

function parseAfter(request: Request): number {
  const raw = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,9}$/.test(raw)) throw new HttpError(400, "after: inteiro >= 0");
  return Number(raw);
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Long-poll (≤ 25 s) of the answers to permission prompts this worker forwarded (RMT-01): the
 * decisions with seq > after, or an empty list when none arrived in time. Prompts past the panel's
 * permission timeout are denied here. Lease owner only (worker token or the bound AgentCore token).
 */
export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    const after = parseAfter(request);
    const deadline = Date.now() + waitMs();
    for (;;) {
      const result = pollRemoteDecisions(id, worker.id, after, getSettings().permissionTimeoutMinutes);
      if (result === "lease_lost") throw new HttpError(409, LEASE_LOST);
      if (result.changed) notifyLive();
      const left = deadline - Date.now();
      if (result.decisions.length > 0 || left <= 0 || request.signal.aborted) {
        return ok({ decisions: [...result.decisions] } satisfies PermissionsResponse);
      }
      await pause(Math.min(CHECK_MS, left), request.signal);
    }
  });
}
