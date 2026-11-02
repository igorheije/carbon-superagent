import { handle, ok, parseBody, requireActiveProject } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { createTask, listTasks } from "@/server/repo/tasks";
import { kick, notifyChange } from "@/server/runner/runner";
import { newTaskSchema } from "@/server/schemas";
import { chooseExecutor, defaultModelFor, effortFor, plannedLabel } from "@/server/executors/choose";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    const { project } = await requireActiveProject();
    return ok({ tasks: listTasks(project.id).map((t) => t.snapshot) });
  });
}

export function POST(request: Request) {
  return handle(async () => {
    const { user, project } = await requireActiveProject();
    const input = await parseBody(request, newTaskSchema);
    const settings = getSettings();
    const executor = await chooseExecutor(input.executor);
    const model = input.model ?? defaultModelFor(executor, settings);
    const effort = effortFor(executor, settings, input.effort);
    const task = createTask({
      projectId: project.id,
      key: null,
      title: input.title,
      description: input.description,
      source: "manual",
      sourceRef: null,
      requesterId: user.id,
      requesterName: user.name,
      persona: user.persona,
      executor,
      model,
      effort,
      modelLabel: plannedLabel(executor, model, effort, input.title, input.description),
      priority: input.priority,
      repo: project.name,
    });
    notifyChange();
    kick();
    return ok({ task: task.snapshot }, 201);
  });
}
