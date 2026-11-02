import { z } from "zod";
import { chooseExecutor } from "@/server/executors/choose";
import { HttpError, currentUser, fail } from "@/server/http";
import { activeProjectFor } from "@/server/repo/projects";
import { buildKnowledgeContext } from "@/server/knowledge/context";
import { buildDraftPrompt } from "@/server/draft/prompt";
import { runDraft } from "@/server/draft/run";
import { cleanDraft, type DraftEvent } from "@/server/draft/stream";
import { promotedLessons } from "@/server/repo/tasks";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  title: z.string().trim().min(3, "escreva o que fazer primeiro").max(200),
  notes: z.string().max(12_000).default(""),
  executor: z.enum(["claude", "codex"]).optional(),
});

/**
 * "Gerar com IA" for the task description. Streams NDJSON DraftEvents so the textarea fills
 * in as the model writes. Grounded in the project index and the team's promoted lessons.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return fail("não autenticado", 401);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "pedido inválido", 400);
  const project = activeProjectFor(user.id);
  if (!project) return fail("crie um projeto primeiro", 400);

  let executor: "claude" | "codex";
  try {
    executor = await chooseExecutor(parsed.data.executor);
  } catch (error) {
    return fail(error instanceof HttpError ? error.message : "nenhum agente disponível", 400);
  }

  const { title, notes } = parsed.data;
  const knowledge = buildKnowledgeContext(project.id, title, notes);
  const prompt = buildDraftPrompt({
    title,
    notes,
    persona: user.persona,
    lessons: promotedLessons(project.id).map((l) => ({ rule: l.rule, scope: l.scope })),
    knowledge: knowledge?.prompt ?? null,
  });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: DraftEvent) => {
        if (abort.signal.aborted) return;
        const payload = event.type === "final" ? { ...event, text: cleanDraft(event.text) } : event;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          abort.abort();
        }
      };
      send({ type: "status", text: knowledge ? `${project.name}: ${knowledge.relevant.length} arquivos e ${promotedLessons(project.id).length} lições como contexto` : "projeto sem índice: usando só a descrição" });
      await runDraft(executor, prompt, project.repoPath, abort.signal, send);
      try {
        controller.close();
      } catch {
        // client went away
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
}
