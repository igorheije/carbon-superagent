import { handle, ok, requireUser } from "@/server/http";
import { activeProjectFor } from "@/server/repo/projects";
import { runChecks } from "@/server/system/detect";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    const user = await requireUser();
    return ok({ checks: await runChecks(activeProjectFor(user.id)?.repoPath ?? "") });
  });
}
