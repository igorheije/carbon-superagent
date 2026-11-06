import { requireWorker, revokeWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/** `carbon leave`: the node revokes its own credential. Tasks it still holds follow the lease-lost rule. */
export function POST(request: Request) {
  return handle(async () => {
    const worker = requireWorker(request);
    if (worker.kind !== "pool") throw new HttpError(403, "só nós do cluster podem sair");
    revokeWorker(worker.id);
    return ok({ left: true });
  });
}
