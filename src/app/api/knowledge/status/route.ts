import { handle, ok, requireActiveProject } from "@/server/http";
import { indexStatus } from "@/server/knowledge/indexer";
import { getOverview } from "@/server/knowledge/store";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    return ok({ project: { id: project.id, name: project.name }, status: indexStatus(project.id), overview: getOverview(project.id) });
  });
}
