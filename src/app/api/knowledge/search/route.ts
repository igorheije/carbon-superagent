import { handle, ok, requireActiveProject } from "@/server/http";
import { searchFiles } from "@/server/knowledge/store";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(async () => {
    const { project } = await requireActiveProject();
    const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 500);
    return ok({ results: searchFiles(project.id, q, 10) });
  });
}
