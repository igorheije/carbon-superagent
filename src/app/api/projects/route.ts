import path from "node:path";
import { z } from "zod";
import { resolveExecutor } from "@/server/executors/resolve";
import { handle, HttpError, ok, parseBody, requireAdmin, requireUser } from "@/server/http";
import { indexRepository, indexStatus } from "@/server/knowledge/indexer";
import { getOverview } from "@/server/knowledge/store";
import { activeProjectFor, createProject, findProjectByRepo, listProjects, projectTaskCounts, setActiveProject } from "@/server/repo/projects";
import { getSettings } from "@/server/repo/settings";
import { checkRepo, detectExecutors } from "@/server/system/detect";

export const dynamic = "force-dynamic";

const newProjectSchema = z.object({
  repoPath: z.string().trim().min(1, "informe o caminho do repositório").max(1024),
  name: z.string().trim().max(80).optional(),
  baseBranch: z.string().trim().max(200).default(""),
});

export function GET() {
  return handle(async () => {
    const user = await requireUser();
    const active = activeProjectFor(user.id);
    const projects = listProjects().map((p) => {
      const overview = getOverview(p.id);
      return {
        ...p,
        tasks: projectTaskCounts(p.id),
        index: { phase: indexStatus(p.id).phase, fileCount: overview?.fileCount ?? null, indexedAt: overview?.indexedAt ?? null },
      };
    });
    return ok({ projects, activeId: active?.id ?? null });
  });
}

/** Admin adds a repository as a project, switches to it and starts mapping it. */
export function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const input = await parseBody(request, newProjectSchema);
    const repo = checkRepo(input.repoPath);
    if (repo.status !== "ok") throw new HttpError(400, repo.detail);
    if (findProjectByRepo(repo.detail)) throw new HttpError(409, "esse repositório já é um projeto");
    const project = createProject({ name: input.name || path.basename(repo.detail), repoPath: repo.detail, baseBranch: input.baseBranch });
    setActiveProject(admin.id, project.id);
    const settings = getSettings();
    const chosen = resolveExecutor(undefined, settings.defaultExecutor, await detectExecutors());
    void indexRepository({ id: project.id, repoPath: project.repoPath }, { withSummary: settings.aiProjectSummary && chosen.ok, executor: chosen.ok ? chosen.executor : null });
    return ok({ project }, 201);
  });
}
