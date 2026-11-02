import { handle, ok, requireUser } from "@/server/http";
import { getSettings, toPublicSettings } from "@/server/repo/settings";
import { detectExecutors } from "@/server/system/detect";
import { activeProjectFor, listProjects } from "@/server/repo/projects";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    const user = await requireUser();
    return ok({ user, settings: toPublicSettings(getSettings()), executors: await detectExecutors(), projects: listProjects(), activeProject: activeProjectFor(user.id) });
  });
}
