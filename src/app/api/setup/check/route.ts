import { z } from "zod";
import { currentUser, handle, HttpError, ok, parseBody } from "@/server/http";
import { countUsers } from "@/server/repo/users";
import { runChecks } from "@/server/system/detect";

export const dynamic = "force-dynamic";

/** Open during first-run setup; afterwards only for signed-in users. */
export function POST(request: Request) {
  return handle(async () => {
    if (countUsers() > 0 && !(await currentUser())) throw new HttpError(401, "não autenticado");
    const { repoPath } = await parseBody(request, z.object({ repoPath: z.string().trim().max(1024).default("") }));
    return ok({ checks: await runChecks(repoPath) });
  });
}
