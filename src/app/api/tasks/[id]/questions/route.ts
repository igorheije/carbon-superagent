import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { answerTaskQuestion } from "@/server/runner/runner";
import { MAX_ANSWER } from "@/server/runner/questions";

export const dynamic = "force-dynamic";

const answerSchema = z.object({
  questionId: z.string().min(1).max(200),
  answer: z.string().trim().min(1).max(MAX_ANSWER),
});

/** Answer a question the agent asked (CARBON_QUESTION). The task resumes once nothing is pending. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const { questionId, answer } = await parseBody(request, answerSchema);
    const result = answerTaskQuestion(id, questionId, answer, user.name);
    if (!result.ok) throw new HttpError(409, result.error ?? "não foi possível responder");
    return ok({ answered: true });
  });
}
