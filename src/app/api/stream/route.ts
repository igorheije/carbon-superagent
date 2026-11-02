import { currentUser } from "@/server/http";
import { kick, runnerEvents } from "@/server/runner/runner";
import { liveSnapshot } from "@/server/runner/snapshot";
import { activeProjectFor } from "@/server/repo/projects";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const THROTTLE_MS = 250;

/** Server-Sent Events: a full snapshot on connect and after every (throttled) change. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("não autenticado", { status: 401 });
  // The stream is bound to the project active when it opened; switching reconnects.
  const projectId = activeProjectFor(user.id)?.id ?? null;
  kick();
  const encoder = new TextEncoder();
  const events = runnerEvents();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      const send = () => {
        pending = null;
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(liveSnapshot(projectId))}\n\n`));
        } catch {
          cleanup();
        }
      };
      const onChange = () => {
        if (!pending) pending = setTimeout(send, THROTTLE_MS);
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, HEARTBEAT_MS);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        events.off("change", onChange);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      events.on("change", onChange);
      request.signal.addEventListener("abort", cleanup);
      send();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
