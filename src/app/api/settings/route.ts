import { handle, HttpError, ok, parseBody, requireAdmin, requireUser } from "@/server/http";
import { verifyKey } from "@/server/integrations/linear";
import { getSettings, saveSettings, settingsSchema, toPublicSettings } from "@/server/repo/settings";
import { notifyChange } from "@/server/runner/runner";
import { detectExecutors } from "@/server/system/detect";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    await requireUser();
    return ok({ settings: toPublicSettings(getSettings()) });
  });
}

/** Admin-only. Empty linearApiKey keeps the current key; "-" removes it. */
export function PUT(request: Request) {
  return handle(async () => {
    await requireAdmin();
    // Repository and base branch now live on each project (/api/projects).
    const patch = await parseBody(request, settingsSchema.partial());
    delete patch.repoPath;
    delete patch.baseBranch;
    if (patch.defaultExecutor && !(await detectExecutors())[patch.defaultExecutor]) {
      throw new HttpError(400, `${patch.defaultExecutor === "claude" ? "Claude Code" : "Codex"} não está instalado nesta máquina`);
    }
    if (patch.linearApiKey === "") delete patch.linearApiKey;
    else if (patch.linearApiKey === "-") patch.linearApiKey = "";
    else if (patch.linearApiKey) {
      try {
        await verifyKey(patch.linearApiKey);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "API key inválida");
      }
    }
    const saved = saveSettings(patch);
    notifyChange();
    return ok({ settings: toPublicSettings(saved) });
  });
}
