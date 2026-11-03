import { z } from "zod";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { jiraAuth } from "@/server/integrations/hub";
import { verifyJira } from "@/server/integrations/jira";
import { postSlack, verifySlack } from "@/server/integrations/slack";
import { sendTelegram, verifyTelegram } from "@/server/integrations/telegram";
import { getSettings, isJiraConfigured, isSlackConfigured, isTelegramConfigured } from "@/server/repo/settings";

export const dynamic = "force-dynamic";

const TEST_TEXT = "✅ Carbon conectado. Mencione o bot com uma tarefa para colocá-la na fila.";

/** Admin-only: checks the credentials and, for chats, sends a test message to the configured destination. */
export function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const { target } = await parseBody(request, z.object({ target: z.enum(["jira", "slack", "telegram"]) }));
    const s = getSettings();
    try {
      if (target === "jira") {
        if (!isJiraConfigured(s)) throw new Error("preencha site, e-mail e API token");
        return ok({ detail: `conectado como ${await verifyJira(jiraAuth(s))}` });
      }
      if (target === "slack") {
        if (!isSlackConfigured(s)) throw new Error("preencha bot token e signing secret");
        const who = await verifySlack(s.slackBotToken);
        if (s.slackChannelId) await postSlack(s.slackBotToken, { channel: s.slackChannelId, text: TEST_TEXT });
        return ok({ detail: `${who}${s.slackChannelId ? " · mensagem de teste enviada" : " · defina o canal para receber avisos"}` });
      }
      if (!isTelegramConfigured(s)) throw new Error("preencha bot token e chat id");
      const bot = await verifyTelegram(s.telegramBotToken);
      await sendTelegram(s.telegramBotToken, { chatId: s.telegramChatId, text: TEST_TEXT.replace("Mencione o bot", `Envie /carbon <tarefa> ou @${bot}`) });
      return ok({ detail: `@${bot} · mensagem de teste enviada` });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "falha no teste");
    }
  });
}
