import { z } from "zod";
import { claudeShareStatus, startClaudeShare, stopClaudeShare } from "@/server/claude-share";
import { handle, ok, parseBody, requireAdmin } from "@/server/http";
import { getSettings, saveSettings } from "@/server/repo/settings";

export const dynamic = "force-dynamic";

const toggleSchema = z.object({ enabled: z.boolean() });

/** EXPERIMENTAL — whether workers may use this Mac's Claude Code login (admin only). */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    return ok({ enabled: getSettings().shareClaudeLogin, status: claudeShareStatus() });
  });
}

/** Turns sharing on/off and remembers the choice; turning on reads the Keychain (macOS may ask). */
export function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const { enabled } = await parseBody(request, toggleSchema);
    const status = enabled ? await startClaudeShare() : await stopClaudeShare();
    saveSettings({ shareClaudeLogin: enabled && status.state === "on" });
    return ok({ enabled: getSettings().shareClaudeLogin, status });
  });
}
