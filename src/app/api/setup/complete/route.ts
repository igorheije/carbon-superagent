import { NextResponse } from "next/server";
import { hashPassword } from "@/server/auth/password";
import { handle, HttpError, parseBody, sessionCookie } from "@/server/http";
import { verifyKey } from "@/server/integrations/linear";
import { saveSettings } from "@/server/repo/settings";
import { seedBuiltinSkills } from "@/server/repo/skills";
import { countUsers, createSession, createUser } from "@/server/repo/users";
import { setupSchema } from "@/server/schemas";
import path from "node:path";
import { indexRepository } from "@/server/knowledge/indexer";
import { createProject, findProjectByRepo, setActiveProject } from "@/server/repo/projects";
import { checkRepo, detectExecutors } from "@/server/system/detect";
import { resolveExecutor } from "@/server/executors/resolve";

export const dynamic = "force-dynamic";

/** First-run only: creates the admin profile and the machine settings, then signs in. */
export function POST(request: Request) {
  return handle(async () => {
    if (countUsers() > 0) throw new HttpError(409, "setup já concluído");
    const input = await parseBody(request, setupSchema);

    const chosen = resolveExecutor(input.executor, input.executor, await detectExecutors());
    if (!chosen.ok) throw new HttpError(400, chosen.error);
    const repo = checkRepo(input.repoPath);
    if (repo.status !== "ok") throw new HttpError(400, repo.detail);
    if (input.linearApiKey) {
      try {
        await verifyKey(input.linearApiKey);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "API key do Linear inválida");
      }
    }

    saveSettings({ repoPath: repo.detail, defaultExecutor: input.executor, linearApiKey: input.linearApiKey ?? "", autoPush: input.autoPush, aiProjectSummary: input.aiSummary });
    seedBuiltinSkills();
    const user = createUser({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      persona: input.persona,
      role: "admin",
      mustChangePassword: false,
    });
    // First thing after setup: map the project so the first task does not start from zero.
    const project = findProjectByRepo(repo.detail) ?? createProject({ name: path.basename(repo.detail), repoPath: repo.detail, baseBranch: "" });
    setActiveProject(user.id, project.id);
    void indexRepository({ id: project.id, repoPath: project.repoPath }, { withSummary: input.aiSummary, executor: input.executor });
    const session = createSession(user.id);
    const response = NextResponse.json({ success: true, data: { user }, error: null });
    response.cookies.set(sessionCookie(session.token, session.expiresAt));
    return response;
  });
}
