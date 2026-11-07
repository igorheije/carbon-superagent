import { createWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { listFleet } from "./_lib/fleet";
import { directJoinInfo } from "@/server/direct-join";
import { kitOptionsOf, kitProblems, newMachineSchema, panelEndpointOf, renderWorkerKit } from "./_lib/kit";

export const dynamic = "force-dynamic";

/** Configurações → Máquinas: fleet with computed status (FLT-01), plus how new machines can connect. */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    const settings = getSettings();
    return ok({ workers: listFleet(settings.workers.leaseMs), connection: { panelPublicUrl: settings.panelPublicUrl, direct: directJoinInfo() } });
  });
}

/**
 * Creates a pool worker and returns its setup kit. The token goes out exactly once, in this
 * response (and inside the kit's `.env`/`secret.yaml`); only its sha256 is stored. Never logged.
 */
export function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const input = await parseBody(request, newMachineSchema);
    const endpoint = panelEndpointOf(input, getSettings().panelPublicUrl, directJoinInfo());
    if (typeof endpoint === "string") throw new HttpError(400, endpoint);
    const problems = kitProblems(input, endpoint);
    if (problems.length > 0) throw new HttpError(400, problems.join("; "));

    const { worker, token } = createWorker(input.name, "pool", admin.id);
    const kit = renderWorkerKit(input.target, kitOptionsOf(input, endpoint, token));
    const response = ok({ worker, token, kitBase64: kit.archive.toString("base64"), filename: kit.filename, folder: kit.folder }, 201);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}
