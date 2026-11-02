import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireActiveProject } from "@/server/http";
import { getIssue, listMyIssues, mapPriority } from "@/server/integrations/linear";
import { getSettings } from "@/server/repo/settings";
import { createTask, listTasks } from "@/server/repo/tasks";
import { kick, notifyChange } from "@/server/runner/runner";
import { chooseExecutor, defaultModelFor, effortFor, plannedLabel } from "@/server/executors/choose";

export const dynamic = "force-dynamic";

function apiKey(): string {
  const key = getSettings().linearApiKey;
  if (!key) throw new HttpError(400, "configure a API key do Linear em Configurações");
  return key;
}

export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    const imported = new Set(listTasks(project.id, 500).filter((t) => t.source === "linear").map((t) => t.sourceRef));
    const issues = await listMyIssues(apiKey()).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Linear indisponível");
    });
    return ok({ issues: issues.map((i) => ({ id: i.id, key: i.identifier, title: i.title, url: i.url, imported: imported.has(i.id) })) });
  });
}

export function POST(request: Request) {
  return handle(async () => {
    const { user, project } = await requireActiveProject();
    const { ids } = await parseBody(request, z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(20) }));
    const settings = getSettings();
    const executor = await chooseExecutor();
    const key = apiKey();
    const created = [];
    for (const id of ids) {
      const issue = await getIssue(key, id);
      created.push(
        createTask({
          projectId: project.id,
          key: issue.identifier,
          title: issue.title,
          description: `${issue.description ?? ""}\n\nLinear: ${issue.url}`,
          source: "linear",
          sourceRef: issue.id,
          requesterId: user.id,
          requesterName: user.name,
          persona: user.persona,
          executor,
          model: defaultModelFor(executor, settings),
          effort: effortFor(executor, settings),
          modelLabel: plannedLabel(executor, defaultModelFor(executor, settings), effortFor(executor, settings), issue.title, issue.description ?? ""),
          priority: mapPriority(issue.priority),
          repo: project.name,
        }).snapshot,
      );
    }
    notifyChange();
    kick();
    return ok({ tasks: created }, 201);
  });
}
