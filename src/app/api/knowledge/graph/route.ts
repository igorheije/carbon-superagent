import { handle, ok, requireActiveProject } from "@/server/http";
import { graphSample } from "@/server/knowledge/store";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    return ok(graphSample(project.id));
  });
}
