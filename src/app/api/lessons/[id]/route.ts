import { z } from "zod";
import { handle, ok, parseBody, requireUser } from "@/server/http";
import { setLessonStatus } from "@/server/repo/tasks";
import { notifyChange } from "@/server/runner/runner";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const { status } = await parseBody(request, z.object({ status: z.enum(["promoted", "discarded"]) }));
    setLessonStatus((await params).id, status);
    notifyChange();
    return ok({ status });
  });
}
