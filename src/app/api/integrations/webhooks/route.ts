import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { newWebhookSecret } from "@/server/integrations/security";
import { setTelegramWebhook } from "@/server/integrations/telegram";
import { getSettings, saveSettings, toPublicSettings } from "@/server/repo/settings";

export const dynamic = "force-dynamic";

/**
 * Admin-only webhook setup.
 * - jira: creates (or rotates) the shared secret and returns the full URL once, to paste in Jira.
 * - telegram: creates the secret and registers the webhook with Telegram (needs the public URL).
 */
export function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const { target } = await parseBody(request, z.object({ target: z.enum(["jira", "telegram"]) }));
    const s = getSettings();
    if (!s.publicBaseUrl) throw new HttpError(400, "defina antes a URL pública do túnel");
    if (target === "jira") {
      const secret = newWebhookSecret();
      const saved = saveSettings({ jiraWebhookSecret: secret });
      return ok({ url: `${s.publicBaseUrl}/api/webhooks/jira?secret=${secret}`, settings: toPublicSettings(saved) });
    }
    if (!s.telegramBotToken) throw new HttpError(400, "defina antes o token do bot do Telegram");
    const secret = s.telegramWebhookSecret || newWebhookSecret();
    const url = `${s.publicBaseUrl}/api/webhooks/telegram`;
    try {
      await setTelegramWebhook(s.telegramBotToken, url, secret);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Telegram recusou o webhook");
    }
    const saved = saveSettings({ telegramWebhookSecret: secret });
    return ok({ url, settings: toPublicSettings(saved) });
  });
}
