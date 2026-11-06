import { z } from "zod";
import { disableJoinToken, joinTokenInfo, MAX_JOIN_TTL_HOURS, MAX_JOIN_USES, rotateJoinToken } from "@/server/auth/join-tokens";
import { handle, ok, parseBody, requireAdmin } from "@/server/http";
import { getSettings, saveSettings } from "@/server/repo/settings";
import { directJoinInfo } from "@/server/direct-join";
import { directJoinCommands, joinCommands } from "@/server/setup-kit/join-command";
import { DEFAULT_WORKER_IMAGE } from "../_lib/kit";

export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;

const rotateSchema = z.object({
  /** Hours until the token stops working; omitted/null = no expiry (Docker Swarm default). */
  ttlHours: z.number().int().min(1).max(MAX_JOIN_TTL_HOURS).nullable().optional(),
  /** How many servers may join with it; omitted/null = unlimited. */
  maxUses: z.number().int().min(1).max(MAX_JOIN_USES).nullable().optional(),
});

/** Status of cluster joining (never the token itself) and whether new nodes need approval. */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    const settings = getSettings();
    return ok({ token: joinTokenInfo(), panelUrl: settings.panelPublicUrl, requireApproval: settings.workers.requireJoinApproval === true });
  });
}

/** Generates (or rotates) the join token: the previous one stops working; nodes already in keep running. */
export function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const input = await parseBody(request, rotateSchema);
    const { token, info } = rotateJoinToken(admin.id, {
      ttlMs: input.ttlHours ? input.ttlHours * HOUR_MS : null,
      maxUses: input.maxUses ?? null,
    });
    const panelUrl = getSettings().panelPublicUrl;
    // Listener reachable by IP with its own certificate (carbon start + CARBON_WORKER_LISTEN=0.0.0.0:…).
    const listener = directJoinInfo();
    const direct = listener.available
      ? directJoinCommands({ addresses: listener.addresses, port: listener.port, fingerprint: listener.fingerprint, token, image: DEFAULT_WORKER_IMAGE })
      : null;
    // No public URL yet: the first address of this computer becomes the main command.
    const commands = !panelUrl && direct?.lan[0] ? direct.lan[0] : joinCommands({ panelUrl, token, image: DEFAULT_WORKER_IMAGE, fingerprint: pinFor(panelUrl, listener) });
    const response = ok({ token, info, panelUrl, commands, direct }, 201);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}

/**
 * The public URL may point straight at the self-signed listener (`https://<ip>:<porta>`): then the
 * workers must pin it. A tunnel/proxy with a CA certificate (hostname) needs no pin.
 */
function pinFor(panelUrl: string, listener: ReturnType<typeof directJoinInfo>): string | null {
  if (!panelUrl || !listener.available || !listener.fingerprint) return null;
  try {
    const url = new URL(panelUrl);
    const isIpLiteral = /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("[");
    return isIpLiteral && Number(url.port) === listener.port ? listener.fingerprint : null;
  } catch {
    return null;
  }
}

/** Turns joining off until a new token is generated. */
export function DELETE() {
  return handle(async () => {
    await requireAdmin();
    return ok({ disabled: disableJoinToken() });
  });
}

const approvalSchema = z.object({ requireApproval: z.boolean() });

/** "Exigir aprovação": servers that join from now on start as pending until an admin approves them. */
export function PATCH(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const { requireApproval } = await parseBody(request, approvalSchema);
    saveSettings({ workers: { ...getSettings().workers, requireJoinApproval: requireApproval } });
    return ok({ requireApproval });
  });
}
