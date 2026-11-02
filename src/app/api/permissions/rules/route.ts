import { handle, ok, requireActiveProject } from "@/server/http";
import { listRules } from "@/server/permissions/rules";

export const dynamic = "force-dynamic";

/** "Always allow" rules for the active project's repository. */
export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    return ok({ project: project.name, rules: listRules(project.repoPath) });
  });
}
