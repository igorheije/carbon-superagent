import { z } from "zod";
import { resolveExecutor } from "@/server/executors/resolve";
import { handle, ok, parseBody, requireActiveProject } from "@/server/http";
import { indexRepository, indexStatus } from "@/server/knowledge/indexer";
import { getSettings } from "@/server/repo/settings";
import { detectExecutors } from "@/server/system/detect";

export const dynamic = "force-dynamic";

/** Starts a background (re)index of the active project. Poll /api/knowledge/status. */
export function POST(request: Request) {
  return handle(async () => {
    const { project } = await requireActiveProject();
    const { withSummary } = await parseBody(request, z.object({ withSummary: z.boolean().default(true) }));
    const chosen = resolveExecutor(undefined, getSettings().defaultExecutor, await detectExecutors());
    void indexRepository({ id: project.id, repoPath: project.repoPath }, { withSummary: withSummary && chosen.ok, executor: chosen.ok ? chosen.executor : null });
    return ok({ status: indexStatus(project.id) }, 202);
  });
}
