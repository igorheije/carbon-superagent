import { createWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { listFleet } from "./_lib/fleet";
import { kitOptionsOf, kitProblems, MISSING_PANEL_URL, newMachineSchema, renderWorkerKit } from "./_lib/kit";

export const dynamic = "force-dynamic";

/** Configurações → Máquinas: fleet with computed status (FLT-01). */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    return ok({ workers: listFleet(getSettings().workers.leaseMs) });
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
    const panelUrl = getSettings().panelPublicUrl;
    if (!panelUrl) throw new HttpError(400, MISSING_PANEL_URL);
    const problems = kitProblems(input, panelUrl);
    if (problems.length > 0) throw new HttpError(400, problems.join("; "));

    const { worker, token } = createWorker(input.name, "pool", admin.id);
    const kit = renderWorkerKit(input.target, kitOptionsOf(input, panelUrl, token));
    const response = ok({ worker, token, kitBase64: kit.archive.toString("base64"), filename: kit.filename, folder: kit.folder }, 201);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}
