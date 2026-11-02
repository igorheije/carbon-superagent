import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireActiveProject } from "@/server/http";
import { run } from "@/server/proc";
import { getSettings } from "@/server/repo/settings";
import { createTask, listTasks } from "@/server/repo/tasks";
import { kick, notifyChange } from "@/server/runner/runner";
import { chooseExecutor, defaultModelFor, effortFor, plannedLabel } from "@/server/executors/choose";

export const dynamic = "force-dynamic";

const issueSchema = z.object({ number: z.number(), title: z.string(), body: z.string().nullable().optional(), url: z.string() });

/** Uses the operator's own `gh` login against the configured clone's origin. */
async function ghIssues(repoPath: string, limit: number) {
  const result = await run("gh", ["issue", "list", "--state", "open", "--limit", String(limit), "--json", "number,title,body,url"], {
    cwd: repoPath,
    timeoutMs: 20_000,
  });
  if (!result.ok) throw new HttpError(502, `gh: ${result.stderr.split("\n")[0] || "falhou"} (rode gh auth login)`);
  return z.array(issueSchema).parse(JSON.parse(result.stdout));
}

export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    const imported = new Set(listTasks(project.id, 500).filter((t) => t.source === "github").map((t) => t.sourceRef));
    const issues = await ghIssues(project.repoPath, 30);
    return ok({ issues: issues.map((i) => ({ id: String(i.number), key: `#${i.number}`, title: i.title, url: i.url, imported: imported.has(String(i.number)) })) });
  });
}

export function POST(request: Request) {
  return handle(async () => {
    const { user, project } = await requireActiveProject();
    const { ids } = await parseBody(request, z.object({ ids: z.array(z.string().regex(/^\d+$/)).min(1).max(20) }));
    const settings = getSettings();
    const executor = await chooseExecutor();
    const wanted = new Set(ids);
    const issues = (await ghIssues(project.repoPath, 100)).filter((i) => wanted.has(String(i.number)));
    const created = issues.map(
      (issue) =>
        createTask({
          projectId: project.id,
          key: `#${issue.number}`,
          title: issue.title,
          description: `${issue.body ?? ""}\n\nGitHub: ${issue.url}`,
          source: "github",
          sourceRef: String(issue.number),
          requesterId: user.id,
          requesterName: user.name,
          persona: user.persona,
          executor,
          model: defaultModelFor(executor, settings),
          effort: effortFor(executor, settings),
          modelLabel: plannedLabel(executor, defaultModelFor(executor, settings), effortFor(executor, settings), issue.title, issue.body ?? ""),
          priority: "medium",
          repo: project.name,
        }).snapshot,
    );
    notifyChange();
    kick();
    return ok({ tasks: created }, 201);
  });
}
