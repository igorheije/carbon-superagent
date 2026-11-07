import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { setCapabilities, setTelemetry, touchLastSeen } from "@/server/repo/workers";
import { helloRequestSchema, PROTOCOL_VERSION, type HelloResponse } from "@/shared/worker-protocol";
import { readWorkerJson } from "../_lib/body";

export const dynamic = "force-dynamic";

/** Handshake: checks the protocol version and returns the lease/poll timings. */
export function POST(request: Request) {
  return handle(async () => {
    const worker = requireWorker(request);
    const body = await readWorkerJson(request, helloRequestSchema);
    if (body.version < PROTOCOL_VERSION) {
      throw new HttpError(426, `protocolo ${body.version} desatualizado; o painel exige ${PROTOCOL_VERSION}. Atualize o worker`);
    }
    touchLastSeen(worker.id, Date.now(), body.workerVersion);
    setCapabilities(worker.id, { executors: body.executors, git: body.git, maxParallel: body.maxParallel });
    if (body.host) setTelemetry(worker.id, body.host);
    const { leaseMs, pollMs } = getSettings().workers;
    return ok({ protocol: PROTOCOL_VERSION, leaseMs, pollMs, availability: worker.availability } satisfies HelloResponse);
  });
}
