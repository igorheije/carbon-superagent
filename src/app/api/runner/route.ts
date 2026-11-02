import { z } from "zod";
import { handle, ok, parseBody, requireUser } from "@/server/http";
import { runnerStatus, setEnabled } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handle(async () => {
    await requireUser();
    const { action } = await parseBody(request, z.object({ action: z.enum(["pause", "resume", "toggle"]) }));
    const next = action === "toggle" ? !runnerStatus().enabled : action === "resume";
    setEnabled(next);
    return ok(runnerStatus());
  });
}
