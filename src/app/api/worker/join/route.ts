import { consumeJoinToken, JOIN_TOKEN_PREFIX } from "@/server/auth/join-tokens";
import { bearerToken, createWorker, guardWorkerIp, rejectWorkerAuth } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { setCapabilities, touchLastSeen } from "@/server/repo/workers";
import { joinRequestSchema, PROTOCOL_VERSION, type JoinResponse } from "@/shared/worker-protocol";
import { readWorkerJson } from "../_lib/body";

export const dynamic = "force-dynamic";

/**
 * Cluster join (Docker Swarm-like): Bearer cjt_… → creates this server as a pool worker and returns
 * its own credential (cwk_…) once. Bad, expired, rotated or used-up tokens all get the same 401,
 * counted against the client IP (429 past the limit).
 */
export function POST(request: Request) {
  return handle(async () => {
    const now = Date.now();
    guardWorkerIp(request, now);
    const token = bearerToken(request);
    if (!token?.startsWith(JOIN_TOKEN_PREFIX)) return rejectWorkerAuth(request, now);
    const body = await readWorkerJson(request, joinRequestSchema);
    if (body.version < PROTOCOL_VERSION) {
      throw new HttpError(426, `protocolo ${body.version} desatualizado; o painel exige ${PROTOCOL_VERSION}. Atualize o worker`);
    }
    const joinToken = consumeJoinToken(token, now);
    if (!joinToken) return rejectWorkerAuth(request, now);
    const availability = getSettings().workers.requireJoinApproval === true ? "pending" : "active";
    const { worker, token: credential } = createWorker(body.name, "pool", `join:${joinToken.id}`, {
      joinedVia: "join",
      hostname: body.hostname ?? null,
      availability,
    });
    setCapabilities(worker.id, { executors: body.executors, git: body.git, maxParallel: body.maxParallel });
    touchLastSeen(worker.id, now, body.workerVersion);
    return ok({ nodeId: worker.id, token: credential, name: worker.name, availability } satisfies JoinResponse, 201);
  });
}
