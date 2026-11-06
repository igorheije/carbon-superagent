import { revokeWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok, requireAdmin } from "@/server/http";

export const dynamic = "force-dynamic";

/** Revokes a worker token: its next request gets 401 and it stops receiving tasks. */
export function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!revokeWorker(id)) throw new HttpError(404, "máquina não encontrada ou já revogada");
    return ok({ revoked: true });
  });
}
